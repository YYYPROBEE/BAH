/**
 * 会话事件 → 帧 的**唯一归约器**。
 *
 * 三条不变量（测试按此断言）：
 * 1. **纯**：不读时钟、不读随机、不读 DOM；同一串事件两次归约必须深度相等（T-WEB-007）；
 * 2. **幂等**：`seq` 单调过滤，重复喂同一条事件不产生第二帧（T-WEB-001 的"不重"）；
 * 3. **可追**：每帧都带 `seq`（`delta` 例外），审计面板每条都能回跳日志。
 *
 * 归约而不是"视图各自推导"：五个视图共享同一份事实，防止某条事件只在一个视图里出错。
 */

import { occurrenceOf } from '@bah/runtime'
import { assertNever } from '@bah/util'

import type { AnySessionEvent, ApprovalDecision, TurnEndReason } from '@bah/runtime'

import type {
  ApprovalClosedFrame,
  ApprovalDetail,
  ApprovalFrame,
  CardView,
  DagFrame,
  DagNode,
  DeltaFrame,
  EffectItem,
  EffectsFrame,
  FrameTier,
  GoalFrame,
  FrameTone,
  MessageBlock,
  MessageFrame,
  NoticeFrame,
  PlanCardCondition,
  PlanCardFrame,
  RiskQuestionItem,
  RiskQuestionnaireFrame,
  SnapshotFrame,
  TodoFrame,
  TodoItem,
  ChoiceFrame,
  ChoiceOption,
  ToolFrame,
  TurnFrame,
  WebFrame,
} from './frames.ts'
import { frameKey } from './frames.ts'
import { auditOf } from './audit.ts'
import { buildCard, toolTitle } from './cards.ts'
import { aaFromResult, applyCollected, applyParticipantUpdated, type AaProgress } from './aa.ts'
import { billReportBlockOf, type BillReportBlock } from './bill-report.ts'
import { snapshotOf, upcomingBlockOf } from './subscriptions.ts'
// ADR-0016：主动提醒 → `notice` 帧（与 read/risk-questions 同类的"领域事件也产帧"例外）
import { proactiveNoticeOf } from './proactive.ts'

import type { SubscriptionSnapshot } from './subscriptions.ts'
import { requiredConfirmText } from './confirm.ts'
import { amountFromArgs, maskedPayeePhoneFromArgs, payeeFromArgs } from './amount.ts'
import { DagBuilder } from './dag.ts'
import { formatCents } from './format.ts'

/** 工具调用的内部登记（`tool/call` 到达时建立，`tool/result` 时结算）。 */
interface CallRecord {
  readonly callId: string
  readonly name: string
  readonly args: unknown
  readonly turn: number
  readonly step: number
  tier: FrameTier
  state: 'pending' | 'done' | 'denied'
}

/** 内容块 → 消息块（图片保留，未知类型只留"有内容"这个事实）。 */
function toMessageBlocks(content: readonly { type: string; text?: string; mimeType?: string; data?: string }[]): MessageBlock[] {
  const blocks: MessageBlock[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && typeof block.data === 'string') {
      blocks.push({ type: 'image', mimeType: block.mimeType ?? 'image/png', data: block.data })
    } else {
      blocks.push({ type: 'other', summary: block.type })
    }
  }
  return blocks
}

/**
 * 审批明细的展示上限（行数）。
 *
 * 超过就截断并置 `detailsTruncated`：审批卡的用途是"确认要执行什么"，
 * 20 行的明细会把人逼成只找"批准"按钮。完整明细仍在 `approval/asked` 事件里。
 */
export const DETAILS_MAX_ROWS = 12

/** 一行明细的最大字符数（防止一条超长值把卡片撑爆；截断可见）。 */
const DETAIL_MAX_CHARS = 160

/**
 * `read/risk-questions` → 问卷卡。
 *
 * 三条守卫（与明细投影同口径）：
 * 1. 只**剔除**不合形状的项，不改写题干、不重算分值（改了就是渠道自造问卷）；
 * 2. 任一关键字段缺失 ⇒ 整张卡不产（半张问卷比没有更糟：用户会以为自己漏看了题）；
 * 3. 控制字符折成空格，防止一条题干里的换行伪造出"多一题"。
 */
export function riskQuestionnaireFrameOf(
  raw: unknown,
  seq: number,
  at: number,
): RiskQuestionnaireFrame | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const callId = plainTextOf(record['callId'])
  const questionnaireId = plainTextOf(record['questionnaireId'])
  const version = plainTextOf(record['version'])
  const expiresAt = record['expiresAt']
  const questions = riskQuestionsOf(record['questions'])
  if (
    callId === undefined ||
    questionnaireId === undefined ||
    version === undefined ||
    typeof expiresAt !== 'number' ||
    questions.length === 0
  ) {
    return undefined
  }
  return {
    kind: 'risk-questionnaire',
    seq,
    at,
    callId,
    questionnaireId,
    version,
    expiresAt,
    questions,
  }
}

/** 题目数组的形状守卫（允许丢弃坏项，但至少要有 1 题）。 */
function riskQuestionsOf(raw: unknown): readonly RiskQuestionItem[] {
  if (!Array.isArray(raw)) return []
  const items: RiskQuestionItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const index = record['index']
    const title = plainTextOf(record['title'])
    if (typeof index !== 'number' || !Number.isInteger(index) || title === undefined) continue
    const options: { readonly key: string; readonly text: string; readonly score: number }[] = []
    const rawOptions = record['options']
    if (Array.isArray(rawOptions)) {
      for (const option of rawOptions) {
        if (typeof option !== 'object' || option === null) continue
        const item = option as Record<string, unknown>
        const key = plainTextOf(item['key'])
        const text = plainTextOf(item['text'])
        const score = item['score']
        if (key === undefined || text === undefined || typeof score !== 'number') continue
        options.push({ key, text, score })
      }
    }
    if (options.length === 0) continue
    items.push({ index, title, options })
  }
  return items.sort((left, right) => left.index - right.index)
}

/** 单行文本归一（去控制字符 / 折空白 / 截断；空串 → `undefined`）。 */
function plainTextOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length === 0 ? undefined : cleaned
}

/**
 * `approval/asked.details` → 帧上的明细（**原样**投影，不做二次计算）。
 *
 * 三条纪律：
 * 1. 不解析、不格式化、不重排金额与日期——服务端签发什么就显示什么，
 *    渠道一旦"顺手美化"，同一笔钱就会出现两个口径；
 * 2. 形状守卫只做**剔除**：非对象 / 空 label / 空 value / 非白名单 emphasis 直接丢；
 *    控制字符折成空格（否则一条值里的换行能伪造出"多一行字段"）；
 * 3. 全丢光与超限都要能表达：前者返回 `{}`（帧上不出现 details），后者带 `detailsTruncated`。
 */
