/**
 * 会话事件 → 帧 的**唯一归约器**（施工单 13 §2「前端只消费事件与卡片数据」）。
 *
 * 三条不变量（测试按此断言）：
 * 1. **纯**：不读时钟、不读随机、不读 DOM；同一串事件两次归约必须深度相等（T-WEB-007）；
 * 2. **幂等**：`seq` 单调过滤，重复喂同一条事件不产生第二帧（T-WEB-001 的"不重"）；
 * 3. **可追**：每帧都带 `seq`（`delta` 例外），审计面板每条都能回跳日志。
 *
 * 归约而不是"视图各自推导"：五个视图共享同一份事实，防止某条事件只在一个视图里出错。
 */

import { assertNever } from '@bah/util'

import type { AnySessionEvent, ApprovalDecision, TurnEndReason } from '@bah/runtime'

import type {
  ApprovalClosedFrame,
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
  readonly tier: FrameTier
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
 * 映射口径（施工单 01 §3.5）：
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
 * 写操作用**双判据**（施工单 01 §9 V3：`tool/result` 载荷里没有 `sideEffect`，而
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

/** `WebProjector` 的可选注入口（施工单 01 §3.5）。 */
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
  private readonly dag = new DagBuilder()
  /** `plan/node-blocked.blockedBy`，键 = `DagNode.id`（`dag.ts` 的 `plan:` 前缀形态）。 */
  private readonly blockedBy = new Map<string, readonly string[]>()
  /** 每个 turn 的写操作候选（`effects` 帧累积替换用）。 */
  private readonly effectCandidates = new Map<number, EffectCandidate[]>()
  /** `tool/call.callId` → 审批票号（`effects` 帧的可选 `ticketId`）。 */
  private readonly ticketOfCall = new Map<string, string>()
  private readonly writeToolNames?: readonly string[]
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
    switch (event.type) {
      case 'turn/start': {
        this.turn = event.data.turn
        this.previewFees.clear()
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
        // 审批帧的手续费只能来自预演结果：没有预演就不显示，不从别处猜
        if (data.name === 'transfer_preview' && !data.isError && record !== undefined) {
          const payee = payeeFromArgs(record.args)
          const cents = amountFromArgs(record.args)
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
        // 施工单 01 §3.5：成功的写操作 → effects 帧（一轮一张清单，累积替换）。
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
        return frames
      }
      case 'approval/asked': {
        const data = event.data
        const record = this.calls.get(data.callId)
        this.ticketOfCall.set(data.callId, data.ticketId)
        const tier: FrameTier = record?.tier ?? 'unknown'
        const payee = payeeFromArgs(record?.args)
        const payeePhone = maskedPayeePhoneFromArgs(record?.args)
        const feeText =
          payee === undefined
            ? undefined
            : this.previewFees.get(previewKey(payee, amountFromArgs(record?.args)))
        // 金额口径：工具参数里的 `amount` 是**元**（施工单 08）；`approval/asked.amount`
        // 同为元（bank governance 用 `amountCents / 100` 填票据）。参数缺金额时才退回事件值，
        // 绝不把两种单位混着格式化——￥8.00 与 ￥800.00 的差别就是一次事故。
        const cents =
          amountFromArgs(record?.args) ??
          (typeof data.amount === 'number' ? Math.round(data.amount * 100) : undefined)
        return [
          {
            kind: 'approval',
            seq: event.seq,
            at: event.at,
            ticketId: data.ticketId,
            callId: data.callId,
            name: data.name,
            operation: toolTitle(data.name),
            ...(cents === undefined ? {} : { amountText: formatCents(cents) }),
            amountConfirmed: false,
            ...(payee === undefined ? {} : { payeeName: payee }),
            ...(payeePhone === undefined ? {} : { payeePhone }),
            ...(feeText === undefined ? {} : { feeText }),
            tier,
            ...(data.challenge === undefined ? {} : { challenge: data.challenge }),
            rejectReasonRequired: true,
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
        // `DagNode` 没有该字段（本单不改它），但 todo 帧要带 ⇒ 在这里留一份，
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
    // 施工单 01 §3.5：本 turn 有 plan 节点时同步产出 todo 帧（派生，不落账，D8）。
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
    const card = buildCard({
      name,
      args: record?.args,
      content: update.content ?? [],
      isError: update.state === 'denied',
      amountConfirmed: update.amountConfirmed,
      ...(update.code === undefined ? {} : { code: update.code }),
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
