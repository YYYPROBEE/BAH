/**
 * 上下文压缩：阈值判定 → 结构化摘要 → 折叠投影。
 *
 * ```text
 * 判定   shouldCompact()   完整 turn 数 / token 估算 ≥ 配置阈值，且折叠后仍剩原文
 * 计划   planCompaction()  选出最老的若干完整 turn，产出要落账的摘要载荷
 * 落账   index.ts          appendCompactionSummary() → `compaction/summary` 事件
 * 投影   collapseEvents()  把已摘要的 turn 从历史里剔除，摘要另行呈现
 * ```
 *
 * 摘要**不调模型**（确定性生成、可回放、零成本）：它由结构化统计 + 金融特例字段拼成。
 * 模型生成的散文摘要会引入不确定性与额外成本，且无法被快照回放逐字校验——
 * 需要时再作为可选增强（本阶段不做，见偏离记录）。
 */

import { BahError, assertNever } from '@bah/util'

import type { ContentBlock, TicketId } from '@bah/core'
import type { ContentBlock as ModelBlock, LlmRequest } from '@bah/llm'

import type {
  AnySessionEvent,
  CompactionSummaryData,
  DerivedMessage,
  FinancialExecution,
  FinancialSummaryEntry,
  ToolResultData,
} from '../session/types.ts'
import type {
  CollapsedEvents,
  CompactionPlan,
  CompactionThresholds,
  PlanCompactionInput,
  SummaryTextInput,
  SummaryToolHighlight,
  SummaryToolStatus,
  SummaryTurnHighlight,
} from './types.ts'

/** 估算用的字符/token 比（ASCII 混排的保守值；只用于阈值判定，不参与计费）。 */
const CHARS_PER_TOKEN = 4

/** 摘要引述的单条文本上限（字符；截断保证摘要不会反向膨胀）。 */
const QUOTE_MAX_CHARS = 160
const TOOL_ARGS_MAX_CHARS = 80
const TOOL_RESULT_MAX_CHARS = 140
/** 单轮最多逐条展示的工具调用数（超出只留计数，避免一次批量查询淹没摘要）。 */
const TOOLS_PER_TURN = 8
/** 对话要点的字符预算：从最近轮次往前装，更早的轮次只保留在"共 N 轮"计数里。 */
const HIGHLIGHT_BUDGET_CHARS = 4000

/** CJK 字符按 1 token/字估算（中文 provider 的实际 tokenizer 接近 0.6–1）。 */
function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
  )
}

/** 允许的配置键（未知键 fail-loud，「misconfiguration 必须 fail-loud」）。 */
const CONFIG_KEYS = new Set(['maxTokens', 'maxTurns', 'keepRecentTurns'])

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 配置校验（阈值全部配置化）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 校验压缩配置。
 *
 * @throws `BahError('compaction-invalid-config')` 非对象 / 未知键 / 阈值不是正整数 /
 *   一个阈值都没配（永不触发压缩）
 */
export function resolveCompactionConfig(input: unknown): CompactionThresholds {
  if (typeof input !== 'object' || input === null) {
    throw new BahError('compaction-invalid-config', 'compaction: 配置必须是对象')
  }
  const record = input as Readonly<Record<string, unknown>>
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new BahError(
        'compaction-invalid-config',
        `compaction: 未知配置键 ${key}（可调项只有 maxTokens / maxTurns / keepRecentTurns）`,
        { key },
      )
    }
  }

  const keepRecentTurns = positiveInteger(record['keepRecentTurns'], 'keepRecentTurns')
  const maxTokens = optionalPositiveInteger(record['maxTokens'], 'maxTokens')
  const maxTurns = optionalPositiveInteger(record['maxTurns'], 'maxTurns')

  if (maxTokens === undefined && maxTurns === undefined) {
    throw new BahError(
      'compaction-invalid-config',
      'compaction: 至少要配置 maxTokens 或 maxTurns 之一，否则永远不会触发压缩',
    )
  }

  return {
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    keepRecentTurns,
  }
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BahError(
      'compaction-invalid-config',
      `compaction: ${name} 必须是正整数（收到 ${String(value)}）`,
      { name, value },
    )
  }
  return value
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 度量与触发判定
 * ──────────────────────────────────────────────────────────────────────────── */

