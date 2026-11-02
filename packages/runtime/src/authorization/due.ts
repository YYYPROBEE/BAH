/**
 * 到期扫描（`duePlans`）：判定时钟越界检查 + 到期清单。
 *
 * 为什么时钟检查在**扫描**这一层而不只在单条复验里：
 * 一次唤醒会批量执行多条计划；只要 `at` 越界，一条都不该执行（C1：
 * 传 `--at 2030-01-01` 等于把未来计划提前到今天花）。
 */

import { DEFAULT_MAX_SKEW_MS, type ArmedPlan, type DueScan } from './types.ts'

/**
 * 扫出在 `at` 时刻已到期的计划。
 *
 * 排序：`dueAt` 升序，同刻按 `planId` 字典序（确定性）。
 * `at` 只能落在 `[now - ∞, now + maxSkewMs]`；上界越界返回 `window-clock-ahead`。
 */
export function duePlans(
  armed: readonly ArmedPlan[],
  at: number,
  now: number,
  maxSkewMs: number = DEFAULT_MAX_SKEW_MS,
): DueScan {
  if (at > now + maxSkewMs) {
    return { ok: false, code: 'window-clock-ahead', at, now }
  }
  const due = armed
    .filter((plan) => plan.state === 'armed')
    .filter((plan) => plan.dueAt <= at)
    .filter((plan) => plan.expiresAt === undefined || at <= plan.expiresAt)
    .slice()
    .sort((left, right) => {
      if (left.dueAt !== right.dueAt) return left.dueAt - right.dueAt
      return left.planId < right.planId ? -1 : left.planId > right.planId ? 1 : 0
    })
  return { ok: true, due }
}

/**
 * 幂等键（同一实例只执行一次）。
 *
 * 键 = `planId#occurrence`：`occurrence` 来自周期规则（`occurrenceOf`），**不含 `at`**。
 * 于是"同一天跑两次 wake"与"窗口改过之后重新武装"都不会互相吞掉或重复执行。
 */
export function idempotencyKey(planId: string, occurrence: string): string {
  return `${planId}#${occurrence}`
}
