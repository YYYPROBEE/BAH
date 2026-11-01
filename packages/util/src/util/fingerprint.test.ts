/**
 * 参数指纹（`parameterFingerprint`）的安全性质用例。
 *
 * 指纹同时是**三样东西的键**：票据五绑定、单调 guard 的 deny 表、`tool/call` 落账字段
 * （见 `packages/runtime/src/tools/guard.ts` 与 `packages/bank/src/tools/fingerprint.ts`）。
 * 单调 guard 的语义是「同名同参一旦被判 deny，本 turn 内维持 deny」——
 * 模型不能靠改一下参数书写顺序把已经拒绝的操作磨过去。
 *
 * 所以这里钉的不是「函数返回值长什么样」，而是那条**抗绕过性质**：
 * 键序无关、值敏感、工具名参与、定长、异常输入 fail-loud。
 * 任何一条被改坏都不会报错，只会让 guard 的 deny 表静默漏键。
 */

import { describe, expect, it } from 'vitest'

import { FINGERPRINT_HEX_LENGTH, parameterFingerprint } from './fingerprint.ts'

describe('parameterFingerprint：抗绕过性质', () => {
  it('键序无关：同一份参数换个书写顺序必须得到同一个指纹', () => {
    // 这是最关键的一条——若退化成 JSON.stringify，模型只要重排键就能绕开已记录的 deny。
    expect(parameterFingerprint('transfer', { to: 'A', amountCents: 100 })).toBe(
      parameterFingerprint('transfer', { amountCents: 100, to: 'A' }),
    )
  })

  it('嵌套对象同样键序无关（脱敏/重排只会发生在深层）', () => {
    const deep = { a: { x: 1, y: { p: 2, q: 3 } }, b: [1, 2] }
    const reordered = { b: [1, 2], a: { y: { q: 3, p: 2 }, x: 1 } }
    expect(parameterFingerprint('pay', deep)).toBe(parameterFingerprint('pay', reordered))
  })

  it('值敏感：一个分（cents）之差就是另一个指纹', () => {
    expect(parameterFingerprint('transfer', { amountCents: 100 })).not.toBe(
      parameterFingerprint('transfer', { amountCents: 101 }),
    )
  })

  it('工具名参与：对 `query` 的 deny 不许连带锁住 `transfer` 的同参数调用', () => {
    const args = { amountCents: 100 }
    const queried = parameterFingerprint('query', args)
    const transferred = parameterFingerprint('transfer', args)
    expect(queried).not.toBe(transferred)
    expect(queried.startsWith('query:')).toBe(true)
  })

  it('形状固定为 `<tool>:<32 位 hex>`，且不随参数体积增长（审计字段可预期）', () => {
    const small = parameterFingerprint('query', {})
    const huge = parameterFingerprint('query', { blob: 'x'.repeat(100_000) })
    expect(/^[A-Za-z0-9_-]+:[0-9a-f]{32}$/.test(small)).toBe(true)
    expect(huge.length).toBe(small.length)
  })

  it('undefined 值与缺键同指纹（canonicalJson 的剔除口径确实穿透到了这里）', () => {
    expect(parameterFingerprint('query', { a: 1, b: undefined })).toBe(parameterFingerprint('query', { a: 1 }))
  })

  it('同一输入两次调用得到同一指纹（Map 键必须稳定，否则 deny 表每次都不一样）', () => {
    const args = { cardId: 'c-1', tier: 'standard' }
    expect(parameterFingerprint('card_freeze', args)).toBe(parameterFingerprint('card_freeze', args))
  })

  it('非有限数与 BigInt 参数 fail-loud（不许静默降级成一个恒定指纹）', () => {
    expect(() => parameterFingerprint('transfer', { amountCents: Number.NaN })).toThrow(/invalid-canonical-json/)
    expect(() => parameterFingerprint('transfer', { amountCents: Number.POSITIVE_INFINITY })).toThrow(
      /invalid-canonical-json/,
    )
    expect(() => parameterFingerprint('transfer', { amountCents: 1_00n })).toThrow(/invalid-canonical-json/)
  })

  it('截断长度与导出的常量一致（口径只有一处定义）', () => {
    const [, hex] = parameterFingerprint('t', {}).split(':')
    expect((hex ?? '').length).toBe(FINGERPRINT_HEX_LENGTH)
  })
})
