/**
 * 中断：每个 turn 一个 `AbortController`（施工单 04 §3「中断」）。
 *
 * 三条硬规则：
 * 1. **一个 turn 一个 controller**：新 turn 换新的，旧 latch 立刻失效——
 *    否则"上一轮按过停"会让下一轮一开始就处于取消态；
 * 2. `interrupt()` 只影响**当前** turn；没有 turn 在跑时是无操作（不排队、不抛错）；
 * 3. 取消信号必须传到 `adapter.stream(call, signal)`（施工单 04 §3），
 *    由 provider 决定在哪一处分片边界收尾。
 *
 * 为什么单独成类（而不是主循环里的两个字段）：`turn/end` 之后要能验证"旧信号已失效"，
 * 这需要一个可观察的 generation 计数，测试与审计都要看它。
 */

/** 永不取消的信号（没有 turn 在跑时 `signal` 的返回值：读它永远 `aborted === false`）。 */
const NEVER_ABORTED = new AbortController().signal

export class TurnAbort {
  /** 当前 turn 的 controller（无 turn 时为 `undefined`）。 */
  private controller: AbortController | undefined

  private turns = 0

  /**
   * 开始一个新 turn：换新 controller 并返回它的信号。
   *
   * @returns 本 turn 的取消信号（传给 `adapter.stream` 与工具管线）
   */
  begin(): AbortSignal {
    this.turns += 1
    this.controller = new AbortController()
    return this.controller.signal
  }

  /**
   * 中断当前 turn。
   *
   * @param reason 取消原因（`signal.reason`；审计与排障用）
   * @returns 是否真的中断了一个在跑的 turn（无 turn / 已取消 → `false`）
   */
  abort(reason = '用户中断'): boolean {
    const controller = this.controller
    if (controller === undefined || controller.signal.aborted) return false
    controller.abort(reason)
    return true
  }

  /** 结束当前 turn：旧 latch 失效（信号对象本身保留，其 `aborted` 不变）。 */
  end(): void {
    this.controller = undefined
  }

  /** 当前 turn 的信号（无 turn 时返回永不取消的信号）。 */
  get signal(): AbortSignal {
    return this.controller?.signal ?? NEVER_ABORTED
  }

  /** 是否有 turn 在跑。 */
  get active(): boolean {
    return this.controller !== undefined
  }

  /** 已经开过多少个 turn（`begin()` 的次数；用于断言"新 turn 换新 controller"）。 */
  get generation(): number {
    return this.turns
  }
}