export function projectApprovalDetails(raw: unknown): {
  readonly details?: readonly ApprovalDetail[]
  readonly detailsTruncated?: boolean
} {
  if (!Array.isArray(raw) || raw.length === 0) return {}
  const rows: ApprovalDetail[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const label = detailTextOf(record['label'])
    const value = detailTextOf(record['value'])
    if (label === undefined || value === undefined) continue
    const emphasis = record['emphasis']
    rows.push({
      label,
      value,
      ...(emphasis === 'amount' || emphasis === 'date' || emphasis === 'risk' ? { emphasis } : {}),
    })
  }
  if (rows.length === 0) return {}
  const visible = rows.slice(0, DETAILS_MAX_ROWS)
  return {
    details: visible,
    ...(rows.length > DETAILS_MAX_ROWS ? { detailsTruncated: true } : {}),
  }
}

/** 明细字段的文本归一（去控制字符、截断；空串 → `undefined`）。 */
function detailTextOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) return undefined
  return cleaned.length > DETAIL_MAX_CHARS ? `${cleaned.slice(0, DETAIL_MAX_CHARS)}…` : cleaned
}

/**
 * 预演结果的索引键：收款人 + 金额（分）。
 *
 * 只按收款人名会串味：同一人先后试算 800 / 5000，两笔手续费可能不同，
 * 审批 800 时不能拿 5000 的那条。
 */
function previewKey(payee: string, cents: number | undefined): string {
  return `${payee}\u0000${cents === undefined ? '' : String(cents)}`
}

/**
 * 从预演结果正文里取手续费文本。
 *
 * 结果卡片（`UiCard`）不落账，正文是唯一持久化的来源；取不到就返回 `undefined`，
 * 审批帧宁可少一行，也不从金额/费率反推一个"看起来对"的数。
 */
function previewFeeOf(content: readonly { type: string; text?: string }[]): string | undefined {
  const text = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  const match = /手续费\s*(¥\s?[0-9][0-9,]*(?:\.[0-9]{2})?)/.exec(text)
  return match?.[1]?.replace(/\s+/g, '')
}

/**
 * 失败工具的三种细分：`denied` = 判决拦截（安全 / 审批 / 策略），`failed` = 执行期错误。
 *
 * 判据不能是"有没有理由码"：执行期异常恰恰**总是**带码（运行时兜底 `tool-failed`、
 * 出参契约校验 `tool-result-invalid`），按"有码即拦截"会把内部错误讲成风控拦截。
 * 所以只把这两条明确的执行期失败码判 `failed`，其余带码的 `isError` 仍是判决拦截
 * （`PRV-002`、`approval-rejected`、`policy-denied` 这类正是要讲给人听的拦截叙事）。
 */
const EXECUTION_FAILURE_CODES: ReadonlySet<string> = new Set(['tool-failed', 'tool-result-invalid'])

/** 工具失败细分（`denied` / `failed`）。 */
function reasonKindOf(code: string | undefined): 'denied' | 'failed' {
  return code === undefined || EXECUTION_FAILURE_CODES.has(code) ? 'failed' : 'denied'
}

/** 结束原因 → 提示级别。 */
function noticeLevel(end: TurnEndReason): NoticeFrame['level'] {  switch (end.kind) {
    case 'completed':
      return 'success'
    case 'blocked':
    case 'aborted':
    case 'guard-stopped':
      return 'warning'
    case 'max-tokens':
    case 'failed':
      return 'danger'
    default:
      return assertNever(end, 'turn-end-reason')
  }
}

/** 结束原因 → 标题。 */
function noticeTitle(end: TurnEndReason): string {
  switch (end.kind) {
    case 'completed':
      return '本轮完成'
    case 'blocked':
      return '本轮被入口拦截'
    case 'aborted':
      return '本轮已中断'
    case 'max-tokens':
      return '达到输出上限'
    case 'guard-stopped':
      return '主循环已判停'
    case 'failed':
      return '本轮失败'
    default:
      return assertNever(end, 'turn-end-reason')
  }
}

/**
 * `DagNode.state` → 待办项的 `done` / `tone`（穷尽 9 态，`frames.ts` 的联合）。
 *
 * 映射口径：
 *   ok → 完成 · success
 *   pending / running → 未完成 · default
 *   blocked → 未完成 · warning（等前置，不是错）
 *   denied / failed / incident → 未完成 · danger
 *   skipped / cancelled → 已完成 · muted（不会再做了，但也不算"待办"）
 */
function todoStateOf(state: DagNode['state']): { readonly done: boolean; readonly tone: FrameTone } {
  switch (state) {
    case 'ok':
      return { done: true, tone: 'success' }
    case 'pending':
    case 'running':
      return { done: false, tone: 'default' }
    case 'blocked':
      return { done: false, tone: 'warning' }
    case 'denied':
    case 'failed':
    case 'incident':
      return { done: false, tone: 'danger' }
    case 'skipped':
    case 'cancelled':
      return { done: true, tone: 'muted' }
    default:
      return assertNever(state, 'plan-node-state')
  }
}


/** `goal_set` 出参的帧侧形状（只取投影需要的字段；解析失败 = 不产帧，不编造）。 */
interface GoalView {
  readonly statement: string
  readonly status: GoalFrame['status']
  readonly amountCents?: number
}

/** 帧侧状态词汇：账本四态各有对应，未知值不猜（返回 undefined ⇒ 不产帧）。 */
function goalStatusOf(value: unknown): GoalFrame['status'] | undefined {
  switch (value) {
    case 'active':
      return 'active'
    case 'achieved':
      return 'done'
    case 'abandoned':
      return 'abandoned'
    case 'expired':
      return 'expired'
    default:
      return undefined
  }
}

/**
 * 从 `tool/result` 的正文里取 `goal_set` 出参（默认 JSON 投影；无 projectContent 的工具）。
 * 解析失败返回 undefined：投影层遇到看不懂的内容宁可不产帧，也不编一条"目标"出来。
 */
