/**
 * 断路器（施工单 10 §3 的内核组件 6：`breaker`——会话级窗口冻结）。
 * 对应源文件 `sentry-dsh-plugin/src/kernel/breaker.js`——阈值、窗口换算与锁存语义照搬。
 *
 * 窗口累计拒绝达阈值 → 本会话进入冻结（P0）处置：敏感操作一律硬拒绝、
 * 全部票据吊销（revoke 由调用方执行）。冻结为锁存状态——本会话内不再恢复，
 * 与"确定性组件执行阻断"的纪律一致（不依赖事后自动恢复的概率判断）。
 *
 * 时钟由构造注入（`options.now`）：测试不给真实时间，判定才能被确定性钉住。
 */

/** `Breaker` 的阈值配置（全部来自校验过的 Config 字段）。 */
export interface BreakerOptions {
  /** 触发阈值（窗口内拒绝数）。 */
  readonly denyThreshold?: number
  /** 滑动窗口（秒）。 */
  readonly windowSeconds?: number
  /** 时钟注入（缺省 `Date.now`）。 */
  readonly now?: () => number
}

/**
 * 会话级断路器：窗口计数 + 锁存冻结。
 */
export class Breaker {
  /** 触发阈值（窗口内拒绝数）。 */
  readonly denyThreshold: number
  /** 滑动窗口（毫秒）。 */
  readonly windowMs: number
  /** 是否已冻结（锁存）。 */
  tripped = false
  /** 窗口内拒绝时间戳（毫秒）。 */
  readonly denies: number[] = []

  private readonly clock: () => number

  constructor(options: BreakerOptions = {}) {
    this.denyThreshold = options.denyThreshold ?? 5
    this.windowMs = (options.windowSeconds ?? 600) * 1000
    this.clock = options.now ?? (() => Date.now())
  }

  /**
   * 记录一次拒绝；返回本次是否"刚刚触发"冻结（供审计事件使用）。
   *
   * @param at - 当前时间（毫秒；省略 = 取注入时钟）。
   * @returns 是否在本次记录时从正常态转入冻结。
   */
  recordDeny(at: number = this.clock()): boolean {
    if (this.tripped) return false
    this.denies.push(at)
    this.prune(at)
    if (this.denies.length >= this.denyThreshold) {
      this.tripped = true
      return true
    }
    return false
  }

  /**
   * 窗口内拒绝数（读时剪枝）。
   *
   * @param at - 当前时间（毫秒；省略 = 取注入时钟）。
   * @returns 窗口内拒绝条数。
   */
  countInWindow(at: number = this.clock()): number {
    this.prune(at)
    return this.denies.length
  }

  /** 剪除窗口外的时间戳。 */
  private prune(at: number): void {
    const cutoff = at - this.windowMs
    for (;;) {
      const head = this.denies[0]
      if (head === undefined || head >= cutoff) return
      this.denies.shift()
    }
  }
}
