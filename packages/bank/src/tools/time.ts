/**
 * 工具参数里的时间口径（施工单 08 §3.3）。
 *
 * 模型给日期的方式不固定：`2026-10-01`、完整 ISO 8601、epoch ms 都可能。
 * 这里统一成 epoch ms，并对「日期只写到天」的结束边界补到当天 23:59:59.999——
 * 否则用户说“查到 10 月 1 日”会漏掉当天的交易。
 *
 * 全部按 UTC 解释（与 bank-core 的日 / 账期口径一致，见 `docs/bank.md` §2）。
 */

import { BahError } from '@bah/util'

import { DAY_MS } from '../core/time.ts'

/** 日期只写到天（`YYYY-MM-DD`）时，结束边界补到当天最后一毫秒。 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * 解析一个时刻。
 *
 * @param endOfDay 仅对 `YYYY-MM-DD` 生效：`true` 表示取当天 23:59:59.999
 * @throws `BahError('tool-args-invalid')` 无法解析
 */
export function parseInstant(value: unknown, field: string, endOfDay = false): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BahError('tool-args-invalid', `bank-tools: ${field} 必须是有限数字`, { field })
    }
    return value
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BahError('tool-args-invalid', `bank-tools: ${field} 必须是 ISO 时间或 epoch ms`, {
      field,
    })
  }
  const text = value.trim()
  const parsed = DATE_ONLY.test(text) ? Date.parse(`${text}T00:00:00.000Z`) : Date.parse(text)
  if (!Number.isFinite(parsed)) {
    throw new BahError('tool-args-invalid', `bank-tools: ${field} 不是合法时间（${text}）`, {
      field,
    })
  }
  return endOfDay && DATE_ONLY.test(text) ? parsed + DAY_MS - 1 : parsed
}

/** epoch ms → ISO 8601（展示 / 审计用；UTC，跨机器一致）。 */
export function formatInstant(at: number): string {
  return new Date(at).toISOString()
}

/** 当前账期往前推 `count` 个账期（`count = 0` 返回自身）。 */
export function shiftMonth(period: string, count: number): string {
  const matched = /^(\d{4})-(\d{2})$/.exec(period)
  if (matched === null) {
    throw new BahError('period-invalid', `bank-tools: 账期必须是 YYYY-MM（收到 ${period}）`, {
      period,
    })
  }
  const monthValue = Number(matched[2])
  // `2026-13` 不能静默滚进相邻账期：与 `core/time.ts` 的 `parsePeriod` 同口径
  if (monthValue < 1 || monthValue > 12) {
    throw new BahError('period-invalid', `bank-tools: 账期月份必须在 01–12（收到 ${period}）`, {
      period,
      month: monthValue,
    })
  }
  const total = Number(matched[1]) * 12 + (monthValue - 1) + count
  const year = Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`
}
