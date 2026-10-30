/**
 * 工具参数里的时间口径（施工单 08 §3.3）。
 *
 * 这组用例钉的是**边界换算**：只写到天的日期在结束边界要补到当天最后一毫秒，
 * 账期回推不能把 `2026-13` 静默滚成相邻账期。两者都是"错一天 / 错一月"级别的事故，
 * 而工具层又只能靠这一处统一实现，所以直接对纯函数断言。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { formatInstant, parseInstant, shiftMonth } from './time.ts'

/** 取错误码。 */
function codeOf(run: () => unknown): string {
  return captureThrown(run).code
}

describe('parseInstant', () => {
  it('epoch ms 原样返回（endOfDay 对数字无效）', () => {
    const at = 1_700_000_000_000
    expect(parseInstant(at, 'at')).toBe(at)
    expect(parseInstant(at, 'at', true)).toBe(at)
  })

  it('只写到天的日期：默认取当天 00:00:00.000（UTC）', () => {
    const at = parseInstant('2026-10-01', 'at')
    expect(new Date(at).toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('只写到天的日期 + endOfDay：补到当天 23:59:59.999（否则会漏掉当天交易）', () => {
    const at = parseInstant('2026-10-01', 'at', true)
    expect(new Date(at).toISOString()).toBe('2026-10-01T23:59:59.999Z')
  })

  it('完整 ISO 时间：endOfDay 不再补，按原时刻解释', () => {
    const at = parseInstant('2026-10-01T08:30:00.000Z', 'at', true)
    expect(new Date(at).toISOString()).toBe('2026-10-01T08:30:00.000Z')
  })

  it('首尾空白会被裁掉（模型偶尔带空格）', () => {
    const at = parseInstant(' 2026-10-01 ', 'at', true)
    expect(new Date(at).toISOString()).toBe('2026-10-01T23:59:59.999Z')
  })

  it('非有限数字 / 空串 / 非字符串 / 非法日期：tool-args-invalid', () => {
    expect(codeOf(() => parseInstant(Number.NaN, 'at'))).toBe('tool-args-invalid')
    expect(codeOf(() => parseInstant(Number.POSITIVE_INFINITY, 'at'))).toBe('tool-args-invalid')
    expect(codeOf(() => parseInstant('', 'at'))).toBe('tool-args-invalid')
    expect(codeOf(() => parseInstant('   ', 'at'))).toBe('tool-args-invalid')
    expect(codeOf(() => parseInstant(null, 'at'))).toBe('tool-args-invalid')
    expect(codeOf(() => parseInstant('not-a-date', 'at'))).toBe('tool-args-invalid')
  })
})

describe('formatInstant', () => {
  it('按 UTC 输出 ISO 8601（跨机器一致）', () => {
    expect(formatInstant(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(formatInstant(Date.parse('2026-10-30T12:00:00.000Z'))).toBe('2026-10-30T12:00:00.000Z')
  })
})

describe('shiftMonth', () => {
  it('count = 0 返回自身；正负方向跨年正确', () => {
    expect(shiftMonth('2026-10', 0)).toBe('2026-10')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-03', -15)).toBe('2024-12')
  })

  it('非法账期：period-invalid（不做静默滚动）', () => {
    expect(codeOf(() => shiftMonth('2026-13', 0))).toBe('period-invalid')
    expect(codeOf(() => shiftMonth('2026-00', 0))).toBe('period-invalid')
    expect(codeOf(() => shiftMonth('2026-1', 0))).toBe('period-invalid')
    expect(codeOf(() => shiftMonth('2026/01', 0))).toBe('period-invalid')
  })
})
