/**
 * 动作预算账本（`budget`——工具面的确定性总量闸门）。
 * 对应源文件 `sentry-dsh-plugin/src/kernel/budget.js`——维度口径、"先记账再比对"的
 * 语义与默认 `amount: 0` 兜底位全部照搬。
 *
 * 计数器确定性执行：总量控制替代识别精度。超预算 = 确定性阻断信号
 * （不是检测误报，也不是概率判断）。暂停维度：total_calls / risky_calls / amount
 * （原项目五维 egress_bytes / pii_count / write_ops / irreversible_ops / amount 中，
 *  可在 Harness 工具面确定性统计的三维；详见 README「提炼边界」）。
 */

/** 分维度上限/花费表（维度名来自校验过的 Config，内核不硬编码可调项）。 */
export type BudgetLimits = Record<string, number>

/** `tryConsume()` 的判定结果。 */
export interface ConsumeResult {
  /** `false` 即超预算（确定性阻断信号）。 */
  readonly ok: boolean
  /** 记账后的已花费。 */
  readonly spent: number
  /** 该维度上限（未登记的维度 = 0，即"默认拒绝"）。 */
  readonly limit: number
}

/** `snapshot()` 的审计投影。 */
export interface BudgetSnapshot {
  readonly limits: BudgetLimits
  readonly spent: BudgetLimits
}

/**
 * 单会话预算：`limits` 为上限表，`spent` 为已花费表。
 */
export class Budget {
  readonly limits: BudgetLimits
  readonly spent: BudgetLimits

  /**
   * @param limits - 上限表（分维度）。
   */
  constructor(limits: BudgetLimits = {}) {
    // amount 恒有上限位（缺省 0）：金额维度漏配时落到"默认拒绝"而不是无限额
    this.limits = { amount: 0, ...limits }
    this.spent = Object.fromEntries(Object.keys(this.limits).map((key) => [key, 0] as const))
  }

  /**
   * 消费并判定：先记账、再比对（对应 try_consume 语义）。
   *
   * @param dim - 维度名。
   * @param qty - 数量。
   * @returns 判定结果。
   */
  tryConsume(dim: string, qty: number): ConsumeResult {
    const spent = (this.spent[dim] ?? 0) + qty
    this.spent[dim] = spent
    const limit = this.limits[dim] ?? 0
    return { ok: spent <= limit, spent, limit }
  }

  /** 快照（审计用；两份表都是副本，外部改不动账本）。 */
  snapshot(): BudgetSnapshot {
    return { limits: { ...this.limits }, spent: { ...this.spent } }
  }
}

/**
 * 会话级账本：懒初始化。
 */
export class BudgetLedger {
  private readonly defaults: BudgetLimits
  private readonly budgets = new Map<string, Budget>()

  /**
   * @param defaultLimits - 默认上限（部署配置）。
   */
  constructor(defaultLimits: BudgetLimits = {}) {
    this.defaults = { ...defaultLimits }
  }

  /**
   * 签发/覆盖某会话的预算（对应原"意图模板覆盖默认预算"的落点）。
   *
   * @param sessionKey - 会话键。
   * @param override - 覆盖项（在默认上限之上浅合并）。
   * @returns 该会话的新预算（旧的直接作废——覆盖即重置花费）。
   */
  issue(sessionKey: string, override?: BudgetLimits): Budget {
    const merged = { ...this.defaults, ...(override ?? {}) }
    const budget = new Budget(merged)
    this.budgets.set(sessionKey, budget)
    return budget
  }

  /**
   * 取某会话预算（不存在则按默认签发）。
   *
   * @param sessionKey - 会话键。
   * @returns 该会话预算。
   */
  get(sessionKey: string): Budget {
    const existing = this.budgets.get(sessionKey)
    if (existing !== undefined) return existing
    const created = new Budget(this.defaults)
    this.budgets.set(sessionKey, created)
    return created
  }
}
