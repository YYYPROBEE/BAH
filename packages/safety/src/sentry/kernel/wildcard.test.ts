/**
 * 内核·工具名通配用例（施工单 10 §3 组件 8）。
 * 源用例：`tests/kernel.test.js` 的 wildcard 段 1 条全量搬迁；另补元字符字面量与锚定语义。
 */

import { describe, expect, it } from 'vitest'

import { wildcardToRegExp } from './wildcard.ts'

describe('wildcardToRegExp·与 Harness repeat-tool-reminder 同语义', () => {
  it('前缀通配命中本族工具名', () => {
    expect(wildcardToRegExp('transfer*').test('transfer_funds')).toBe(true)
    expect(wildcardToRegExp('transfer*').test('transfer')).toBe(true)
    expect(wildcardToRegExp('mcp_*').test('mcp_search')).toBe(true)
    expect(wildcardToRegExp('pay').test('pay')).toBe(true)
  })

  it('整串锚定：后缀命中与通配开头都不算命中', () => {
    expect(wildcardToRegExp('transfer*').test('my_transfer')).toBe(false)
    expect(wildcardToRegExp('*transfer').test('my_transfer')).toBe(true)
    expect(wildcardToRegExp('pay').test('payment')).toBe(false)
  })

  it('除 `*` 外的正则元字符按字面量处理', () => {
    expect(wildcardToRegExp('a.b').test('a.b')).toBe(true)
    expect(wildcardToRegExp('a.b').test('axb')).toBe(false)
    expect(wildcardToRegExp('weird[').test('weird[')).toBe(true)
    expect(wildcardToRegExp('pay(x)').test('pay(x)')).toBe(true)
    expect(wildcardToRegExp('pay(x)').test('pay')).toBe(false)
  })

  it('编译结果是锚定正则（大小写敏感）', () => {
    expect(String(wildcardToRegExp('transfer*'))).toBe('/^transfer.*$/')
    expect(wildcardToRegExp('pay').test('PAY')).toBe(false)
  })
})
