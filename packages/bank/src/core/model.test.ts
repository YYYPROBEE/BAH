/**
 * 领域原语：金额换算与品牌 ID 铸造点。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { bankIds, centsToYuan, formatYuan, yuanToCents } from './model.ts'

describe('金额换算（账本一律整数分）', () => {
  it('元 → 分：按分四舍五入，0.1 + 0.2 的浮点误差被吸收', () => {
    expect(yuanToCents(0.1 + 0.2)).toBe(30)
    expect(yuanToCents(1234.56)).toBe(123_456)
    expect(yuanToCents(0)).toBe(0)
    expect(yuanToCents(0.005)).toBe(1)
    // 二进制浮点会把 *100 放大成 100.49999999999999：必须按十进制字面值进位
    expect(yuanToCents(1.005)).toBe(101)
    expect(yuanToCents(2.675)).toBe(268)
    expect(yuanToCents(0.615)).toBe(62)
    // 极小值合法（舍到 0 分），极大值必须被安全整数拦下
    expect(yuanToCents(1e-7)).toBe(0)
    expect(captureThrown(() => yuanToCents(1e21)).code).toBe('money-invalid')
  })

  it('非法金额 fail-loud（负数 / NaN / Infinity）', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(captureThrown(() => yuanToCents(value)).code).toBe('money-invalid')
    }
  })

  it('分 → 元 / 展示格式：千分位、负数、两位小数', () => {
    expect(centsToYuan(123_456)).toBe(1234.56)
    expect(formatYuan(1_234_567)).toBe('¥12,345.67')
    expect(formatYuan(5)).toBe('¥0.05')
    expect(formatYuan(0)).toBe('¥0.00')
    expect(formatYuan(-100)).toBe('-¥1.00')
  })
})

describe('品牌 ID 铸造点', () => {
  it('八类 ID 原样透传（只在造数与夹具里用）', () => {
    expect(bankIds.user('u-1')).toBe('u-1')
    expect(bankIds.account('a-1')).toBe('a-1')
    expect(bankIds.card('c-1')).toBe('c-1')
    expect(bankIds.txn('t-1')).toBe('t-1')
    expect(bankIds.payee('p-1')).toBe('p-1')
    expect(bankIds.product('w-1')).toBe('w-1')
    expect(bankIds.holding('h-1')).toBe('h-1')
    expect(bankIds.subscription('s-1')).toBe('s-1')
  })
})