/** 文本 → token 估算（向上取整；CJK 按 1 token/字，ASCII 按 4 字符/token）。 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (isCjk(char.codePointAt(0) ?? 0)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / CHARS_PER_TOKEN)
}

/** 非模型可见的平台事件：参与压缩水位时不贡献 token（显式列出，新增类型必须表态）。 */
const NON_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'request/header',
  'request/context',
  'assistant/attempt',
  'tool/call',
  'approval/asked',
  'approval/decided',
  'usage/summary',
  'compaction/summary',
])

/** 单条事件的 token 估算（只有模型可见的消息类事件算，审计事件不算）。 */
export function estimateEventTokens(event: AnySessionEvent): number {
  switch (event.type) {
    case 'system/message':
    case 'user/message':
      return estimateTokens(event.data.content)
    case 'assistant/message':
    case 'tool/result':
      return estimateTokens(textOfBlocks(event.data.content))
    default:
      // 领域事件（`ignorable`）不参与模型历史；平台事件表新增类型时必须显式归类，
      // 否则压缩水位会被静默低估（报告 Q-M3）。
      if (event.ignorable === true || NON_MESSAGE_EVENTS.has(event.type)) return 0
      throw new BahError(
        'compaction-unestimated-event',
        `compaction: 未知事件 ${event.type} 没有 token 估算口径（压缩水位会失真）`,
        { type: event.type, seq: event.seq },
      )
  }
}

/**
 * 一次**请求**的 token 估算：消息正文 + 工具 schema。
 *
 * 为什么不能只看会话事件：工具定义不在事件里（每次请求由注册表现算），
 * 只按事件估水位会漏掉 21 个工具的 name / description / JSON schema。
 * 图片与推理块不计（与 `estimateEventTokens` 同口径：图片不折算文本，推理块不回放）。
 */
export function estimateRequestTokens(request: LlmRequest): number {
  let tokens = 0
  for (const message of request.messages) {
    for (const block of message.content) {
      tokens += estimateModelBlockTokens(block)
    }
  }
  for (const tool of request.tools ?? []) {
    tokens += estimateTokens(tool.name)
    tokens += estimateTokens(tool.description)
    tokens += estimateTokens(compactJson(tool.schema))
  }
  return tokens
}

/** 模型内容块的 token 估算（文本与工具调用计，其余不计）。 */
function estimateModelBlockTokens(block: ModelBlock): number {
  switch (block.kind) {
    case 'text':
      return estimateTokens(block.text)
    case 'tool-call':
      return estimateTokens(block.name) + estimateTokens(compactJson(block.args))
    case 'reasoning':
    case 'image':
    case 'file':
    case 'tool-addition':
    case 'tool-removal':
      return 0
    default:
      return assertNever(block, 'model-content-block')
  }
}

/** 完整 turn 的数量（有 `turn/end` 才算完整：未闭合的 turn 不折叠）。 */
export function countCompleteTurns(events: readonly AnySessionEvent[]): number {
  return completeTurns(events).length
}

/**
 * 一次遍历得到的压缩度量（报告 P-P7）：完整 turn、token 水位、seq→turn 归属。
 *
 * 三者在原实现里各走一遍全量事件；这里合并为单遍，`planCompaction` 与
 * `shouldCompact` 共用同一份结果（旧函数仍保留为测试 oracle）。
 */
export interface SessionMetrics {
  readonly turns: readonly number[]
  readonly tokens: number
  readonly owner: ReadonlyMap<number, number>
}