function goalOf(content: readonly { type: string; text?: string }[]): GoalView | undefined {
  const block = content.find((item) => item.type === 'text')
  if (block === undefined || block.text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(block.text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const statement = record['statement']
  const status = goalStatusOf(record['status'])
  if (typeof statement !== 'string' || status === undefined) return undefined
  const budget = record['budget']
  const amountCents =
    typeof budget === 'object' && budget !== null
      ? (budget as Record<string, unknown>)['amountCents']
      : undefined
  return {
    statement,
    status,
    ...(typeof amountCents === 'number' ? { amountCents } : {}),
  }
}

/**
 * 待办派生：纯函数（不读时钟 / 随机 / IO）。
 *
 * 输入是 `DagBuilder` 已归约出的 plan 节点视图，输出**确定性排序**的清单。
 * WHY 纯 + 显式排序：同一输入必须产出逐字节相同的帧，否则 SSE 重连发全量快照
 * （`web/sse.ts`）时前端角标会抖。排序：先 `done` 升序（未完成在前），
 * 再 `id` 字典序升序——**不得**依赖 `DagNode[]` 的原始顺序（来自 Map 迭代，
 * 插入序在回放与实时两条路径上可能不同）。
 *
 * @returns 无 plan 节点时返回 `null`（不产空帧）
 */
export function projectTodo(input: {
  readonly turn: number
  readonly seq: number
  readonly at: number
  readonly planId: string
  readonly nodes: readonly DagNode[]
  readonly blockedBy?: Readonly<Record<string, readonly string[]>>
}): TodoFrame | null {
  const nodes = input.nodes.filter((node) => node.kind === 'plan' && node.planId === input.planId)
  if (nodes.length === 0) return null

  const items: TodoItem[] = nodes
    .map((node) => {
      const { done, tone } = todoStateOf(node.state)
      const blockedBy = input.blockedBy?.[node.id]
      return {
        id: node.id,
        text: node.label,
        done,
        ...(node.code === undefined ? {} : { code: node.code }),
        ...(blockedBy === undefined ? {} : { blockedBy }),
        tone,
      } satisfies TodoItem
    })
    .sort((left, right) => {
      if (left.done !== right.done) return left.done ? 1 : -1
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })

  return {
    kind: 'todo',
    seq: input.seq,
    at: input.at,
    turn: input.turn,
    planId: input.planId,
    items,
    openCount: items.filter((item) => !item.done).length,
  }
}

/**
 * 影响面派生：纯函数（不读时钟 / 随机 / IO）。
 *
 * 写操作用**双判据**（`tool/result` 载荷里没有 `sideEffect`，而
 * `@bah/channels` 不得反向依赖 bank）：
 *
 * ① `tier === 'yellow' || tier === 'red'` —— 追溯 `tool/call.tier.level`（需审批 = 有资金或状态写）；
 * ② `writeToolNames` 命中 —— **调用方注入**的权威名单（宿主从注册表读 `sideEffect==='write'`；
 *    01 单只留注入口，接线属 04 单）。
 *
 * `tier === 'unknown'` **不产出**：`FrameTier` 的口径是"事件里没带，绝不猜"，把"不知道"
 * 当成"写"等于编造一条"已发生操作"（登记于 01 §9 V8）。
 *
 * 诚实边界：`verify_face|sms|ushield` 是**绿级但 `sideEffect:'write'`**
 * （`bank/src/tools/catalog.ts`）⇒ 只靠 ① 会漏；② 未接线前（01 单交付态）`effects` 帧对
 * 这三个工具**不产出**——这是已知缺口，不是"已实现"。
 *
 * @returns 无可呈现条目时返回 `null`（**不产空帧**，避免噪声）
 */
export function projectEffects(input: {
  readonly turn: number
  readonly seq: number
  readonly at: number
  readonly items: readonly {
    readonly callId: string
    readonly name: string
    readonly tier: FrameTier
    readonly args: unknown
    readonly durationMs?: number
    readonly ticketId?: string
  }[]
  readonly writeToolNames?: readonly string[]
}): EffectsFrame | null {
  const items: EffectItem[] = []
  let ticketId: string | undefined
  for (const candidate of input.items) {
    const byTier = candidate.tier === 'yellow' || candidate.tier === 'red'
    const byName = input.writeToolNames?.includes(candidate.name) === true
    if (!byTier && !byName) continue
    const cents = amountFromArgs(candidate.args)
    items.push({
      callId: candidate.callId,
      name: candidate.name,
      title: toolTitle(candidate.name),
      ...(cents === undefined ? {} : { amountText: formatCents(cents) }),
      ...(candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }),
      tone: 'success',
    })
    if (candidate.ticketId !== undefined) ticketId = candidate.ticketId
  }
  if (items.length === 0) return null
  return {
    kind: 'effects',
    seq: input.seq,
    at: input.at,
    turn: input.turn,
    items,
    ...(ticketId === undefined ? {} : { ticketId }),
  }
}

/** 影响面候选（`projectEffects` 的入参项；由 `tool/result` + `CallRecord` 组装）。 */
interface EffectCandidate {
  readonly callId: string
  readonly name: string
  readonly tier: FrameTier
  readonly args: unknown
  readonly durationMs?: number
  readonly ticketId?: string
}

/** `WebProjector` 的可选注入口。 */
export interface WebProjectorOptions {
  /**
   * 写侧工具名单（权威来源 = 宿主的工具注册表 `sideEffect === 'write'`）。
   * 01 单只留注入口，接线属 04 单；未注入时 `effects` 只按 `tier` 双判据之一工作。
   */
  readonly writeToolNames?: readonly string[]
}

/** Web 事件投影器（一对一实例；`frames()` 是只读视图）。 */
export class WebProjector {
  private readonly list: WebFrame[] = []
  private readonly index = new Map<string, number>()
  private readonly calls = new Map<string, CallRecord>()
  /** 本 turn 预演结果里的手续费（按收款人姓名），供审批帧显示。 */
  private readonly previewFees = new Map<string, string>()
  /** 本 turn 已有成功预演的「收款人+金额」：只用于审批金额是否已由工具证实的判定。 */
  private readonly previewConfirmed = new Set<string>()
  private readonly dag = new DagBuilder()
  /** `plan/node-blocked.blockedBy`，键 = `DagNode.id`（`dag.ts` 的 `plan:` 前缀形态）。 */
  private readonly blockedBy = new Map<string, readonly string[]>()
  /** 每个 turn 的写操作候选（`effects` 帧累积替换用）。 */
  private readonly effectCandidates = new Map<number, EffectCandidate[]>()
  /** `tool/call.callId` → 审批票号（`effects` 帧的可选 `ticketId`）。 */
  private readonly ticketOfCall = new Map<string, string>()
  private readonly writeToolNames?: readonly string[]
  /** 最近一次 `read/subscriptions` 快照（订阅卡片「即将扣款」块的数据源）。 */
  private subscriptions?: SubscriptionSnapshot
  /** 最近一个 AA 组的进度（`aa_create` 卡片「收款进度」块的数据源）。 */
  private aaProgress?: AaProgress
  /** 本 turn 最近一次 `read/bill-report` 的结构化块（`bill_report` 卡片表格的数据源）。 */
  private billReport?: BillReportBlock
  private last = 0
  private turn = 0
  private step = 0

  constructor(options: WebProjectorOptions = {}) {
    this.writeToolNames = options.writeToolNames
  }

  /** 已归约的最大 `seq`。 */
  maxSeq(): number {
    return this.last
  }

  /** 当前轮次（未开始为 0）。 */
  currentTurn(): number {
    return this.turn
  }

  /** 全量帧（只读；调用方不得改写）。 */
  frames(): readonly WebFrame[] {
    return this.list
  }

  /** 全量快照（连接 / 重同步）。 */
  snapshot(sessionId: string): SnapshotFrame {
    return {
      kind: 'snapshot',
      sessionId,
      maxSeq: this.last,
      frames: this.list.map((frame) => frame),
    }
  }

  /**
   * 归约一条事件。
   *
   * @returns 本次产生的帧（0..n）；重复 `seq` 返回空数组
   */
  apply(event: AnySessionEvent): WebFrame[] {
    if (event.seq <= this.last) return []
    this.last = event.seq

    const emitted = this.project(event)
    for (const frame of emitted) this.upsert(frame)

    const audit = auditOf(event)
    if (audit !== undefined) {
      this.upsert(audit)
      emitted.push(audit)
    }
    return emitted
  }

  /** 事件本体的投影（不含审计条目）。 */
  private project(event: AnySessionEvent): WebFrame[] {
    // plan/* 域事件（B2）：不在 `AnySessionEvent` 联合里（appendDomain 不受事件表约束），
    // 按 derive.ts 同款纪律用结构化读取，在类型化 switch 之前分流
    if (String(event.type).startsWith('plan/')) {
      return this.projectPlan(String(event.type), event)
    }
    // handoff/* 域事件（人机接管 01）：同样不在 `AnySessionEvent` 联合里
    if (String(event.type).startsWith('handoff/')) {
      return this.projectHandoff(String(event.type), event)
    }
    // 订阅清单域事件（ADR-0007）：只记快照，不产帧——它供 sub_list 卡片画「即将扣款」块
    if (String(event.type) === 'read/subscriptions') {
      const snapshot = snapshotOf((event as { data?: unknown }).data, event.at)
      if (snapshot !== undefined) this.subscriptions = snapshot
      return []
    }
    // AA 收款进度（场景 1 子能力）：同样只记快照，不产帧。代收本身是工具调用
    // （`aa_create` 的 collect 分支），帧已由 `tool/result` 产出，这里只补"每人是否已收"。
    if (String(event.type) === 'aa/created' || String(event.type) === 'read/aa') {
      const next = aaFromResult((event as { data?: unknown }).data)
      if (next !== undefined) this.aaProgress = next
      return []
    }
    if (String(event.type) === 'aa/collected') {
      // 组号对不上时 `applyCollected` 返回 undefined，旧快照原样保留
      const next = applyCollected(this.aaProgress, (event as { data?: unknown }).data)
      if (next !== undefined) this.aaProgress = next
      return []
    }
    // ADR-0017：拒绝 / 到期推进同一张进度表。缺这一步 declined 会在卡片上显示成"待收"。
    if (String(event.type) === 'aa/participant-updated') {
      const next = applyParticipantUpdated(this.aaProgress, (event as { data?: unknown }).data)
      if (next !== undefined) this.aaProgress = next
      return []
    }
    // 主动提醒（ADR-0016）：**与 `read/risk-questions` 同类的必要例外**——主动推送没有
    // `tool/call` 作承载点，"用户没问也看得到"只有在事件自己产帧时才回放得出来。
    // 被预算压掉的（`channel='none'`）返回 undefined：只进审计，不进对话。
    if (String(event.type) === 'proactive/reminder') {
      const frame = proactiveNoticeOf((event as { data?: unknown }).data, event.seq, event.at)
      return frame === undefined ? [] : [frame]
    }
    // 账单报告的结构化块（场景 2）：同样只记快照、不产帧——卡片帧由 `tool/result` 产出，
    // 这里只补「分类表 / 收款人 / 异常」。载荷形状不合格就不记（卡片退回正文排版），
    // 时间线坏一处不能拖垮整段对话。
    if (String(event.type) === 'read/bill-report') {
      const block = billReportBlockOf((event as { data?: unknown }).data)
      if (block !== undefined) this.billReport = block
      return []
    }
    // 风险问卷域事件（C-03）：**是例外，也是必要的例外**。发卷是只读分支，
    // `tool/result` 只有一行文本，卡片没有任何别的承载点；而"用户看到的 5 道题"
    // 必须能逐字回放（否则审批卡上的题目与用户答的题目对不上，确认就失去意义）。
    // 形状不合格就吞掉（宁可不显示，也不显示半张问卷）。
    if (String(event.type) === 'read/risk-questions') {
      const frame = riskQuestionnaireFrameOf(
        (event as { data?: unknown }).data,
        event.seq,
        event.at,
      )
      return frame === undefined ? [] : [frame]
    }
    // 生效档位只在 `tier/decided` 里：`tool/call` 带的是声明档位（红级新收款人声明是黄级）。
    // 这里只回写登记与 DAG，不单独产帧——等下一次 tool/result 用生效档位重画，
    // 同时保持「领域事件不产帧」的既有约定。
    if (String(event.type) === 'tier/decided') {
      const data = event.data as { readonly callId?: unknown; readonly level?: unknown }
      if (typeof data.callId !== 'string' || typeof data.level !== 'string') return []
      const level = data.level as FrameTier
      const record = this.calls.get(data.callId)
      if (record === undefined) return []
      record.tier = level
      this.dag.retier(data.callId, level)
      return []
    }
    switch (event.type) {
      case 'turn/start': {
        this.turn = event.data.turn
        this.previewFees.clear()
        this.previewConfirmed.clear()
        // 订阅快照只在本 turn 有效：跨 turn 复用会把上一轮读到的清单画成这一轮的现况
        this.subscriptions = undefined
        // 报告块同理：上一轮的账单数字不能画在这一轮的工具卡上
        this.billReport = undefined
        return [this.turnFrame(event.seq, event.at, event.data.turn, 'start')]
      }
      case 'turn/end': {
        const end = event.data.reason as TurnEndReason
        const frames: WebFrame[] = [
          {
            ...this.turnFrame(event.seq, event.at, event.data.turn, 'end'),
            endKind: end.kind,
            ...(end.kind === 'guard-stopped' || end.kind === 'failed' ? { reason: end.reason } : {}),
          },
        ]
        frames.push(this.dagFrame(event.data.turn, event.at, event.seq))
        if (end.kind !== 'completed') {
          frames.push({
            kind: 'notice',
            seq: event.seq,
            at: event.at,
            level: noticeLevel(end),
            title: noticeTitle(end),
            ...(end.kind === 'guard-stopped' || end.kind === 'failed' ? { text: end.reason } : {}),
            ...(end.kind === 'guard-stopped' || end.kind === 'failed' ? { code: end.kind } : {}),
          })
        }
        return frames
      }
      case 'step/start': {
        this.step = event.data.step
        this.dag.step(event.data.turn, event.data.step)
        return [this.dagFrame(event.data.turn, event.at, event.seq)]
      }
      case 'tool/call': {
        const data = event.data
        const tier = (data.tier.level ?? 'unknown') as FrameTier
        this.calls.set(data.callId, {
          callId: data.callId,
          name: data.name,
          args: data.args,
          turn: this.turn,
          step: this.step,
          tier,
          state: 'pending',
        })
        this.dag.call(this.turn, this.step, data.callId, data.name, tier)
        return [
          this.toolFrame(data.callId, event.seq, event.at, {
            state: 'pending',
            amountConfirmed: false,
          }),
          this.dagFrame(this.turn, event.at, event.seq),
        ]
      }
      case 'tool/result': {
        const data = event.data
        const record = this.calls.get(data.callId)
        // 审批帧的手续费只能来自预演结果：没有预演就不显示，不从别处猜。
        // 预演成功同时证明「这个收款人 + 金额」在本 turn 被工具看过一眼：
        // 审批帧据此把金额从"待确认"升为已确认（仍要求收款人与金额完全一致）。
        if (data.name === 'transfer_preview' && !data.isError && record !== undefined) {
          const payee = payeeFromArgs(record.args)
          const cents = amountFromArgs(record.args)
          if (payee !== undefined) this.previewConfirmed.add(previewKey(payee, cents))
          const feeText = previewFeeOf(data.content)
          if (payee !== undefined && feeText !== undefined) {
            this.previewFees.set(previewKey(payee, cents), feeText)
          }
        }
        const state: ToolFrame['state'] = data.isError ? 'denied' : 'done'
        if (record !== undefined) record.state = state === 'denied' ? 'denied' : 'done'
        this.dag.settle(data.callId, !data.isError)
        const frames: WebFrame[] = [
          this.toolFrame(data.callId, event.seq, event.at, {
            state,
            amountConfirmed: !data.isError,
            content: data.content,
            ...(data.code === undefined ? {} : { code: data.code }),
            ...(data.reason === undefined ? {} : { reason: data.reason }),
            ...(data.durationMs === undefined ? {} : { durationMs: data.durationMs }),
          }),
          this.dagFrame(record?.turn ?? this.turn, event.at, event.seq),
        ]
        // 03 单 §3.12：prompt_ask 的追问投影成 choice 帧（D6：点选 = 一条普通用户消息）。
        // 帧字段取自 `tool/call` 的 args 而不是 `tool/result`：后者的载荷是投影后的文本
        // （事件载荷冻结，不带出参原文），而 args 是结构化的、且与出参同源。
        // 字面量而不 import interaction：channels 不依赖交互包（包图方向）。
        if (!data.isError && data.name === 'prompt_ask' && record !== undefined) {
          frames.push(this.choiceFrame(data.callId, event.seq, event.at, asArgs(record.args)))
        }
        // ：成功的写操作 → effects 帧（一轮一张清单，累积替换）。
        // 失败（isError）不产：那是"被判停/出错"，不是"已发生的影响"。
        if (!data.isError && record !== undefined) {
          const ticketId = this.ticketOfCall.get(data.callId)
          const candidate: EffectCandidate = {
            callId: data.callId,
            name: data.name,
            tier: record.tier,
            args: record.args,
            ...(data.durationMs === undefined ? {} : { durationMs: data.durationMs }),
            ...(ticketId === undefined ? {} : { ticketId }),
          }
          const bucket = this.effectCandidates.get(record.turn) ?? []
          if (!bucket.some((item) => item.callId === data.callId)) {
            bucket.push(candidate)
            this.effectCandidates.set(record.turn, bucket)
          }
          const effects = projectEffects({
            turn: record.turn,
            seq: event.seq,
            at: event.at,
            items: bucket,
            ...(this.writeToolNames === undefined ? {} : { writeToolNames: this.writeToolNames }),
          })
          if (effects !== null) frames.push(effects)
        }
        // 04 单：goal_set 的成功结果 → `goal` 帧（会话级唯一，frameKey='goal' 替换语义）。
        // 失败调用不投影：一笔写不进去的目标不是"用户的目标"。
        if (!data.isError && data.name === 'goal_set') {
          const goal = goalOf(data.content)
          if (goal !== undefined) {
            frames.push({
              kind: 'goal',
              seq: event.seq,
              at: event.at,
              title: goal.statement,
              status: goal.status,
              ...(goal.amountCents === undefined ? {} : { amountText: formatCents(goal.amountCents) }),
            })
          }
        }
        // G7：计划卡（plan_arm / plan_disarm / plan_wake 的结构化出参 → plan-card 帧）。
        // 投影源是 tool/result 而不是 plan/created：后者保持"不产帧"的既有约定。
        frames.push(...this.projectPlanCard(data.name, data.isError, data.content, event.seq, event.at))
        return frames
      }
      case 'approval/asked': {
        const data = event.data
        const record = this.calls.get(data.callId)
        this.ticketOfCall.set(data.callId, data.ticketId)
        // 风险级别必须与 challenge 一致：红级强验证挑战只为红级签发
        // （`requiresChallenge(level) === level==='red'`），所以"有 challenge"就是红级；
        // 否则沿用登记里已由 `tier/decided` 回写的生效档位（没有判决时才回落到声明级别）。
        const tier: FrameTier = data.challenge === undefined ? (record?.tier ?? 'unknown') : 'red'
        const payee = payeeFromArgs(record?.args)
        const payeePhone = maskedPayeePhoneFromArgs(record?.args)
        // 金额口径：工具参数里的 `amount` 是**元**；`approval/asked.amount`
        // 同为元（bank governance 用 `amountCents / 100` 填票据）。参数缺金额时才退回事件值，
        // 绝不把两种单位混着格式化——￥8.00 与 ￥800.00 的差别就是一次事故。
        const cents =
          amountFromArgs(record?.args) ??
          (typeof data.amount === 'number' ? Math.round(data.amount * 100) : undefined)
        // 同 turn 已有一笔成功的 transfer_preview，且收款人+金额完全一致：
        // 金额数值已有工具结果背书；否则维持"待确认"（不拿 create 自己的参数自证）。
        const key = payee === undefined ? undefined : previewKey(payee, cents)
        const feeText = key === undefined ? undefined : this.previewFees.get(key)
        const amountConfirmed = key !== undefined && this.previewConfirmed.has(key)
        const confirmText = requiredConfirmText(data.name)
        return [
          {
            kind: 'approval',
            seq: event.seq,
            at: event.at,
            ticketId: data.ticketId,
            callId: data.callId,
            name: data.name,
            operation: toolTitle(data.name),
            // 卡片冻结/挂失、订阅取消等非金额操作不带金额：不要渲染成 ¥0.00。
            ...(cents === undefined || cents <= 0 ? {} : { amountText: formatCents(cents) }),
            amountConfirmed,
            ...(payee === undefined ? {} : { payeeName: payee }),
            ...(payeePhone === undefined ? {} : { payeePhone }),
            ...(feeText === undefined ? {} : { feeText }),
            tier,
            // TTL 截止时刻原样透传（不在渠道按 now + ttl 重算：同一份事实只该有一个来源）。
            ...(typeof data.expiresAt === 'number' ? { expiresAt: data.expiresAt } : {}),
            ...(data.challenge === undefined ? {} : { challenge: data.challenge }),
            rejectReasonRequired: true,
            ...(confirmText === undefined ? {} : { confirmText }),
            // 明细原样投影：服务端签发什么就显示什么（金额不在渠道再格式化一次）
            ...projectApprovalDetails(data.details),
          } satisfies ApprovalFrame,
        ]
      }
      case 'approval/decided': {
        const decision = event.data.decision as ApprovalDecision
        return [
          {
            kind: 'approval-closed',
            seq: event.seq,
            at: event.at,
            ticketId: event.data.ticketId,
            decision,
            label: decisionLabel(decision),
            ...(event.data.reason === undefined ? {} : { reason: event.data.reason }),
            ...(event.data.code === undefined ? {} : { code: event.data.code }),
          } satisfies ApprovalClosedFrame,
        ]
      }
      case 'user/message': {
        return [
          {
            kind: 'message',
            seq: event.seq,
            at: event.at,
            role: 'user',
            blocks: [{ type: 'text', text: event.data.content }],
            ...(event.data.source === undefined ? {} : { source: event.data.source }),
          } satisfies MessageFrame,
        ]
      }
      case 'assistant/message': {
        return [
          {
            kind: 'message',
            seq: event.seq,
            at: event.at,
            role: 'assistant',
            blocks: toMessageBlocks(event.data.content),
            ...(event.data.toolCalls === undefined
              ? {}
              : { toolCalls: event.data.toolCalls.map((call) => ({ callId: call.callId, name: call.name })) }),
          } satisfies MessageFrame,
        ]
      }
      case 'assistant/attempt': {
        if (event.data.status === 'retried') return []
        return [
          {
            kind: 'notice',
            seq: event.seq,
            at: event.at,
            level: 'warning',
            title: event.data.status === 'cancelled' ? '模型调用已取消' : '模型调用失败',
            ...(event.data.reason === undefined ? {} : { text: event.data.reason }),
          },
        ]
      }
      case 'compaction/summary': {
        return [
          {
            kind: 'notice',
            seq: event.seq,
            at: event.at,
            level: 'info',
            title: `上下文已压缩（折叠 ${String(event.data.turns)} 轮）`,
            text: event.data.summary,
          },
        ]
      }
      default:
        return []
    }
  }

  /** 轮次帧。 */
  private turnFrame(seq: number, at: number, turn: number, phase: 'start' | 'end'): TurnFrame {
    return { kind: 'turn', seq, at, turn, phase }
  }

  /**
   * `handoff/*` 域事件 → 接管帧 / 人工气泡（人机接管 01）。
   *
   * 两条纪律：
   * 1. **人工发言不进模型历史**由事件层的 `ignorable` 保证，这里只负责画；
   * 2. **认领不重置等待计时**：帧的 `at` 用 `enteredAt`（进入时刻），不是认领时刻。
   */
  private projectHandoff(type: string, event: AnySessionEvent): WebFrame[] {
    const data = event.data as Readonly<Record<string, unknown>>
    const str = (key: string): string | undefined =>
      typeof data[key] === 'string' ? (data[key] as string) : undefined
    const enteredAtOf = (fallback: number): number =>
      typeof data['enteredAt'] === 'number' && Number.isFinite(data['enteredAt'])
        ? data['enteredAt']
        : fallback
    switch (type) {
      case 'handoff/requested':
        return [
          {
            kind: 'handoff',
            seq: event.seq,
            at: event.at,
            active: true,
            ...(str('reason') === undefined ? {} : { reason: str('reason') }),
          },
        ]
      case 'handoff/claimed':
        return [
          {
            kind: 'handoff',
            seq: event.seq,
            at: enteredAtOf(event.at),
            active: true,
            ...(str('operator') === undefined ? {} : { operator: str('operator') }),
          },
        ]
      case 'handoff/operator-message': {
        const text = str('text') ?? ''
        // 空文本不产帧（状态机已拒，这里是第二道防线）
        if (text === '') return []
        return [
          {
            kind: 'message',
            seq: event.seq,
            at: event.at,
            role: 'operator',
            blocks: [{ type: 'text', text }],
            ...(str('operator') === undefined ? {} : { operator: str('operator') }),
          },
        ]
      }
      case 'handoff/timeout-warned':
        return [
          {
            kind: 'handoff-warn',
            seq: event.seq,
            at: event.at,
            waitedMs: typeof data['waitedMs'] === 'number' ? data['waitedMs'] : 0,
            slaMs: typeof data['slaMs'] === 'number' ? data['slaMs'] : 0,
          },
        ]
      case 'handoff/resumed':
        return [
          {
            kind: 'handoff',
            seq: event.seq,
            at: event.at,
            active: false,
            ...(str('operator') === undefined ? {} : { operator: str('operator') }),
          },
        ]
      default:
        return []
    }
  }

  /**
   * plan/* 域事件 → plan 节点图（B2）。
   *
   * 只消费能改变节点状态/图的五个键：`node-started` / `node-result` / `node-blocked` /
   * `aborted` / `completed`。`plan/created` / `plan/resumed` 不产帧——它们没有节点态，
   * 节点要等 `node-started` 才有 tool 与 ordinal；提前画空框只会制造噪音。
   */
  private projectPlan(type: string, event: AnySessionEvent): WebFrame[] {
    const data = event.data as Readonly<Record<string, unknown>>
    const planId = typeof data['planId'] === 'string' ? data['planId'] : ''
    if (planId === '') return []
    const nodeId = typeof data['nodeId'] === 'string' ? data['nodeId'] : ''
    switch (type) {
      case 'plan/node-started': {
        const tool = typeof data['tool'] === 'string' ? data['tool'] : 'unknown'
        const ordinal = typeof data['ordinal'] === 'number' ? data['ordinal'] : 0
        this.dag.planNode(this.turn, planId, nodeId, tool, ordinal)
        break
      }
      case 'plan/node-result': {
        const status = typeof data['status'] === 'string' ? data['status'] : ''
        const code = typeof data['code'] === 'string' ? data['code'] : undefined
        this.dag.planSettle(this.turn, planId, nodeId, status, code)
        break
      }
      case 'plan/node-blocked': {
        const raw = data['blockedBy']
        const blockedBy = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
        // `DagNode` 没有该字段（本设计不改它），但 todo 帧要带 ⇒ 在这里留一份，
        // 键与 `dag.ts` 的 `planNodeId`（`plan:<planId>:<nodeId>`）同构。
        this.blockedBy.set(`plan:${planId}:${nodeId}`, blockedBy)
        this.dag.planSettle(this.turn, planId, nodeId, 'blocked', undefined, blockedBy)
        break
      }
      case 'plan/aborted': {
        this.dag.planAbort(this.turn, planId)
        break
      }
      // plan/completed：收尾帧（summary 里带上成功/失败/阻断计数）
      default:
        break
    }
    const dag = this.dagFrame(this.turn, event.at, event.seq)
    const frames: WebFrame[] = [dag]
    // ：本 turn 有 plan 节点时同步产出 todo 帧（派生，不落账，D8）。
    // 无节点 ⇒ projectTodo 返回 null ⇒ 不产空清单（不造假清单）。
    const todo = projectTodo({
      turn: this.turn,
      seq: event.seq,
      at: event.at,
      planId,
      nodes: dag.nodes,
      blockedBy: Object.fromEntries(this.blockedBy),
    })
    if (todo !== null) frames.push(todo)
    return frames
  }

  /** DAG 帧（无节点时返回一个空帧？不——返回 `undefined` 由调用方过滤）。 */
  private dagFrame(turn: number, at: number, seq: number): DagFrame {
    return (
      this.dag.frame(turn, at, seq) ?? {
        kind: 'dag',
        seq,
        at,
        turn,
        nodes: [],
        edges: [],
        summary: `第 ${String(turn)} 轮 · 尚无调用`,
      }
    )
  }

  /** 构造/更新工具帧。 */
  /**
   * `prompt_ask` → `choice` 帧。
   *
   * `allowFreeText` 恒 true（收窄成字面量）：D6 要求「不选，直接说别的」永远可用。
   * 手动输入出口由前端固定渲染（02 单 choice-card），不占 options：它不是候选，
   * 是"三个都不对"时的出口。
   */
  private choiceFrame(
    callId: string,
    seq: number,
    at: number,
    args: Readonly<Record<string, unknown>>,
  ): ChoiceFrame {
    const question = typeof args['question'] === 'string' ? args['question'] : ''
    const raw = Array.isArray(args['candidates']) ? args['candidates'] : []
    const options: ChoiceOption[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const label = record['label']
      const value = record['value']
      // 非字符串一律丢弃（工具层已 fail-loud；这里是投影层的最后一道形状检查）
      if (typeof label !== 'string' || typeof value !== 'string') continue
      options.push({ id: value, label })
      if (options.length === MAX_CHOICE_OPTIONS) break
    }
    return { kind: 'choice', seq, at, callId, prompt: question, options, allowFreeText: true }
  }

  private toolFrame(
    callId: string,
    seq: number,
    at: number,
    update: {
      readonly state: ToolFrame['state']
      readonly amountConfirmed: boolean
      readonly content?: readonly { type: string; text?: string; mimeType?: string }[]
      readonly code?: string
      readonly reason?: string
      readonly durationMs?: number
    },
  ): ToolFrame {
    const record = this.calls.get(callId)
    const name = record?.name ?? callId
    // 「即将扣款」只挂在 sub_list 的**成功结果**上：待执行帧还没有数据，失败帧说明这次没读到。
    const upcoming =
      name === 'sub_list' && update.state === 'done' && this.subscriptions !== undefined
        ? upcomingBlockOf(this.subscriptions)
        : undefined
    // AA 收款进度只挂在 `aa_create` 的成功结果上：待执行帧还没数据，失败帧说明这次没收到。
    const aa =
      name === 'aa_create' && update.state === 'done' && this.aaProgress !== undefined
        ? this.aaProgress
        : undefined
    // 账单报告的表格只挂在 `bill_report` 的**成功结果**上：`execute()` 先落 `read/bill-report`，
    // 紧接着的 `tool/result` 才画卡，所以这里读的是本轮同一次查询的数字。
    const billReport =
      name === 'bill_report' && update.state === 'done' ? this.billReport : undefined
    const card = buildCard({
      name,
      args: record?.args,
      content: update.content ?? [],
      isError: update.state === 'denied',
      amountConfirmed: update.amountConfirmed,
      ...(update.code === undefined ? {} : { code: update.code }),
      ...(upcoming === undefined ? {} : { upcoming }),
      ...(aa === undefined ? {} : { aa }),
      ...(billReport === undefined ? {} : { billReport }),
    })

    return {
      kind: 'tool',
      seq,
      at,
      callId,
      name,
      title: toolTitle(name),
      state: update.state,
      ...(update.state === 'denied' ? { reasonKind: reasonKindOf(update.code) } : {}),
      tier: record?.tier ?? 'unknown',
      amountConfirmed: update.amountConfirmed,
      card,
      ...(update.code === undefined ? {} : { code: update.code }),
      ...(update.reason === undefined ? {} : { reason: update.reason }),
      ...(update.durationMs === undefined ? {} : { durationMs: update.durationMs }),
    }
  }

  /** 计划卡（G7）：窗口 → 卡片；撤销与唤醒都是替换语义。 */
  private planCards = new Map<string, PlanCardFrame>()

  /**
   * `plan_arm` / `plan_disarm` / `plan_wake` 的 `tool/result` → 计划卡。
   *
   * 只认结构化出参（与事件里的 JSON 同源）：失败调用不投影；找不到对应窗口的
   * 唤醒条目也不凭空造卡（宁可少一张，不造一张假的）。
   */
  private projectPlanCard(
    name: string,
    isError: boolean,
    content: readonly { readonly type: string; readonly text?: string }[],
    seq: number,
    at: number,
  ): WebFrame[] {
    if (isError) return []
    if (name !== 'plan_arm' && name !== 'plan_disarm' && name !== 'plan_wake') return []
    const payload = jsonObjectOf(content)
    if (payload === undefined) return []

    if (name === 'plan_arm') {
      const card = planCardOf(payload, seq, at)
      if (card === undefined) return []
      this.planCards.set(card.windowId, card)
      return [card]
    }

    if (name === 'plan_disarm') {
      const windowId = typeof payload['windowId'] === 'string' ? payload['windowId'] : undefined
      const existing = windowId === undefined ? undefined : this.planCards.get(windowId)
      if (existing === undefined) return []
      const updated: PlanCardFrame = { ...existing, seq, at, state: 'cancelled' }
      this.planCards.set(updated.windowId, updated)
      return [updated]
    }

    const entries = Array.isArray(payload['entries']) ? payload['entries'] : []
    const frames: PlanCardFrame[] = []
    for (const raw of entries) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const entry = raw as Readonly<Record<string, unknown>>
      const windowId = typeof entry['windowId'] === 'string' ? entry['windowId'] : undefined
      const existing = windowId === undefined ? undefined : this.planCards.get(windowId)
      if (existing === undefined) continue
      const status = typeof entry['status'] === 'string' ? entry['status'] : ''
      const summary =
        typeof entry['summary'] === 'object' && entry['summary'] !== null
          ? (entry['summary'] as Readonly<Record<string, unknown>>)
          : undefined
      const failedCount = summary !== undefined && typeof summary['failed'] === 'number' ? summary['failed'] : 0
      const blockedCount =
        summary !== undefined && typeof summary['blocked'] === 'number' ? summary['blocked'] : 0
      const merchant = typeof entry['merchant'] === 'object' && entry['merchant'] !== null
        ? (entry['merchant'] as Readonly<Record<string, unknown>>)
        : undefined
      const merchantFailed = typeof merchant?.['status'] === 'string' && merchant['status'] !== 'ok'
      const compensation = compensationOf(entry['compensation'])
      const code = typeof entry['code'] === 'string' ? entry['code'] : undefined
      /**
       * 失守的三种终态（提示词 4-2）：
       * - `window-expired` → `expired`：过期即终止，不是"失败"，也不会补扣；
       * - `details-changed` / `condition-failed` → `needs-reconfirm`：还来得及，但要用户重新确认；
       * - 其它 → `failed`（档位不允许 / 执行失败）。
       */
      const verdictState: PlanCardFrame['state'] =
        code === 'window-expired'
          ? 'expired'
          : code === 'details-changed' || code === 'condition-failed'
            ? 'needs-reconfirm'
            : 'failed'
      const nextState: PlanCardFrame['state'] =
        status === 'executed'
          ? failedCount > 0 || blockedCount > 0 || merchantFailed || compensation !== undefined
            ? 'failed'
            : 'done'
          : status === 'downgraded' || status === 'failed'
            ? verdictState
            : existing.state
      const updated: PlanCardFrame = {
        ...existing,
        seq,
        at,
        state: nextState,
        conditions: markFailedConditions(existing.conditions, entry['failed']),
        ...(code === undefined ? {} : { lastVerdict: { code, at } }),
        ...(compensation === undefined ? {} : { compensation }),
      }
      this.planCards.set(updated.windowId, updated)
      frames.push(updated)
    }
    return frames
  }

  /** 按稳定键替换或追加（三态更新与 DAG 更新的基础）。 */
  private upsert(frame: WebFrame): void {
    if (frame.kind === 'delta' || frame.kind === 'snapshot') return
    const key = frameKey(frame)
    const at = this.index.get(key)
    if (at === undefined) {
      this.index.set(key, this.list.length)
      this.list.push(frame)
      return
    }
    this.list[at] = frame
  }
}

