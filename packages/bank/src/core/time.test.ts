/**
 * 时间口径（施工单 07 §4）：UTC 切日 / 切账期 + 账期解析 fail-loud。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { DEMO_NOW } from '../forge/index.ts'
import { DAY_MS, dayKey, monthKey, periodRange, previousMonth } from './time.ts'

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
