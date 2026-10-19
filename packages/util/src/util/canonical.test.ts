/**
 * `canonicalJson` / `sha256Hex` 的口径用例（SA-11 T-SA11-006 / SA-16 批 1 第 4 步）。
 *
 * 三条硬断言：键序稳定、`undefined` 剔除、Unicode NFC 归一。
 */

import { describe, expect, it } from 'vitest'

import { canonicalJson, sha256Hex } from './canonical.ts'

describe('canonicalJson', () => {
  it('键序稳定：同一对象的不同书写顺序得到同一文本', () => {
    expect(canonicalJson({ b: 1, a: 2, c: { z: 3, y: 4 } })).toBe(
      canonicalJson({ c: { y: 4, z: 3 }, a: 2, b: 1 }),
    )
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('undefined 剔除：对象属性消失，数组元素记 null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]')
    expect(canonicalJson({ a: { b: undefined } })).toBe('{"a":{}}')
  })

  it('Unicode 归一：组合式与分解式字符得到同一摘要', () => {
    const composed = { name: 'caf\u00e9' }
    const decomposed = { name: 'cafe\u0301' }
    expect(canonicalJson(composed)).toBe(canonicalJson(decomposed))
    expect(sha256Hex(canonicalJson(composed))).toBe(sha256Hex(canonicalJson(decomposed)))
  })

  it('数字、布尔与 null 按 JSON 语义输出', () => {
    expect(canonicalJson({ n: -0, t: true, f: false, z: null })).toBe(
      '{"f":false,"n":0,"t":true,"z":null}',
    )
    expect(canonicalJson(1.5)).toBe('1.5')
  })

  it('拒绝非有限数、BigInt 与循环引用（不静默降级）', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/invalid-canonical-json/)
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/invalid-canonical-json/)
    expect(() => canonicalJson({ n: 1n })).toThrow(/invalid-canonical-json/)
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(/循环引用/)
  })
})

describe('sha256Hex', () => {
  it('与标准向量一致', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('接受字节序列', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'))
  })
})