export function analyzeSession(events: readonly AnySessionEvent[]): SessionMetrics {
  const turnSet = new Set<number>()
  const owner = new Map<number, number>()
  let current: number | undefined
  let tokens = 0
  /** 已计入的 system 头 token（下一次装配覆盖它，不累加）。 */
  let lastSystemTokens = 0

  for (const event of events) {
    const eventTokens = estimateEventTokens(event)
    if (event.type === 'system/message') {
      // 真实请求只有一份 system：每次 attempt 都能落一条，但旧的那些只是
      // "当时装配过"的审计痕迹。全计入会把水位按 step 数倍系统性高估（§5.2）。
      tokens += eventTokens - lastSystemTokens
      lastSystemTokens = eventTokens
    } else {
      tokens += eventTokens
    }
    if (event.type === 'turn/start') {
      current = event.data.turn
      owner.set(event.seq, current)
      continue
    }
    if (event.type === 'turn/end') {
      turnSet.add(event.data.turn)
      owner.set(event.seq, event.data.turn)
      current = undefined
      continue
    }
    if (current !== undefined) owner.set(event.seq, current)
  }

  return { turns: [...turnSet].sort((left, right) => left - right), tokens, owner }
}

function shouldCompactMetrics(
  metrics: SessionMetrics,
  thresholds: CompactionThresholds,
  overheadTokens = 0,
): boolean {
  if (metrics.turns.length <= thresholds.keepRecentTurns) return false
  // 水位是"下一次请求"的大小：事件里的历史 + 请求恒定开销（工具 schema 不在事件里）。
  if (
    thresholds.maxTokens !== undefined &&
    metrics.tokens + overheadTokens >= thresholds.maxTokens
  ) {
    return true
  }
  return thresholds.maxTurns !== undefined && metrics.turns.length > thresholds.maxTurns
}

/**
 * 是否该压缩。
 *
 * 两个前置条件缺一不可：
 * 1. 至少一个阈值被越过（token 水位或 turn 数）；
 * 2. 折叠后仍留下 `keepRecentTurns` 个 turn——否则压缩完就没有原文了，等于自残上下文。
 */
