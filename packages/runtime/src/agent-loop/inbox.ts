/**
 * Inbox：外部输入的认领队列（施工单 04 §3「输入队列」）。
 *
 * 两条车道，语义不同（混成一条会让"转向"变成"新 turn"）：
 *
 * | 车道 | 谁进 | 谁认领 |
 * |---|---|---|
 * | `next-turn` | `agent.send(text)` | 新 turn 的**第一个** step |
 * | `next-step` | `agent.steer(text)` | 当前 turn 的**后续** step（当前 step 完成后立刻认领） |
 *
 * `wakeDriver()` 是常驻驱动的唤入口：`drive()` 空队列时挂在 `waitForInput()` 上，
 * 任何入队都会把它叫醒（施工单 04 §3「`hasPending` 驱动 `wakeDriver()`」）。
 *
 * 纪律：
 * - 消息**取走即离开队列**（`claim` 是唯一取出方式），reject 也不再放回——
 *   "入口拒绝"就是这次输入没有被接受，悄悄塞回去会让拒绝看起来没发生；
 * - 空白文本不入队（不制造空事件）；
 * - 队列关闭后拒绝新输入（宿主 dispose 之后还在 `send` 是调用方的 bug）。
 */

import { BahError } from '@bah/util'

import type { UserMessageSource } from '../session/types.ts'

/** 认领目标（= 车道）。 */
export type InboxTarget = 'next-turn' | 'next-step'

/**
 * 待处理消息的默认上限（D1）。
 *
 * 为什么要有：两条车道都是无界数组，`agent.send` 是**同步入队**，
 * HTTP 侧没有背压——一个循环脚本能在 driver 跑完上一轮之前把内存堆满。
 * 64 条远大于"一个人打字"的正常量（演示里通常 1–3 条），
 * 触到上限只可能是程序在刷，此时拒绝比排队更诚实。
 */
export const DEFAULT_MAX_PENDING = 64

/** 入队选项。 */
export interface SendOptions {
  /** 来源标记（默认 `user`；工具纠正文本用 `context`，运行时上下文用 `runtime-context`）。 */
  readonly source?: UserMessageSource
  /** 目标车道（默认 `next-turn`）。 */
  readonly target?: InboxTarget
}

/** 队列里的一条消息（认领前）。 */
export interface InboxMessage {
  /** 已 trim 的文本（空白文本不入队）。 */
  readonly text: string
  /** 来源标记（落账为 `user/message.source`）。 */
  readonly source: UserMessageSource
  /** 入队时所在的车道。 */
  readonly target: InboxTarget
  /** 入队时刻（epoch ms；测试注入确定性时钟）。 */
  readonly at: number
}

/** 一次认领的结果。 */
export interface InboxClaim {
  readonly target: InboxTarget
  readonly turn: number
  /** 认领到的消息（FIFO；可能为空）。 */
  readonly messages: readonly InboxMessage[]
}

/** 构造选项。 */
export interface InboxOptions {
  /** 时间戳来源（默认 `Date.now`）。 */
  readonly now?: () => number
  /** 待处理上限（默认 `DEFAULT_MAX_PENDING`；只对**新入队**生效，不影响已入队消息）。 */
  readonly maxPending?: number
}

export class Inbox {
  /** `next-turn` 车道。 */
  private readonly turnLane: InboxMessage[] = []

  /** `next-step` 车道（转向）。 */
  private readonly stepLane: InboxMessage[] = []

  /** `waitForInput()` 的挂起者（`drive()` 空闲时在这上面等）。 */
  private readonly waiters: (() => void)[] = []

  private readonly now: () => number

  private readonly maxPending: number

  private wakes = 0

  private closed = false

  constructor(options: InboxOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
  }

  /**
   * 入队一条消息。
   *
   * @throws `BahError('inbox-full')` 待处理条数已达上限（调用方在刷；拒绝而不是无界排队）
   * @throws `BahError('inbox-closed')` 队列已关闭（宿主已 dispose）
   */
  send(text: string, options: SendOptions = {}): void {
    if (this.closed) {
      throw new BahError('inbox-closed', 'inbox: 队列已关闭，拒绝新的输入（agent 已 dispose）')
    }
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    if (this.pending >= this.maxPending) {
      throw new BahError(
        'inbox-full',
        `inbox: 待处理消息已达上限 ${String(this.maxPending)} 条，拒绝新的输入（队列没有背压，只能拒绝）`,
        { pending: this.pending, maxPending: this.maxPending },
      )
    }

    const message: InboxMessage = {
      text: trimmed,
      source: options.source ?? 'user',
      target: options.target ?? 'next-turn',
      at: this.now(),
    }
    this.laneOf(message.target).push(message)
    this.wakeDriver()
  }

  /**
   * 认领某车道的全部待处理消息（取走即离队）。
   *
   * @param target 车道
   * @param turn 认领发生的 turn（原样写进结果，供审计与断言；不参与筛选）
   */
  claim(target: InboxTarget, turn: number): InboxClaim {
    const lane = this.laneOf(target)
    const messages = lane.splice(0, lane.length)
    return { target, turn, messages }
  }

  /** `next-step` 车道的只读视图（伪代码里 `inbox.nextStep.length === 0` 的读口）。 */
  get nextStep(): readonly InboxMessage[] {
    return [...this.stepLane]
  }

  /** 两条车道合计的待处理条数。 */
  get pending(): number {
    return this.turnLane.length + this.stepLane.length
  }

  /** `wakeDriver()` 被调用的次数（测试与审计用：证明"空队列被叫醒"确实发生过）。 */
  get wakeCount(): number {
    return this.wakes
  }

  /** 队列是否已关闭。 */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * 是否有待处理消息。
   *
   * @param target 只查某条车道（缺省 = 任一车道非空）
   */
  hasPending(target?: InboxTarget): boolean {
    if (target === 'next-turn') return this.turnLane.length > 0
    if (target === 'next-step') return this.stepLane.length > 0
    return this.pending > 0
  }

  /**
   * 下一次认领的首选车道：优先 `next-turn`，其次 `next-step`，都没有时按 `next-turn`。
   *
   * 为什么这样排：有新 turn 的入口消息时理应开新 turn；只有转向消息（例如上一轮
   * 结束时到达的 steer）时才退化为"用一次 turn 把转向消息消费掉"。
   */
  preferredTarget(): InboxTarget {
    if (this.hasPending('next-turn')) return 'next-turn'
    if (this.hasPending('next-step')) return 'next-step'
    return 'next-turn'
  }

  /** 唤醒挂起的 driver（入队、关闭时调用；无挂起者时只是计数 +1）。 */
  wakeDriver(): void {
    this.wakes += 1
    const waiters = this.waiters.splice(0, this.waiters.length)
    for (const wake of waiters) wake()
  }

  /**
   * 等下一批输入：已有待处理消息或已关闭时立即返回，否则挂起直到 `wakeDriver()`。
   *
   * 只给 `drive()` 用——它返回时**不保证**有消息（可能是关闭唤醒），调用方必须自己复查。
   */
  waitForInput(): Promise<void> {
    if (this.closed || this.hasPending()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /** 关闭队列：清空两条车道并唤醒挂起的 driver（让其退出循环）。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.turnLane.length = 0
    this.stepLane.length = 0
    this.wakeDriver()
  }

  /** 车道寻址。 */
  private laneOf(target: InboxTarget): InboxMessage[] {
    return target === 'next-turn' ? this.turnLane : this.stepLane
  }
}
