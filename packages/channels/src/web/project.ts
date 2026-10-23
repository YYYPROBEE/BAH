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
  DeltaFrame,
  FrameTier,
  MessageBlock,
  MessageFrame,
  NoticeFrame,
  SnapshotFrame,
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

/** 结束原因 → 提示级别。 */
function noticeLevel(end: TurnEndReason): NoticeFrame['level'] {
  switch (end.kind) {
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

/** Web 事件投影器（一对一实例；`frames()` 是只读视图）。 */
export class WebProjector {
  private readonly list: WebFrame[] = []
  private readonly index = new Map<string, number>()
  private readonly calls = new Map<string, CallRecord>()
  /** 本 turn 预演结果里的手续费（按收款人姓名），供审批帧显示。 */
  private readonly previewFees = new Map<string, string>()
  private readonly dag = new DagBuilder()
  private last = 0
  private turn = 0
  private step = 0

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
        return [
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
      }
      case 'approval/asked': {
        const data = event.data
        const record = this.calls.get(data.callId)
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
      ...(update.state === 'denied'
        ? { reasonKind: update.code === undefined ? ('failed' as const) : ('denied' as const) }
        : {}),
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

/** 金额文本 / 格式化（插件与测试复用同一份实现，禁止各算一套）。 */
export { amountText } from './amount.ts'
export { formatCents } from './format.ts'

/** 卡片视图的类型别名（视图层用）。 */
export type { CardView }