/** 工具结果正文 → JSON 对象（计划卡的投影源；坏 JSON 一律不投影）。 */
function jsonObjectOf(
  content: readonly { readonly type: string; readonly text?: string }[],
): Readonly<Record<string, unknown>> | undefined {
  const text = content.find((block) => block.type === 'text')
  if (text === undefined || text.text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.text)
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Readonly<Record<string, unknown>>)
    : undefined
}

/** 条件 → 可读期望值（与 runtime `checkWindow` 的失败文案同口径）。 */
function conditionExpected(condition: Readonly<Record<string, unknown>>): string {
  const kind = typeof condition['kind'] === 'string' ? condition['kind'] : 'unknown'
  switch (kind) {
    case 'balance-at-least':
      return `>= ${String(condition['cents'])}`
    case 'amount-within':
      return `<= ${String(condition['cents'])}`
    case 'fact-unchanged':
      return `${String(condition['factId'])}@${String(condition['version'])}`
    case 'address-unchanged':
      return `${String(condition['addressId'])}@${String(condition['version'])}`
    case 'plan-not-cancelled':
      return '未被撤销'
    default:
      return kind
  }
}

/** 出参里的 `recurrence` 是否像一条合法周期规则（投影层的最后一道形状检查）。 */
function isRecurrence(value: unknown): value is Parameters<typeof occurrenceOf>[0] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const every = (value as Readonly<Record<string, unknown>>)['every']
  return every === 'once' || every === 'daily' || every === 'monthly' || every === 'yearly'
}

