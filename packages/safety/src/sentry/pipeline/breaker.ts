/**
 * 断路器锁存。
 *
 * 语义（与内核一致、内核不改）：窗口内拒绝数 ≥ 阈值 → **锁存冻结**。
 * `windowSeconds` 只是拒绝计数的滑动窗口——窗口滑出会让**计数**衰减，
 * 但**不是解冻计时器**：冻结一旦锁存即与时间无关，只能由显式人工命令解除。
 *
 * 冻结时吊销全部在途票据：委托注入的 `revokeTickets` 端口（唯一属主仍是 bank-core）。
 * 本类只发事件 / 落 TraceLog，不自己改任何票据状态。
 */

import { Breaker } from '../kernel/index.ts'
import type { TraceLog } from '../kernel/index.ts'

import type { SentryBreakerSettings } from './config.ts'
import type { SentrySessionEventType } from './events.ts'
import type { SentryState } from './state.ts'

/** `SentryBreaker` 的装配参数。 */
export interface SentryBreakerOptions {
  /** 会话 ID（审计分桶与事件载荷）。 */
  readonly sessionId: string
  readonly settings: SentryBreakerSettings
  readonly state: SentryState
  /** 时钟（注入；窗口判定必须可确定钉住）。 */
  readonly now: () => number
  readonly trace: TraceLog
  /** durable 事件出口（宿主以 `ignorable: true` 落账）。 */
  readonly record: (type: SentrySessionEventType, data: unknown) => void
  /** 吊销全部在途票据，返回吊销条数（属主：bank-core）。 */
  readonly revokeTickets: (reason: string, at: number) => number
}

/**
 * 会话级断路器（内核 `Breaker` + 落账 + 票据吊销）。
 */
export class SentryBreaker {
  private readonly kernel: Breaker
  private readonly sessionId: string
  private readonly settings: SentryBreakerSettings
  private readonly state: SentryState
  private readonly trace: TraceLog
  private readonly record: (type: SentrySessionEventType, data: unknown) => void
  private readonly revokeTickets: (reason: string, at: number) => number

  constructor(options: SentryBreakerOptions) {
    this.kernel = new Breaker({
      denyThreshold: options.settings.denyThreshold,
      windowSeconds: options.settings.windowSeconds,
      now: options.now,
    })
    this.sessionId = options.sessionId
    this.settings = options.settings
    this.state = options.state
    this.trace = options.trace
    this.record = options.record
    this.revokeTickets = options.revokeTickets
  }

  /** 是否处于锁存冻结（与窗口无关）。 */
  get frozen(): boolean {
    return this.kernel.tripped
  }

  /** 窗口内拒绝数（读时剪枝；审计/用例观察用）。 */
  countInWindow(at: number): number {
    return this.kernel.countInWindow(at)
  }

  /**
   * 记录一次拒绝。
   *
   * @param callId 调用 ID（同一次调用只计一次：`tier/decided` 与 `tool/result` 都会报）
   * @param at 拒绝时刻（毫秒；显式注入，禁止读真实时钟）
   * @returns 本次是否"刚刚触发"冻结
   */
  recordDeny(callId: string, at: number): boolean {
    if (!this.state.markDeny(callId)) return false
    const tripped = this.kernel.recordDeny(at)
    if (tripped) this.freeze('deny-threshold', at)
    return tripped
  }

  /**
   * 显式人工解冻（**唯一**解除路径）。
   *
   * @param by 操作人（渠道 / 坐席 / 运维）
   * @param reason 可读理由（落审计）
   * @param at 操作时刻（毫秒；显式注入）
   * @returns 本次是否真的解除了一次冻结（未冻结时是幂等 no-op）
   */
  unfreeze(by: string, reason: string, at: number): boolean {
    if (!this.kernel.tripped) return false
    this.kernel.tripped = false
    this.kernel.denies.length = 0
    this.record('sentry/unfrozen', { sessionId: this.sessionId, by, reason, at })
    this.trace.append({ session: this.sessionId, kind: 'breaker-unfrozen', by, reason, at })
    return true
  }

  /** 锁存冻结：落账 + 吊销票据（内核保证一次冻结只触发一次）。 */
  private freeze(reason: string, at: number): void {
    const ticketsRevoked = this.settings.revokeTickets
      ? this.revokeTickets('sentry-breaker-frozen', at)
      : 0
    const denies = this.kernel.countInWindow(at)
    this.trace.bump('breakerTrips')
    this.trace.append({
      session: this.sessionId,
      kind: 'breaker-frozen',
      reason,
      denies,
      windowSeconds: this.settings.windowSeconds,
      ticketsRevoked,
      at,
    })
    this.record('sentry/breaker-frozen', {
      sessionId: this.sessionId,
      denies,
      windowSeconds: this.settings.windowSeconds,
      ticketsRevoked,
      reason,
      at,
    })
  }
}
