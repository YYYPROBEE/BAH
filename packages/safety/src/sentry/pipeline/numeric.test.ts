/**
 * 金额抽取三形态（千分位 / 万元表达 / 元角分）。
 */

import { describe, expect, it } from 'vitest'

import { extractAmountsCents, formatAmounts, formatCents, yuanToCents } from './numeric.ts'

describe('extractAmountsCents（三形态）', () => {
  it('T-SNT-HON-001 千分位：¥12,345.67 / 1,234 元', () => {
    expect(extractAmountsCents('余额 ¥12,345.67，可用 1,234 元')).toEqual([123_400, 1_234_567])
  })

  it('T-SNT-HON-002 万元表达：1.5 万元 / 5万', () => {
    expect(extractAmountsCents('理财 1.5万元，转账 5万')).toEqual([1_500_000, 5_000_000])
  })

  it('T-SNT-HON-003 元角分：12 元 3 角 4 分（不被拆成 1200+34）', () => {
    expect(extractAmountsCents('共 12 元 3 角 4 分')).toEqual([1_234])
    expect(extractAmountsCents('3 角 4 分')).toEqual([34])
    expect(extractAmountsCents('12 元 5 分')).toEqual([1_205])
  })

  it('T-SNT-HON-004 混合文本按金额去重升序', () => {
    expect(
      extractAmountsCents('余额 ¥12,345.67；另有 1.5 万元与 12 元 3 角 4 分；重复 12,345.67 元'),
    ).toEqual([1_234, 1_234_567, 1_500_000])
  })

  it('T-SNT-HON-005 无金额 / 非法值返回空数组', () => {
    expect(extractAmountsCents('今天天气不错')).toEqual([])
    expect(extractAmountsCents('')).toEqual([])
    expect(extractAmountsCents('编号 13900002222')).toEqual([])
  })

  it('T-SNT-HON-006 单值元 → 分（工具 amount 参数）', () => {
    expect(yuanToCents(800)).toBe(80_000)
    expect(yuanToCents('1,234.5')).toBe(123_450)
    expect(yuanToCents('.')).toBeUndefined()
    expect(yuanToCents(Number.NaN)).toBeUndefined()
    expect(yuanToCents(undefined)).toBeUndefined()
    expect(yuanToCents('   ')).toBeUndefined()
    expect(yuanToCents({})).toBeUndefined()
  })

  it('T-SNT-HON-007 分 → 展示串（千分位、两位小数、负数）', () => {
    expect(formatCents(1_234_567)).toBe('¥12,345.67')
    expect(formatCents(0)).toBe('¥0.00')
    expect(formatCents(-50)).toBe('-¥0.50')
    expect(formatAmounts([80_000, 1_234_567])).toBe('¥800.00、¥12,345.67')
    expect(formatAmounts([1, 2, 3, 4])).toBe('¥0.01、¥0.02、¥0.03 等 4 项')
  })
})