/** `plan_arm` 出参（ArmedPlan JSON）→ 计划卡。 */
function planCardOf(
  payload: Readonly<Record<string, unknown>>,
  seq: number,
  at: number,
): PlanCardFrame | undefined {
  const windowId = typeof payload['windowId'] === 'string' ? payload['windowId'] : undefined
  const planId = typeof payload['planId'] === 'string' ? payload['planId'] : undefined
  const dueAt = typeof payload['dueAt'] === 'number' ? payload['dueAt'] : undefined
  const budgetCents = typeof payload['budgetCents'] === 'number' ? payload['budgetCents'] : undefined
  const digest = typeof payload['planDigest'] === 'string' ? payload['planDigest'] : undefined
  if (windowId === undefined || planId === undefined || dueAt === undefined || digest === undefined) {
    return undefined
  }
  const tier =
    payload['tier'] === 'strict' || payload['tier'] === 'standard' || payload['tier'] === 'wide'
      ? payload['tier']
      : 'standard'
  const plan = typeof payload['plan'] === 'object' && payload['plan'] !== null
    ? (payload['plan'] as Readonly<Record<string, unknown>>)
    : undefined
  const nodes = plan !== undefined && Array.isArray(plan['nodes']) ? plan['nodes'] : []
  const conditions = Array.isArray(payload['conditions']) ? payload['conditions'] : []
  const cardConditions: PlanCardCondition[] = []
  for (const raw of conditions) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const condition = raw as Readonly<Record<string, unknown>>
    cardConditions.push({
      kind: String(condition['kind'] ?? 'unknown'),
      expected: conditionExpected(condition),
      state: 'unknown',
    })
  }
  return {
    kind: 'plan-card',
    seq,
    at,
    windowId,
    planId,
    title: typeof payload['title'] === 'string' ? payload['title'] : planId,
    tier,
    budgetText: formatCents(budgetCents ?? 0),
    dueAt,
    // 实例键是 (recurrence, dueAt) 的纯函数：投影层自己算，不依赖工具出参里的冗余字段
    occurrence:
      typeof payload['occurrence'] === 'string'
        ? payload['occurrence']
        : occurrenceOf(
            isRecurrence(payload['recurrence']) ? payload['recurrence'] : { every: 'once', dueAt },
            dueAt,
          ),
    state: 'armed',
    conditions: cardConditions,
    nodeCount: nodes.length,
    digest,
  }
}

