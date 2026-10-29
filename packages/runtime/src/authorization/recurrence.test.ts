import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import {
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  isLeapYear,
  nextDueAt,
  occurrenceOf,
  parseClock,
  wallClockAt,
} from './recurrence.ts'

/** 2026-10-22 10:00:00 +08:00 */
const T_2026_10_22 = Date.UTC(2026, 9, 22, 2, 0, 0)

describe('recurrence：实例键', () => {
  it('once → once:<dueAt>；daily → 自然日；monthly → 年月；yearly → 年月日', () => {
    expect(occurrenceOf({ every: 'once', dueAt: 42 }, T_2026_10_22)).toBe('once:42')
    expect(occurrenceOf({ every: 'daily', at: '09:00' }, T_2026_10_22)).toBe('2026-10-22')
    expect(occurrenceOf({ every: 'monthly', day: 22, at: '09:00' }, T_2026_10_22)).toBe('2026-10')
    expect(occurrenceOf({ every: 'yearly', month: 10, day: 22, at: '09:00' }, T_2026_10_22)).toBe(
      '2026-10-22',
    )
  })

  it('UTC+8 边界：UTC 15:59 是当天，UTC 16:00 已是次日', () => {
    const before = Date.UTC(2026, 9, 21, 15, 59)
    const after = Date.UTC(2026, 9, 21, 16, 0)
    expect(occurrenceOf({ every: 'daily', at: '00:00' }, before)).toBe('2026-10-21')
    expect(occurrenceOf({ every: 'daily', at: '00:00' }, after)).toBe('2026-10-22')
  })

  it('同一自然日内判定时刻不同 ⇒ 同键（at 不参与键）', () => {
    const morning = occurrenceOf({ every: 'daily', at: '09:00' }, T_2026_10_22)
    const evening = occurrenceOf({ every: 'daily', at: '09:00' }, T_2026_10_22 + 8 * 3600_000)
    expect(morning).toBe(evening)
  })
})

describe('recurrence：下一次到期', () => {
  it('daily：当天时刻已过 ⇒ 明天；未过 ⇒ 今天', () => {
    const at = T_2026_10_22 // 10:00
    expect(nextDueAt({ every: 'daily', at: '09:00' }, at) - at).toBe(23 * 3600_000)
    expect(nextDueAt({ every: 'daily', at: '21:00' }, at) - at).toBe(11 * 3600_000)
  })

  it('monthly 31 日：小月落到月末（4 月 30 日）', () => {
    const after = Date.UTC(2026, 3, 1, 1, 0) // 2026-04-01 09:00 +08
    const due = nextDueAt({ every: 'monthly', day: 31, at: '09:00' }, after)
    expect(wallClockAt(due)).toMatchObject({ year: 2026, month: 4, day: 30 })
  })

  it('yearly 2/29：平年落到 2/28，闰年回到 2/29', () => {
    const after2026 = Date.UTC(2026, 0, 1, 0, 0)
    expect(wallClockAt(nextDueAt({ every: 'yearly', month: 2, day: 29, at: '09:00' }, after2026))).toMatchObject({
      year: 2026,
      month: 2,
      day: 28,
    })
    const after2027 = Date.UTC(2027, 2, 1, 0, 0) // 2027-03-01 08:00 +08
    expect(wallClockAt(nextDueAt({ every: 'yearly', month: 2, day: 29, at: '09:00' }, after2027))).toMatchObject({
      year: 2028,
      month: 2,
      day: 29,
    })
  })

  it('monthly 年末：12 月的下一次在次年 1 月', () => {
    const after = Date.UTC(2026, 11, 15, 0, 0)
    expect(wallClockAt(nextDueAt({ every: 'monthly', day: 1, at: '09:00' }, after))).toMatchObject({
      year: 2027,
      month: 1,
      day: 1,
    })
  })

  it('坏时刻 fail-loud', () => {
    expect(parseClock('9:00')).toEqual({ hour: 9, minute: 0 })
    expect(captureThrown(() => parseClock('24:00')).code).toBe('recurrence-invalid')
    expect(captureThrown(() => parseClock('09:60')).code).toBe('recurrence-invalid')
    expect(captureThrown(() => parseClock('九点')).code).toBe('recurrence-invalid')
  })
})

describe('历法：整数算法自洽', () => {
  it('daysFromCivil / civilFromDays 互逆（抽样）', () => {
    for (const [y, m, d] of [
      [1970, 1, 1],
      [2000, 2, 29],
      [2026, 10, 22],
      [2100, 3, 1],
    ] as const) {
      expect(civilFromDays(daysFromCivil(y, m, d))).toEqual({ year: y, month: m, day: d })
    }
  })

  it('闰年与月天数', () => {
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(2100)).toBe(false)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2026, 12)).toBe(31)
  })
})