export function shouldCompact(
  events: readonly AnySessionEvent[],
  thresholds: CompactionThresholds,
  overheadTokens = 0,
): boolean {
  return shouldCompactMetrics(analyzeSession(events), thresholds, overheadTokens)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. 折叠与计划
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 把日志投影成"折叠后"的事件集。
 *
 * 两条例外（都不折叠）：
 * - `system/message`：系统头只有一份且必须最新，折叠掉模型就失去身份与安全底线；
 * - `compaction/summary` 事件本身：由 `summaries` 承载，避免摘要出现两遍。
 */
export function collapseEvents(events: readonly AnySessionEvent[]): CollapsedEvents {
  const summaries: CompactionSummaryData[] = []
  const collapsed = new Set<number>()

  for (const event of events) {
    if (event.type !== 'compaction/summary') continue
    summaries.push(event.data)
    for (let turn = event.data.fromTurn; turn <= event.data.toTurn; turn += 1) collapsed.add(turn)
  }

  const owner = turnOwnership(events)
  const kept: AnySessionEvent[] = []

  for (const event of events) {
    if (event.type === 'compaction/summary') continue
    if (event.type === 'system/message') {
      kept.push(event)
      continue
    }
    const turn = owner.get(event.seq)
    if (turn !== undefined && collapsed.has(turn)) continue
    kept.push(event)
  }

  return {
    kept,
    summaries,
    collapsedTurns: [...collapsed].sort((left, right) => left - right),
  }
}

/**
 * 产出压缩计划（不做任何写入：落账由 `appendCompactionSummary` 完成）。
 *
 * 幂等：已被摘要覆盖的 turn 在 `collapseEvents` 阶段就被剔除，所以重复调用不会重复折叠。
 */
export function planCompaction(input: PlanCompactionInput): CompactionPlan {
  const collapsed = collapseEvents(input.events)
  const metrics = analyzeSession(collapsed.kept)

  if (!shouldCompactMetrics(metrics, input.thresholds, input.overheadTokens ?? 0)) {
    return { needed: false, droppedSeqs: [], collapsedTurns: [] }
  }

  const turns = metrics.turns
  const collapseCount = turns.length - input.thresholds.keepRecentTurns
  const targets = turns.slice(0, collapseCount)
  const targetSet = new Set(targets)
  const owner = metrics.owner

  const droppedSeqs: number[] = []
  const collapsedEvents: AnySessionEvent[] = []
  let droppedMessages = 0

  for (const event of collapsed.kept) {
    const turn = owner.get(event.seq)
    if (turn === undefined || !targetSet.has(turn)) continue
    if (event.type === 'system/message') continue
    droppedSeqs.push(event.seq)
    collapsedEvents.push(event)
    if (isMessageEvent(event)) droppedMessages += 1
  }

  const fromTurn = targets[0] ?? 0
  const toTurn = targets[targets.length - 1] ?? 0
  const financial = extractFinancial(collapsedEvents)
  const data: CompactionSummaryData = {
    fromTurn,
    toTurn,
    turns: targets.length,
    summary: renderSummaryText({
      fromTurn,
      toTurn,
      turns: targets.length,
      droppedMessages,
      highlights: extractHighlights(collapsedEvents),
      toolCalls: countToolCalls(collapsedEvents),
      financial,
    }),
    refs: droppedSeqs,
    financial,
    droppedMessages,
  }

  return { needed: true, data, droppedSeqs, collapsedTurns: targets }
}

/**
 * 抽取金融特例字段（涉及金额 / 收款人 / 审批的条目必须结构化保留）。
 *
 * 数据来源三条：
 * - `tool/call.args` 里的 `amount` / `payee`（模型要求动多少钱、给谁）；
 * - `approval/asked` + `approval/decided`（票据与**审批结论**）；
 * - `tool/result`（**执行结果**——审批通过不等于执行成功）。
 *
 * 绿色直通调用没有票据：`ticketId` 缺省、`decision = 'not-required'`——不伪造票号。
 * 金额未知时 `amount` 缺省，绝不以 0 代替。
 */
export function extractFinancial(events: readonly AnySessionEvent[]): FinancialSummaryEntry[] {
  const tickets = new Map<string, { readonly ticketId: TicketId; readonly amount?: number }>()
  const decisions = new Map<TicketId, FinancialSummaryEntry['decision']>()
  const results = indexToolResults(events)

  for (const event of events) {
    if (event.type === 'approval/asked') {
      tickets.set(event.data.callId, {
        ticketId: event.data.ticketId,
        ...(event.data.amount === undefined ? {} : { amount: event.data.amount }),
      })
      continue
    }
    if (event.type === 'approval/decided') {
      decisions.set(event.data.ticketId, event.data.decision)
    }
  }

  const entries: FinancialSummaryEntry[] = []

  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const args = event.data.args
    const amount = typeof args['amount'] === 'number' ? args['amount'] : undefined
    const payee = typeof args['payee'] === 'string' ? args['payee'] : undefined
    const ticket = tickets.get(event.data.callId)
    if (amount === undefined && payee === undefined && ticket === undefined) continue

    const ticketId = ticket?.ticketId
    const result = results.get(event.data.callId)
    const resolvedAmount = amount ?? ticket?.amount
    const tier = event.data.tier.level
    const decision =
      ticketId !== undefined
        ? (decisions.get(ticketId) ?? 'pending')
        : tier === 'green' || tier === undefined
          ? 'not-required'
          : 'not-requested'
    entries.push({
      ...(resolvedAmount === undefined ? {} : { amount: resolvedAmount }),
      payee: payee ?? '（未提供）',
      ...(ticketId === undefined ? {} : { ticketId }),
      decision,
      tier,
      execution: executionOf(decision, result, tier),
      ...(result?.code === undefined ? {} : { code: result.code }),
    })
  }

  return entries
}