/**
 * 唤醒条目的补偿 → 计划卡字段（ADR-0013）。
 *
 * 只认三种封闭值；金额/流水号能取到就带，取不到就不写（不编 0）。
 */
function compensationOf(raw: unknown): PlanCardFrame['compensation'] | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Readonly<Record<string, unknown>>
  const kind = record['kind']
  if (kind !== 'reversed' && kind !== 'reversal-failed' && kind !== 'reversal-unavailable') {
    return undefined
  }
  return {
    kind,
    ...(typeof record['txnId'] === 'string' ? { txnId: record['txnId'] } : {}),
    ...(typeof record['reversalTxnId'] === 'string'
      ? { reversalTxnId: record['reversalTxnId'] }
      : {}),
    ...(typeof record['amountCents'] === 'number' ? { amountCents: record['amountCents'] } : {}),
    ...(typeof record['code'] === 'string' ? { code: record['code'] } : {}),
  }
}

/** 唤醒失守明细 → 把对应条件标成 `failed`（带实际值）。 */
function markFailedConditions(
  conditions: readonly PlanCardCondition[],
  raw: unknown,
): readonly PlanCardCondition[] {
  if (!Array.isArray(raw)) return conditions
  const failures = new Map<string, string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Readonly<Record<string, unknown>>
    const kind = typeof record['kind'] === 'string' ? record['kind'] : undefined
    if (kind === undefined) continue
    failures.set(kind, typeof record['actual'] === 'string' ? record['actual'] : '')
  }
  if (failures.size === 0) return conditions
  return conditions.map((condition) =>
    failures.has(condition.kind)
      ? { ...condition, state: 'failed' as const, actual: failures.get(condition.kind) ?? '' }
      : condition,
  )
}

