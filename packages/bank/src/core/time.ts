/**
 * 仿真银行的时间口径（施工单 07 §4.2 / §4.3）。
 *
 * 全部按 **UTC** 切日 / 切账期：日累计与账单必须跨机器、跨时区逐位一致，
 * 否则同一笔转账在开发机与 CI 上归属不同的一天，快照回放也会飘。
 * （夜间大额的"东八区小时"是唯一的本地口径，见 `forge/risk.ts`。）
 */

import { BahError } from '@bah/util'

/** 一天的毫秒数。 */
export const DAY_MS = 86_400_000

/** epoch ms → UTC 日 `YYYY-MM-DD`。 */
export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** epoch ms → UTC 账期 `YYYY-MM`。 */
export function monthKey(at: number): string {
  return new Date(at).toISOString().slice(0, 7)
}

/** `YYYY-MM` → 上一账期（跨年正确）。 */
export function previousMonth(period: string): string {
  const { year, month } = parsePeriod(period)
  return month === 1
    ? `${String(year - 1).padStart(4, '0')}-12`
    : `${String(year).padStart(4, '0')}-${String(month - 1).padStart(2, '0')}`
}

/** `YYYY-MM` → `[start, end)` epoch ms（UTC 月初到次月初）。 */
export function periodRange(period: string): { readonly start: number; readonly end: number } {
  const { year, month } = parsePeriod(period)
  return { start: Date.UTC(year, month - 1, 1), end: Date.UTC(year, month, 1) }
}

/** 解析账期；非法输入 fail-loud（`period-invalid`）。 */
function parsePeriod(period: string): { readonly year: number; readonly month: number } {
  const matched = /^(\d{4})-(\d{2})$/.exec(period)
  if (matched === null) {
    throw new BahError('period-invalid', `bank: 账期必须是 YYYY-MM（收到 ${period}）`, { period })
  }
  const month = Number(matched[2])
  if (month < 1 || month > 12) {
    throw new BahError('period-invalid', `bank: 账期月份越界（收到 ${period}）`, { period })
  }
  return { year: Number(matched[1]), month }
}
