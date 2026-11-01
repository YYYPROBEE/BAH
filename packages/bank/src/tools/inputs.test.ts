/**
 * 工具入参校验：金额正数 / 理财筛选 / 执行时间。
 *
 * 这几条都是"错了就把钱或时间放出去"的边界：负数金额、非法期限、补做历史转账。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { assertExecutableNow, parsePurchaseAmount, parseWealthFilter } from './inputs.ts'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')

describe('assertExecutableNow：只接受 now', () => {
  it('缺省 / now（大小写不敏感）放行', () => {
    expect(() => assertExecutableNow(undefined, NOW)).not.toThrow()
    expect(() => assertExecutableNow('now', NOW)).not.toThrow()
    expect(() => assertExecutableNow('NOW', NOW)).not.toThrow()
  })

  it('过去时刻 ⇒ when-in-past（不能补做历史转账）', () => {
    expect(captureThrown(() => assertExecutableNow('2026-10-29T23:59:00.000Z', NOW)).code).toBe(
      'when-in-past',
    )
  })

  it('未来时刻 ⇒ unsupported-schedule（能力未实现，不是参数非法）', () => {
    expect(captureThrown(() => assertExecutableNow('2026-10-30T00:01:00.000Z', NOW)).code).toBe(
      'unsupported-schedule',
    )
  })
})

describe('理财入参：金额与筛选', () => {
  it('购买金额必须大于 0；合法金额按元 → 分换算', () => {
    expect(parsePurchaseAmount({ amount: 100 })).toBe(10_000)
    expect(captureThrown(() => parsePurchaseAmount({ amount: 0 })).code).toBe('tool-args-invalid')
    expect(captureThrown(() => parsePurchaseAmount({ amount: -1 })).code).toBe('tool-args-invalid')
  })

  it('maxTermDays 必须是正整数；缺省不产出该键', () => {
    expect(parseWealthFilter({ filter: { maxTermDays: 90 } })).toEqual({ maxTermDays: 90 })
    expect(captureThrown(() => parseWealthFilter({ filter: { maxTermDays: 0 } })).code).toBe(
      'tool-args-invalid',
    )
    expect(captureThrown(() => parseWealthFilter({ filter: { maxTermDays: 1.5 } })).code).toBe(
      'tool-args-invalid',
    )
    expect(captureThrown(() => parseWealthFilter({ filter: { maxTermDays: '90' } })).code).toBe(
      'tool-args-invalid',
    )
    expect(parseWealthFilter({})).toBeUndefined()
  })

  it('riskGrade 大小写归一；越界等级 fail-loud', () => {
    expect(parseWealthFilter({ filter: { riskGrade: 'r1' } })).toEqual({ riskGrade: 'R1' })
    expect(captureThrown(() => parseWealthFilter({ filter: { riskGrade: 'R9' } })).code).toBe(
      'tool-args-invalid',
    )
  })
})