/**
 * 抽取每个被折叠轮次的对话要点。
 *
 * 目的不是复刻原文，而是保住**指代解析**所需的最小事实：
 * 用户说了什么、助手最后怎么答、工具拿什么参数查到了什么。
 * 只有模型可见消息参与；`runtime-context` 等每次重渲染的派生消息不算用户原话。
 */
export function extractHighlights(events: readonly AnySessionEvent[]): SummaryTurnHighlight[] {
  const owner = turnOwnership(events)
  const results = indexToolResults(events)
  const turns = new Map<number, MutableTurnHighlight>()

  for (const event of events) {
    const turn = owner.get(event.seq)
    if (turn === undefined) continue

    switch (event.type) {
      case 'user/message': {
        if (event.data.source !== undefined && event.data.source !== 'user') continue
        const text = oneLine(event.data.content)
        if (text === '') continue
        turnBuilder(turns, turn).user.push(text)
        continue
      }
      case 'assistant/message': {
        const text = oneLine(textOfBlocks(event.data.content))
        if (text === '') continue
        turnBuilder(turns, turn).assistant = text
        continue
      }
      case 'tool/call': {
        const result = results.get(event.data.callId)
        turnBuilder(turns, turn).tools.push({
          name: event.data.name,
          args: clip(compactJson(event.data.args), TOOL_ARGS_MAX_CHARS),
          status: result === undefined ? 'pending' : toolStatusOf(result),
          ...(result?.code === undefined ? {} : { code: result.code }),
          result:
            result === undefined
              ? ''
              : clip(oneLine(textOfBlocks(result.content)), TOOL_RESULT_MAX_CHARS),
        })
        continue
      }
      default:
        continue
    }
  }

  return [...turns.values()]
    .sort((left, right) => left.turn - right.turn)
    .map((turn) => {
      const omittedTools = Math.max(0, turn.tools.length - TOOLS_PER_TURN)
      return {
        turn: turn.turn,
        user: clip(turn.user.join('；'), QUOTE_MAX_CHARS),
        assistant: clip(turn.assistant, QUOTE_MAX_CHARS),
        tools: turn.tools.slice(-TOOLS_PER_TURN),
        omittedTools,
      }
    })
}

/** 摘要文本（确定性：同样的折叠内容永远得到同样的字符串，快照可逐字比对）。 */
export function renderSummaryText(input: SummaryTextInput): string {
  const lines = [
    `[已压缩历史] 第 ${input.fromTurn}–${input.toTurn} 轮（共 ${input.turns} 轮、${input.droppedMessages} 条消息）已折叠；以下为压缩时保留的对话要点与资金记录。`,
    ...renderHighlights(input.highlights),
  ]
  if (input.toolCalls.length > 0) {
    lines.push(
      `- 工具调用合计：${input.toolCalls.map((item) => `${item.name}×${item.count}`).join('、')}`,
    )
  }
  if (input.financial.length > 0) {
    lines.push('- 资金动作（结构化保留）：')
    for (const entry of input.financial) {
      const ticket = entry.ticketId === undefined ? '' : `，票据 ${entry.ticketId}`
      lines.push(
        `  · ${moneyText(entry.amount)} → ${entry.payee}（${approvalText(entry)}${ticket}；${executionText(entry)}）`,
      )
    }
  }
  lines.push(
    '后续轮次请把以上摘要当作此前对话的可用记录：用户提到更早的账户、金额或结论时，先按摘要补全指代；摘要未覆盖的细节，向用户确认后再行动，不要凭空编造。',
  )
  return lines.join('\n')
}

