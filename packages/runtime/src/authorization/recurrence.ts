/**
 * 周期规则 → 实例键（`occurrenceOf`）与下一次到期时刻（`nextDueAt`）。
 *
 * 为什么必须有实例键：幂等锁不能按 `at` 的精确值取（不同判定时刻会走到同一条到期记录），
 * 也不能只按 `planId` 取（周期计划的第 2 个月会被第 1 个月的记录吞掉）。
 * 正解是**周期规则自身的实例**：生日 → `2026-10-22`；每月锁钱 → `2026-10`。
 *
 * 时区固定为 UTC+8（银行口径），不读系统时区；历法用整数算法（不构造时间对象），
 * 这样同一份输入在任何机器上都得到同一个键。
 */

import { BahError } from '@bah/util'

import type { Recurrence } from './types.ts'

/** 银行口径时区偏移（毫秒）。 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 历法字段（UTC+8 墙钟）。 */
export interface WallClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
}

/** 闰年判定（公历）。 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** 某月的天数（`month` 为 1–12）。 */
export function daysInMonth(year: number, month: number): number {
  const table = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return table[month - 1] as number
}

/**
 * 公历日期 → 1970-01-01 起的天数（Howard Hinnant 的 days_from_civil）。
 *
 * 纯整数运算：不依赖 `Intl` / 时区 / 平台历法实现。
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** 1970-01-01 起的天数 → 公历日期（days_from_civil 的逆）。 */
export function civilFromDays(days: number): {
  readonly year: number
  readonly month: number
  readonly day: number
} {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: month <= 2 ? y + 1 : y, month, day }
}

/** epoch ms → UTC+8 墙钟字段。 */
export function wallClockAt(epochMs: number): WallClock {
  const days = Math.floor((epochMs + TZ_OFFSET_MS) / DAY_MS)
  const rest = epochMs + TZ_OFFSET_MS - days * DAY_MS
  const civil = civilFromDays(days)
  return {
    year: civil.year,
    month: civil.month,
    day: civil.day,
    hour: Math.floor(rest / 3_600_000),
    minute: Math.floor((rest % 3_600_000) / 60_000),
  }
}

/** UTC+8 墙钟 → epoch ms（`minute` 精度；秒与毫秒恒为 0）。 */
export function epochOfWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return daysFromCivil(year, month, day) * DAY_MS + hour * 3_600_000 + minute * 60_000 - TZ_OFFSET_MS
}

/** 解析 `HH:mm`（UTC+8 口径）。 */
export function parseClock(text: string): { readonly hour: number; readonly minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (match === null) {
    throw new BahError('recurrence-invalid', `周期时刻必须是 HH:mm：${text}`, { at: text })
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    throw new BahError('recurrence-invalid', `周期时刻越界：${text}`, { at: text })
  }
  return { hour, minute }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function assertUnreachable(value: never): never {
  throw new BahError('recurrence-invalid', '周期规则不可达分支', { value })
}

/**
 * 周期实例键（幂等键的右半边）。
 *
 * - `once`  → `once:<dueAt>`（一次性计划只有一个实例）
 * - `daily` → `YYYY-MM-DD`（按**判定时刻**所在的自然日）
 * - `monthly` → `YYYY-MM`
 * - `yearly` → `YYYY-MM-DD`
 */
export function occurrenceOf(recurrence: Recurrence, at: number): string {
  const w = wallClockAt(at)
  switch (recurrence.every) {
    case 'once':
      return `once:${String(recurrence.dueAt)}`
    case 'daily':
      return `${String(w.year)}-${pad2(w.month)}-${pad2(w.day)}`
    case 'monthly':
      return `${String(w.year)}-${pad2(w.month)}`
    case 'yearly':
      return `${String(w.year)}-${pad2(w.month)}-${pad2(w.day)}`
    default:
      return assertUnreachable(recurrence)
  }
}

/**
 * 下一次到期时刻（严格晚于 `after`）。
 *
 * 边界口径（单测钉死）：
 * - 每月 31 日：小月取当月最后一天（2 月取 28/29）；
 * - 2 月 29 日（闰日）：平年取 2 月 28 日；
 * - 年末：12 月的下一次在次年 1 月。
 */
export function nextDueAt(recurrence: Recurrence, after: number): number {
  switch (recurrence.every) {
    case 'once':
      return recurrence.dueAt
    case 'daily': {
      const clock = parseClock(recurrence.at)
      const w = wallClockAt(after)
      let days = daysFromCivil(w.year, w.month, w.day)
      let candidate = days * DAY_MS + clock.hour * 3_600_000 + clock.minute * 60_000 - TZ_OFFSET_MS
      if (candidate <= after) {
        days += 1
        candidate = days * DAY_MS + clock.hour * 3_600_000 + clock.minute * 60_000 - TZ_OFFSET_MS
      }
      return candidate
    }
    case 'monthly': {
      const clock = parseClock(recurrence.at)
      const w = wallClockAt(after)
      let year = w.year
      let month = w.month
      for (let step = 0; step < 24; step += 1) {
        const day = Math.min(recurrence.day, daysInMonth(year, month))
        const candidate = epochOfWallClock(year, month, day, clock.hour, clock.minute)
        if (candidate > after) return candidate
        month += 1
        if (month > 12) {
          month = 1
          year += 1
        }
      }
      throw new BahError('recurrence-invalid', 'monthly 规则 24 个月内找不到下一次', { after })
    }
    case 'yearly': {
      const clock = parseClock(recurrence.at)
      const w = wallClockAt(after)
      for (let year = w.year; year <= w.year + 8; year += 1) {
        const day = Math.min(recurrence.day, daysInMonth(year, recurrence.month))
        const candidate = epochOfWallClock(year, recurrence.month, day, clock.hour, clock.minute)
        if (candidate > after) return candidate
      }
      throw new BahError('recurrence-invalid', 'yearly 规则 8 年内找不到下一次', { after })
    }
    default:
      return assertUnreachable(recurrence)
  }
}
