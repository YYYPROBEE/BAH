/**
 * 仿真银行的时间口径。
 *
 * 全部按 **UTC** 切日 / 切账期：日累计与账单必须跨机器、跨时区逐位一致，
 * 否则同一笔转账在开发机与 CI 上归属不同的一天，快照回放也会飘。
 * （夜间大额的"东八区小时"是唯一的本地口径，见 `forge/risk.ts`。）
 */

import { BahError } from '@bah/util'

import { CN_TZ_OFFSET_MS } from './model.ts'

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

/**
 * epoch ms → **东八区** `YYYY-MM-DD HH:mm`（固定 +8）。
 *
 * 为什么不复用 `formatInstant`（ISO UTC）：提示词里的时刻给人读，`...T...Z` 是机器格式；
 * 为什么不用 `toLocaleString` / `Intl.DateTimeFormat`：受运行环境 locale 与 tzdata 影响，
 * 快照回放会飘。这里只做整数拼接，跨机器逐字一致。
 *
 * 秒被截掉（不是四舍五入）：槽位的时刻是"截至"语义，分钟粒度足够，也不泄露时序噪声。
 */
export function formatCnMinute(at: number): string {
  const shifted = new Date(at + CN_TZ_OFFSET_MS)
  const year = String(shifted.getUTCFullYear()).padStart(4, '0')
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  const hour = String(shifted.getUTCHours()).padStart(2, '0')
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
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