/** 摘要 → 模型可见的一条 user 消息（放在 system 之后、其余历史之前）。 */
export function summaryMessage(data: CompactionSummaryData): DerivedMessage {
  return { role: 'user', content: data.summary }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. 内部工具
 * ──────────────────────────────────────────────────────────────────────────── */

/** `seq → turn` 归属（turn 外的孤立事件不入表）。 */
export function turnOwnership(events: readonly AnySessionEvent[]): Map<number, number> {
  const owner = new Map<number, number>()
  let current: number | undefined

  for (const event of events) {
    if (event.type === 'turn/start') {
      current = event.data.turn
      owner.set(event.seq, current)
      continue
    }
    if (event.type === 'turn/end') {
      owner.set(event.seq, event.data.turn)
      current = undefined
      continue
    }
    if (current !== undefined) owner.set(event.seq, current)
  }

  return owner
}

/** 抽取期的可变轮次（渲染前才冻结成 `SummaryTurnHighlight`）。 */
interface MutableTurnHighlight {
  readonly turn: number
  readonly user: string[]
  assistant: string
  readonly tools: SummaryToolHighlight[]
}

/** 取（或建）一个轮次的可变要点。 */
function turnBuilder(turns: Map<number, MutableTurnHighlight>, turn: number): MutableTurnHighlight {
  const existing = turns.get(turn)
  if (existing !== undefined) return existing
  const created: MutableTurnHighlight = { turn, user: [], assistant: '', tools: [] }
  turns.set(turn, created)
  return created
}

/** 同一 `callId` 的权威结果（后落的覆盖先落的：重试以最后一次为准）。 */
function indexToolResults(events: readonly AnySessionEvent[]): Map<string, ToolResultData> {
  const results = new Map<string, ToolResultData>()
  for (const event of events) {
    if (event.type === 'tool/result') results.set(event.data.callId, event.data)
  }
  return results
}

/**
 * 审批结论 + 工具结果 → 执行结果。
 *
 * 优先级：成功的工具结果是唯一的"已执行"证据；审批拒绝/取消/不可用一律 `blocked`（未执行）；
 * 黄/红级没有票据且结果是错误 = 审批前就被策略/前置校验拦下，同样是 `blocked`；
 * 其余有结果才算 `failed`；没有结果就是 `pending`，不猜。
 */
function executionOf(
  decision: FinancialSummaryEntry['decision'],
  result: ToolResultData | undefined,
  tier: FinancialSummaryEntry['tier'],
): FinancialExecution {
  if (result !== undefined && !result.isError) return 'succeeded'
  if (decision === 'rejected' || decision === 'cancelled' || decision === 'unavailable') {
    return 'blocked'
  }
  if (result?.code?.startsWith('approval-') === true) return 'blocked'
  // 黄/红级没有票据（decision = not-requested）= 还没走到审批就被策略 / 前置校验拦下，
  // 工具一次都没跑。绿色调用没有这道闸，错误就是真执行失败。
  if (decision === 'not-requested' && result !== undefined && result.isError) {
    return 'blocked'
  }
  return result === undefined ? 'pending' : 'failed'
}

/** 工具调用在摘要里的状态（只看 `tool/result`）。 */
function toolStatusOf(result: ToolResultData): SummaryToolStatus {
  if (!result.isError) return 'succeeded'
  return result.code?.startsWith('approval-') === true ? 'blocked' : 'failed'
}

const TOOL_STATUS_LABELS: Readonly<Record<SummaryToolStatus, string>> = {
  succeeded: '成功',
  failed: '失败',
  blocked: '未执行',
  pending: '结果未落账',
}

const EXECUTION_LABELS: Readonly<Record<FinancialExecution, string>> = {
  succeeded: '执行成功',
  failed: '执行失败',
  blocked: '未执行',
  pending: '执行未完成（无结果）',
}

/** 对话要点段落：从最近轮次往前装，超出字符预算的较早轮次只保留计数。 */
function renderHighlights(highlights: readonly SummaryTurnHighlight[]): string[] {
  if (highlights.length === 0) return []

  const blocks = highlights.map(renderTurnHighlight)
  const kept: string[] = []
  let used = 0
  let omitted = 0

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index] ?? ''
    if (kept.length > 0 && used + block.length + 1 > HIGHLIGHT_BUDGET_CHARS) {
      omitted = index + 1
      break
    }
    kept.push(block)
    used += block.length + 1
  }

  kept.reverse()
  return [...(omitted === 0 ? [] : [`- 更早的 ${omitted} 轮细节已省略（轮次与工具计数见上行）`]), ...kept]
}

