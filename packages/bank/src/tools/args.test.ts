/**
 * 工具参数读取原语（施工单 08 §8）。
 *
 * 这些原语是**所有银行工具的唯一入参闸门**：模型给的参数不可信，类型错、缺字段、
 * 超长文本都必须当场 fail-loud 成 `tool-args-invalid`，而不是让 `undefined` 流进账本。
 * 每个拒绝分支都单独钉一条，避免以后"放宽一点"悄悄放行脏参数。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import {
  readBoolean,
  readEnum,
  readNumber,
  readObject,
  readOptionalObject,
  readOptionalPositiveInteger,
  readOptionalString,
  readRequiredEnum,
  readString,
  readStringArray,
} from './args.ts'

/** 取错误码。 */
function codeOf(run: () => unknown): string {
  return captureThrown(run).code
}

describe('对象读取', () => {
  it('普通对象可用；数组 / null / 非对象一律拒绝', () => {
    expect(readObject({ target: { a: 1 } }, 'target', 'w')).toEqual({ a: 1 })

    for (const value of [[], null, 'x', 1]) {
      expect(codeOf(() => readObject({ target: value }, 'target', 'w'))).toBe('tool-args-invalid')
    }
  })

  it('可选对象：未给返回 undefined；给了非对象仍拒绝', () => {
    expect(readOptionalObject({}, 'target', 'w')).toBeUndefined()
    expect(readOptionalObject({ target: { a: 1 } }, 'target', 'w')).toEqual({ a: 1 })
    expect(codeOf(() => readOptionalObject({ target: [] }, 'target', 'w'))).toBe(
      'tool-args-invalid',
    )
  })
})

describe('字符串读取', () => {
  it('非空字符串裁掉首尾空白；空串 / 非字符串拒绝', () => {
    expect(readString({ text: '  房租  ' }, 'text', 'w')).toBe('房租')

    for (const value of ['', '   ', null, 1]) {
      expect(codeOf(() => readString({ text: value }, 'text', 'w'))).toBe('tool-args-invalid')
    }
  })

  it('超过长度上限拒绝（防止把 10MB 文本塞进落盘与 wire）', () => {
    expect(readString({ text: 'abcd' }, 'text', 'w', 4)).toBe('abcd')
    expect(codeOf(() => readString({ text: 'abcde' }, 'text', 'w', 4))).toBe('tool-args-invalid')
  })

  it('可选字符串：undefined / null / 空串都视为未给；超长仍拒绝', () => {
    expect(readOptionalString({}, 'text', 'w')).toBeUndefined()
    expect(readOptionalString({ text: null }, 'text', 'w')).toBeUndefined()
    expect(readOptionalString({ text: '   ' }, 'text', 'w')).toBeUndefined()
    expect(readOptionalString({ text: '  房租  ' }, 'text', 'w')).toBe('房租')
    expect(codeOf(() => readOptionalString({ text: 1 }, 'text', 'w'))).toBe('tool-args-invalid')
    expect(codeOf(() => readOptionalString({ text: 'abcde' }, 'text', 'w', 4))).toBe(
      'tool-args-invalid',
    )
  })
})

describe('数字读取', () => {
  it('有限数字可用；NaN / Infinity / 非数字拒绝', () => {
    expect(readNumber({ n: 0 }, 'n', 'w')).toBe(0)
    expect(readNumber({ n: -1 }, 'n', 'w')).toBe(-1)

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
      expect(codeOf(() => readNumber({ n: value }, 'n', 'w'))).toBe('tool-args-invalid')
    }
  })

  it('可选正整数：未给返回 undefined；0 / 负数 / 小数 / 非数字拒绝', () => {
    expect(readOptionalPositiveInteger({}, 'n', 'w')).toBeUndefined()
    expect(readOptionalPositiveInteger({ n: null }, 'n', 'w')).toBeUndefined()
    expect(readOptionalPositiveInteger({ n: 3 }, 'n', 'w')).toBe(3)

    for (const value of [0, -2, 1.5, '3']) {
      expect(codeOf(() => readOptionalPositiveInteger({ n: value }, 'n', 'w'))).toBe(
        'tool-args-invalid',
      )
    }
  })
})

describe('枚举读取', () => {
  it('大小写不敏感并返回小写；未给返回 undefined', () => {
    expect(readEnum({ period: 'MONTH' }, 'period', 'w', ['month', 'quarter'] as const)).toBe(
      'month',
    )
    expect(readEnum({}, 'period', 'w', ['month'] as const)).toBeUndefined()
  })

  it('白名单外的值拒绝（不静默降级）', () => {
    expect(codeOf(() => readEnum({ period: 'year' }, 'period', 'w', ['month'] as const))).toBe(
      'tool-args-invalid',
    )
  })

  it('必填枚举：未给即拒绝', () => {
    expect(readRequiredEnum({ period: 'quarter' }, 'period', 'w', ['quarter'] as const)).toBe(
      'quarter',
    )
    expect(codeOf(() => readRequiredEnum({}, 'period', 'w', ['quarter'] as const))).toBe(
      'tool-args-invalid',
    )
  })
})

describe('数组与布尔读取', () => {
  it('字符串数组：非空数组可用并裁空白；空数组 / 空项 / 非字符串拒绝', () => {
    expect(readStringArray({ list: [' a ', 'b'] }, 'list', 'w')).toEqual(['a', 'b'])

    expect(codeOf(() => readStringArray({ list: [] }, 'list', 'w'))).toBe('tool-args-invalid')
    expect(codeOf(() => readStringArray({ list: ['a', ''] }, 'list', 'w'))).toBe(
      'tool-args-invalid',
    )
    expect(codeOf(() => readStringArray({ list: [1] }, 'list', 'w'))).toBe('tool-args-invalid')
  })

  it('布尔：未给取 fallback；给了非布尔拒绝（false 不能被 fallback 吞掉）', () => {
    expect(readBoolean({}, 'flag', 'w', true)).toBe(true)
    expect(readBoolean({ flag: null }, 'flag', 'w', true)).toBe(true)
    expect(readBoolean({ flag: false }, 'flag', 'w', true)).toBe(false)
    expect(codeOf(() => readBoolean({ flag: 'true' }, 'flag', 'w', true))).toBe(
      'tool-args-invalid',
    )
  })
})
