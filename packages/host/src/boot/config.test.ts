/**
 * boot 配置校验原语（施工单 06 §4：fail-loud，`bah-boot: ` 前缀）。
 *
 * 这些原语是"未知键 / 类型错误载入即抛"的唯一实现点，也是"未写字段走默认值"的落点，
 * 所以逐条测：每一条拒绝都要有精确理由码与可读文案。
 */

import { captureThrown } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import {
  BOOT_PREFIX,
  asRecord,
  bootError,
  describeValue,
  readBoolean,
  readEnum,
  readPositiveInteger,
  readRawString,
  readRequiredString,
  readString,
  readStringArray,
  rejectUnknownKeys,
} from './config.ts'

describe('boot 配置原语', () => {
  it('bootError：统一前缀 + 理由码 + 结构化 detail', () => {
    const error = bootError('demo', '理由', { where: 'x' })
    expect(error.code).toBe('demo')
    expect(error.message).toBe(`${BOOT_PREFIX}理由`)
    expect(error.detail).toEqual({ where: 'x' })
  })

  it('asRecord：非对象（null / 标量 / 数组）一律 invalid-config', () => {
    for (const bad of [null, undefined, 1, 'x', []]) {
      expect(captureThrown(() => asRecord(bad, 'core:x')).code).toBe('invalid-config')
    }
    expect(asRecord({ a: 1 }, 'core:x')).toEqual({ a: 1 })
  })

  it('rejectUnknownKeys：列出未知键与可写键；允许集为空时写"可写：无"', () => {
    expect(() => rejectUnknownKeys({ a: 1 }, ['a'], 'core:x')).not.toThrow()

    const error = captureThrown(() => rejectUnknownKeys({ b: 1, c: 2 }, ['a'], 'core:x'))
    expect(error.code).toBe('unknown-config-key')
    expect(error.message).toContain('b, c')
    expect(error.message).toContain('a')

    expect(captureThrown(() => rejectUnknownKeys({ b: 1 }, [], 'core:x')).message).toContain('可写：无')
  })

  it('readString / readRequiredString：trim、空串与类型错误都拒绝', () => {
    expect(readString({}, 'k', 'core:x')).toBeUndefined()
    expect(readString({ k: '  v  ' }, 'k', 'core:x')).toBe('v')
    expect(captureThrown(() => readString({ k: '' }, 'k', 'core:x')).code).toBe('invalid-config')
    expect(captureThrown(() => readString({ k: 1 }, 'k', 'core:x')).code).toBe('invalid-config')
    expect(readRequiredString({ k: 'v' }, 'k', 'core:x')).toBe('v')
    expect(captureThrown(() => readRequiredString({}, 'k', 'core:x')).code).toBe('invalid-config')
  })

  it('readRawString：保留首尾空白（展示前缀这类值）', () => {
    expect(readRawString({}, 'k', 'core:x')).toBeUndefined()
    expect(readRawString({ k: ' [p] ' }, 'k', 'core:x')).toBe(' [p] ')
    expect(readRawString({ k: '' }, 'k', 'core:x')).toBe('')
    expect(captureThrown(() => readRawString({ k: 1 }, 'k', 'core:x')).code).toBe('invalid-config')
  })

  it('readBoolean：未写取 fallback，非布尔即抛', () => {
    expect(readBoolean({}, 'k', 'core:x', true)).toBe(true)
    expect(readBoolean({ k: false }, 'k', 'core:x', true)).toBe(false)
    expect(captureThrown(() => readBoolean({ k: 'yes' }, 'k', 'core:x', true)).code).toBe(
      'invalid-config',
    )
  })

  it('readPositiveInteger：未写 undefined，0 / 负数 / 小数 / 字符串都拒绝', () => {
    expect(readPositiveInteger({}, 'k', 'core:x')).toBeUndefined()
    expect(readPositiveInteger({ k: 3 }, 'k', 'core:x')).toBe(3)
    for (const bad of [0, -1, 1.5, '3', Number.NaN]) {
      expect(captureThrown(() => readPositiveInteger({ k: bad }, 'k', 'core:x')).code).toBe(
        'invalid-config',
      )
    }
  })

  it('readStringArray：未写 undefined，非数组 / 非字符串成员 / 空串成员都拒绝', () => {
    expect(readStringArray({}, 'k', 'core:x')).toBeUndefined()
    expect(readStringArray({ k: ['a', 'b'] }, 'k', 'core:x')).toEqual(['a', 'b'])
    expect(captureThrown(() => readStringArray({ k: 'a' }, 'k', 'core:x')).code).toBe(
      'invalid-config',
    )
    expect(captureThrown(() => readStringArray({ k: [1] }, 'k', 'core:x')).code).toBe(
      'invalid-config',
    )
    expect(captureThrown(() => readStringArray({ k: [''] }, 'k', 'core:x')).code).toBe(
      'invalid-config',
    )
  })

  it('readEnum：未写 undefined，非枚举值即抛（并列出允许值）', () => {
    expect(readEnum({}, 'k', 'core:x', ['a', 'b'] as const)).toBeUndefined()
    expect(readEnum({ k: 'b' }, 'k', 'core:x', ['a', 'b'] as const)).toBe('b')
    const error = captureThrown(() => readEnum({ k: 'c' }, 'k', 'core:x', ['a', 'b'] as const))
    expect(error.code).toBe('invalid-config')
    expect(error.message).toContain('a / b')
    expect(captureThrown(() => readEnum({ k: 1 }, 'k', 'core:x', ['a'] as const)).code).toBe(
      'invalid-config',
    )
  })

  it('describeValue：字符串加引号、undefined 原样、对象 JSON、循环引用退化为 String', () => {
    expect(describeValue('x')).toBe('"x"')
    expect(describeValue(undefined)).toBe('undefined')
    expect(describeValue({ a: 1 })).toBe('{"a":1}')
    expect(describeValue(3)).toBe('3')

    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(describeValue(circular)).toBe('[object Object]')
  })
})