/** 单轮要点块。 */
function renderTurnHighlight(highlight: SummaryTurnHighlight): string {
  const parts: string[] = []
  if (highlight.user !== '') parts.push(`用户：「${highlight.user}」`)
  if (highlight.assistant !== '') parts.push(`助手：「${highlight.assistant}」`)
  const lines =
    parts.length === 0 ? [`- 第 ${highlight.turn} 轮`] : [`- 第 ${highlight.turn} 轮｜${parts.join(' → ')}`]

  for (const tool of highlight.tools) {
    const detail = tool.result === '' ? '' : `：${tool.result}`
    lines.push(`  工具 ${tool.name}(${tool.args}) → ${toolStatusText(tool)}${detail}`)
  }
  if (highlight.omittedTools > 0) {
    lines.push(`  …另有 ${highlight.omittedTools} 次工具调用（计数见合计）`)
  }
  return lines.join('\n')
}

function toolStatusText(tool: SummaryToolHighlight): string {
  const label = TOOL_STATUS_LABELS[tool.status]
  return tool.status === 'succeeded' || tool.code === undefined ? label : `${label}（${tool.code}）`
}

function moneyText(amount: number | undefined): string {
  return amount === undefined ? '金额未知' : `¥${amount.toFixed(2)}`
}

function approvalText(entry: FinancialSummaryEntry): string {
  if (entry.ticketId !== undefined) return `审批 ${entry.decision}`
  if (entry.decision === 'not-requested') {
    return entry.tier === undefined ? '未进入审批' : `未进入审批（${entry.tier} 级调用被前置拦截）`
  }
  if (entry.tier === 'green') return '无审批（绿色直通）'
  return '无票据记录'
}

function executionText(entry: FinancialSummaryEntry): string {
  const label = EXECUTION_LABELS[entry.execution]
  if (entry.execution === 'succeeded' || entry.code === undefined) return label
  return `${label}，理由码 ${entry.code}`
}

/** 参数的单行 JSON（不可序列化时显式标注，不吞错）。 */
function compactJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? '' : text
  } catch {
    return '（参数无法序列化）'
  }
}

/** 多行文本压成单行（摘要里的引述不保留排版）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 按字符（code point）截断，超出部分以省略号收尾。 */
function clip(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}

/** 有 `turn/end` 的 turn（升序、去重）。 */
function completeTurns(events: readonly AnySessionEvent[]): number[] {
  const turns = new Set<number>()
  for (const event of events) {
    if (event.type === 'turn/end') turns.add(event.data.turn)
  }
  return [...turns].sort((left, right) => left - right)
}

/** 模型可见的消息类事件。 */
function isMessageEvent(event: AnySessionEvent): boolean {
  return (
    event.type === 'system/message' ||
    event.type === 'user/message' ||
    event.type === 'assistant/message' ||
    event.type === 'tool/result'
  )
}

/** 工具调用次数统计（按工具名聚合，保持首次出现顺序）。 */
function countToolCalls(
  events: readonly AnySessionEvent[],
): { readonly name: string; readonly count: number }[] {
  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    counts.set(event.data.name, (counts.get(event.data.name) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }))
}

/** 内容块取文本（图片块不计 token 估算）。 */
function blockText(block: ContentBlock): string {
  return block.type === 'text' ? block.text : ''
}

/** 内容块 → 单段文本（空块不占分隔符，否则估算会虚高）。 */
function textOfBlocks(content: readonly ContentBlock[]): string {
  return content
    .map(blockText)
    .filter((text) => text.length > 0)
    .join('\n')
}
