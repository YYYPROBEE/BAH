/**
 * 时间口径（施工单 07 §4）：UTC 切日 / 切账期 + 账期解析 fail-loud。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { DEMO_NOW } from '../forge/index.ts'
import { DAY_MS, dayKey, formatCnMinute, monthKey, periodRange, previousMonth } from './time.ts'

describe('UTC 日 / 账期', () => {
  it('dayKey / monthKey 按 UTC 切分（跨机器一致）', () => {
    expect(DAY_MS).toBe(86_400_000)
    expect(dayKey(DEMO_NOW)).toBe('2026-10-19')
    expect(monthKey(DEMO_NOW)).toBe('2026-10')
    expect(dayKey(DEMO_NOW - DAY_MS)).toBe('2026-10-18')
  })

  it('previousMonth 跨年正确', () => {
    expect(previousMonth('2026-10')).toBe('2026-09')
    expect(previousMonth('2026-01')).toBe('2025-12')
    expect(previousMonth('2024-03')).toBe('2024-02')
  })

  it('periodRange 是 UTC 月初到次月初的半开区间', () => {
    expect(periodRange('2026-10')).toEqual({
      start: Date.UTC(2026, 9, 1),
      end: Date.UTC(2026, 10, 1),
    })
    expect(periodRange('2026-12').end).toBe(Date.UTC(2027, 0, 1))
  })

  it('非法账期 → period-invalid（格式错 / 月份越界都拒绝）', () => {
    for (const period of ['2026-13', '2026-1', 'x', '2026-00']) {
      expect(captureThrown(() => previousMonth(period)).code).toBe('period-invalid')
      expect(captureThrown(() => periodRange(period)).code).toBe('period-invalid')
    }
  })
})

describe('formatCnMinute（固定 +8、无 locale API）', () => {
  it('epoch 0 → 1970-01-01 08:00（按东八区，不是 UTC）', () => {
    expect(formatCnMinute(0)).toBe('1970-01-01 08:00')
  })

  it('快照基准 T0 → 2023-11-15 06:13', () => {
    expect(formatCnMinute(1_700_000_000_000)).toBe('2023-11-15 06:13')
  })

  it('秒被截掉（不是四舍五入）', () => {
    expect(formatCnMinute(1_700_000_000_000 + 39_999)).toBe('2023-11-15 06:13')
    expect(formatCnMinute(1_700_000_000_000 + 40_000)).toBe('2023-11-15 06:14')
  })

  it('跨年按 +8 算：2023-12-31 23:59（UTC 还是当天 15:59）', () => {
    expect(formatCnMinute(1_704_038_340_000)).toBe('2023-12-31 23:59')
  })

  it('闰日正确：2024-02-29 12:00（+8）', () => {
    expect(formatCnMinute(Date.UTC(2024, 1, 29, 4, 0))).toBe('2024-02-29 12:00')
  })
})
