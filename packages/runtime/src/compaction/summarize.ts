/**
 * 上下文压缩（施工单 05 §5）：阈值判定 → 结构化摘要 → 折叠投影。
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
 * 需要时再作为可选增强（本阶段不做，见 PROGRESS 偏离记录）。
 */

import { BahError } from '@bah/util'

import type { ContentBlock, TicketId } from '@bah/core'

import type {
  AnySessionEvent,
  CompactionSummaryData,
  DerivedMessage,
  FinancialSummaryEntry,
} from '../session/types.ts'
import type {
  CollapsedEvents,
  CompactionPlan,
  CompactionThresholds,
  PlanCompactionInput,
  SummaryTextInput,
} from './types.ts'

/** 估算用的字符/token 比（中英文混排的保守值；只用于阈值判定，不参与计费）。 */
const CHARS_PER_TOKEN = 4

/** 允许的配置键（未知键 fail-loud，施工单 00 §9「misconfiguration 必须 fail-loud」）。 */
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

/** 文本 → token 估算（向上取整）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

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
      return 0
  }
}

/** 完整 turn 的数量（有 `turn/end` 才算完整：未闭合的 turn 不折叠）。 */
export function countCompleteTurns(events: readonly AnySessionEvent[]): number {
  return completeTurns(events).length
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
): boolean {
  const turns = countCompleteTurns(events)
  if (turns <= thresholds.keepRecentTurns) return false

  if (thresholds.maxTokens !== undefined) {
    const tokens = events.reduce((sum, event) => sum + estimateEventTokens(event), 0)
    if (tokens >= thresholds.maxTokens) return true
  }

  return thresholds.maxTurns !== undefined && turns > thresholds.maxTurns
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
  const turns = completeTurns(collapsed.kept)

  if (!shouldCompact(collapsed.kept, input.thresholds)) {
    return { needed: false, droppedSeqs: [], collapsedTurns: [] }
  }

  const collapseCount = turns.length - input.thresholds.keepRecentTurns
  const targets = turns.slice(0, collapseCount)
  const targetSet = new Set(targets)
  const owner = turnOwnership(collapsed.kept)

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
 * 抽取金融特例字段（施工单 05 §5：涉及金额 / 收款人 / 审批的条目必须结构化保留）。
 *
 * 数据来源两条：
 * - `tool/call.args` 里的 `amount` / `payee`（模型要求动多少钱、给谁）；
 * - `approval/asked` + `approval/decided`（票据与结论）。
 *
 * 绿色直通调用没有票据：`ticketId` 缺省、`decision = 'not-required'`——不伪造票号。
 */
export function extractFinancial(events: readonly AnySessionEvent[]): FinancialSummaryEntry[] {
  const tickets = new Map<string, { readonly ticketId: TicketId; readonly amount?: number }>()
  const decisions = new Map<TicketId, string>()

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
    entries.push({
      amount: amount ?? ticket?.amount ?? 0,
      payee: payee ?? '（未提供）',
      ...(ticketId === undefined ? {} : { ticketId }),
      decision: ticketId === undefined ? 'not-required' : (decisions.get(ticketId) ?? 'pending'),
    })
  }

  return entries
}

/** 摘要文本（确定性：同样的折叠内容永远得到同样的字符串，快照可逐字比对）。 */
export function renderSummaryText(input: SummaryTextInput): string {
  const lines = [
    `[已压缩历史] 第 ${input.fromTurn}–${input.toTurn} 轮（共 ${input.turns} 轮、${input.droppedMessages} 条消息）已折叠为摘要；原文仍在会话日志中（见 refs）。`,
  ]
  if (input.toolCalls.length > 0) {
    lines.push(`- 工具调用：${input.toolCalls.map((item) => `${item.name}×${item.count}`).join('、')}`)
  }
  if (input.financial.length > 0) {
    lines.push('- 资金动作（结构化保留）：')
    for (const entry of input.financial) {
      const ticket = entry.ticketId === undefined ? '' : `，票据 ${entry.ticketId}`
      lines.push(`  · ¥${entry.amount.toFixed(2)} → ${entry.payee}（${entry.decision}${ticket}）`)
    }
  }
  lines.push('后续轮次请把以上摘要当作已知背景；不要假设更早的对话原文仍在上下文中。')
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
