/**
 * 数字 / 单位 / 日期归一化（W05 §1 第 3 条：防"换个写法就绕过核验"）。
 *
 * 核验的强度取决于归一化是否只认一种写法：`八百` 与 `800` 必须落到同一个分，
 * `3%` 与 `千分之三` 必须落到同一个基点；而 `一百五` 这类口语省略**必须拒绝**——
 * 猜错比不判更危险。这组用例直接钉住这些出口，而不是经由整条核验链间接覆盖。
 */

import { describe, expect, it } from 'vitest'

import {
  canonicalDate,
  chineseToDecimal,
  decimalToInt,
  hasChineseDigit,
  moneyToCents,
  normalizeTail,
  parseDecimalText,
  rateToBasisPoints,
} from './normalize.ts'

describe('hasChineseDigit', () => {
  it('含中文数字字符才走中文解析器', () => {
    expect(hasChineseDigit('¥800')).toBe(false)
    expect(hasChineseDigit('800.5')).toBe(false)
    expect(hasChineseDigit('八百')).toBe(true)
    expect(hasChineseDigit('三点五')).toBe(true)
  })
})

describe('chineseToDecimal', () => {
  it('标准写法：整数、带小数、跨节', () => {
    expect(chineseToDecimal('八百')).toBe('800')
    expect(chineseToDecimal('十万')).toBe('100000')
    expect(chineseToDecimal('一千二百三十四')).toBe('1234')
    expect(chineseToDecimal('一百零五')).toBe('105')
    expect(chineseToDecimal('三点五')).toBe('3.5')
    expect(chineseToDecimal('一亿零五万')).toBe('100050000')
  })

  it('口语省略写法拒绝（不猜 105 / 35000 / 1203）', () => {
    expect(chineseToDecimal('一百五')).toBeUndefined()
    expect(chineseToDecimal('三万五')).toBeUndefined()
    expect(chineseToDecimal('一千二百三')).toBeUndefined()
  })

  it('空串 / 非法字符 / 重复小数点拒绝', () => {
    expect(chineseToDecimal('')).toBeUndefined()
    expect(chineseToDecimal('一百块')).toBeUndefined()
    expect(chineseToDecimal('一点二点三')).toBeUndefined()
  })
})

describe('parseDecimalText', () => {
  it('去掉货币符号 / 千分位 / 空白；非法数字拒绝', () => {
    expect(parseDecimalText('¥ 1,234.56')).toBe('1234.56')
    expect(parseDecimalText('800')).toBe('800')
    expect(parseDecimalText('-5')).toBeUndefined()
    expect(parseDecimalText('1e3')).toBeUndefined()
    expect(parseDecimalText('abc')).toBeUndefined()
  })
})

describe('decimalToInt', () => {
  it('按十进制移位并 half-up（不经过浮点）', () => {
    expect(decimalToInt('12.345', 2)).toBe(1_235)
    expect(decimalToInt('12.344', 2)).toBe(1_234)
    expect(decimalToInt('0.999', 2)).toBe(100)
    expect(decimalToInt('12.345', 1)).toBe(123)
  })

  it('非法小数 / 非法 scale / 超出安全整数范围拒绝', () => {
    expect(decimalToInt('-1', 2)).toBeUndefined()
    expect(decimalToInt('abc', 2)).toBeUndefined()
    expect(decimalToInt('1.2', -1)).toBeUndefined()
    expect(decimalToInt('1.2', 13)).toBeUndefined()
    expect(decimalToInt('999999999999999999', 0)).toBeUndefined()
  })
})

describe('moneyToCents', () => {
  it('元 → 分；万 / 亿 后缀按数量级放大', () => {
    expect(moneyToCents('800')).toBe(80_000)
    expect(moneyToCents('1,234')).toBe(123_400)
    expect(moneyToCents('1.2', '万')).toBe(1_200_000)
    expect(moneyToCents('八百', '万')).toBe(800_000_000)
  })

  it('无法归一化的写法返回 undefined（绝不猜近似值）', () => {
    expect(moneyToCents('一百五')).toBeUndefined()
    expect(moneyToCents('abc')).toBeUndefined()
  })
})

describe('rateToBasisPoints', () => {
  it('百分 / 千分按同一个基点出口', () => {
    expect(rateToBasisPoints('0.3', 'percent')).toBe(30)
    expect(rateToBasisPoints('0.3', 'permille')).toBe(3)
    expect(rateToBasisPoints('3', 'permille')).toBe(30)
    expect(rateToBasisPoints('三点五', 'permille')).toBe(35)
    expect(rateToBasisPoints('abc', 'percent')).toBeUndefined()
  })
})

describe('canonicalDate', () => {
  it('带年 / 不带年 / 单数字段都规范化，并裁掉空白', () => {
    expect(canonicalDate('2026-10-26')).toBe('2026-10-26')
    expect(canonicalDate('2026/10/6')).toBe('2026-10-06')
    expect(canonicalDate('2026.10.06')).toBe('2026-10-06')
    expect(canonicalDate('2026年10月26日')).toBe('2026-10-26')
    expect(canonicalDate(' 10月6日 ')).toBe('10-06')
  })

  it('月份 / 日期越界或不是日期：undefined', () => {
    expect(canonicalDate('2026-13-01')).toBeUndefined()
    expect(canonicalDate('2026-02-32')).toBeUndefined()
    expect(canonicalDate('不是日期')).toBeUndefined()
  })
})

describe('normalizeTail', () => {
  it('只认四位数字；非数字字符先剔除', () => {
    expect(normalizeTail('****1234')).toBe('1234')
    expect(normalizeTail('尾号 1234')).toBe('1234')
    expect(normalizeTail('12345')).toBeUndefined()
    expect(normalizeTail('123')).toBeUndefined()
    expect(normalizeTail('abcd')).toBeUndefined()
  })
})