/** 审批结论 → 中文文案。 */
export function decisionLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case 'allowed-once':
      return '已批准（一次性）'
    case 'rejected':
      return '已拒绝'
    case 'cancelled':
      return '已取消'
    case 'unavailable':
      return '无人应答（视为拒绝）'
    default:
      return assertNever(decision, 'approval-decision')
  }
}

/**
 * 一次性归约（快照 / 回放 / 测试都用它）。
 *
 * @param events 会话日志（按 `seq` 升序；乱序会因幂等过滤而被丢弃，调用方负责排序）
 */
export function projectSession(
  events: readonly AnySessionEvent[],
  sessionId = 'session',
): { frames: readonly WebFrame[]; maxSeq: number; snapshot: SnapshotFrame } {
  const projector = new WebProjector()
  for (const event of events) projector.apply(event)
  return {
    frames: projector.frames(),
    maxSeq: projector.maxSeq(),
    snapshot: projector.snapshot(sessionId),
  }
}

/** 流式增量帧（ephemeral；不占 `seq`，不落账）。 */
export function deltaFrame(text: string, at: number): DeltaFrame {
  return { kind: 'delta', at, text }
}

/** 工具入参在本文件里只当只读记录用（事件载荷的形状由管线保证）。 */
function asArgs(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

/** 前端一屏最多三个业务候选（02 单 choice-card 的布局约束；manual 出口不占位）。 */
const MAX_CHOICE_OPTIONS = 3

/** 金额文本 / 格式化（插件与测试复用同一份实现，禁止各算一套）。 */
export { amountText } from './amount.ts'
export { formatCents } from './format.ts'

/** 卡片视图的类型别名（视图层用）。 */
export type { CardView }
