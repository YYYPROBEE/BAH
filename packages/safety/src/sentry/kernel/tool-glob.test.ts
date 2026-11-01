/**
 * 内核·工具名通配用例。
 *
 * 覆盖四类语义：前缀通配命中、整串锚定、元字符字面量、编译结果形态；
 * 另补两条组合路径（空模式、多星号），因为它们走的是分段拼接而非单次替换。
 */

import { describe, expect, it } from 'vitest'

import { compileToolGlob } from './tool-glob.ts'

describe('compileToolGlob·工具名通配语义', () => {
  it('前缀通配命中本族工具名', () => {
    expect(compileToolGlob('transfer*').test('transfer_funds')).toBe(true)
    expect(compileToolGlob('transfer*').test('transfer')).toBe(true)
    expect(compileToolGlob('mcp_*').test('mcp_search')).toBe(true)
    expect(compileToolGlob('pay').test('pay')).toBe(true)
  })

  it('整串锚定：后缀命中与通配开头都不算命中', () => {
    expect(compileToolGlob('transfer*').test('my_transfer')).toBe(false)
    expect(compileToolGlob('*transfer').test('my_transfer')).toBe(true)
    expect(compileToolGlob('pay').test('payment')).toBe(false)
  })

  it('除 `*` 外的正则元字符按字面量处理', () => {
    expect(compileToolGlob('a.b').test('a.b')).toBe(true)
    expect(compileToolGlob('a.b').test('axb')).toBe(false)
    expect(compileToolGlob('weird[').test('weird[')).toBe(true)
    expect(compileToolGlob('pay(x)').test('pay(x)')).toBe(true)
    expect(compileToolGlob('pay(x)').test('pay')).toBe(false)
  })

  it('编译结果是锚定正则（大小写敏感）', () => {
    expect(String(compileToolGlob('transfer*'))).toBe('/^transfer.*$/')
    expect(compileToolGlob('pay').test('PAY')).toBe(false)
  })

  it('空模式只命中空串', () => {
    expect(compileToolGlob('').test('')).toBe(true)
    expect(compileToolGlob('').test('any_tool')).toBe(false)
    expect(String(compileToolGlob(''))).toBe('/^$/')
  })

  it('多星号拼接为连续任意串', () => {
    expect(String(compileToolGlob('a**b'))).toBe('/^a.*.*b$/')
    expect(compileToolGlob('a**b').test('aXYb')).toBe(true)
    expect(compileToolGlob('**').test('anything')).toBe(true)
  })
})
