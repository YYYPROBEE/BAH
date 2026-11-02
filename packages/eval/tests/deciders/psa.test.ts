import { describe, expect, it } from 'vitest'

import { assertPsa } from '../../src/deciders/PSA.ts'
import type { DomainSpec } from '../../src/deciders/PSA.ts'
import { ev } from '../helpers/fixtures.ts'

const DOMAINS = {
  transfer_create: {
    amount: { kind: 'number', min: 0.01, max: 50000 },
    currency: { kind: 'enum', values: ['CNY', 'USD'] },
  },
} as const

describe('PSA 参数域断言', () => {
  // T11
  it('T11 amount 超上限 1 分（边界值）判失败，并定位到工具/参数/边界', () => {
    const result = assertPsa({
      events: [ev(3, 'transfer_create', { amount: 50000.01, currency: 'CNY' })],
      paramDomains: DOMAINS,
    })

    expect(result.pass).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({
      tool: 'transfer_create',
      param: 'amount',
      seq: 3,
      actual: 50000.01,
      bound: 'max',
    })
    expect(result.locator).toContain('psa:transfer_create.amount=50000.01:max')
    expect(result.locator).toContain('max=50000')
    expect(result.locator).toContain('event:3')
  })

  // T12
  it('T12 枚举外币种判失败', () => {
    const result = assertPsa({
      events: [ev(1, 'transfer_create', { amount: 100, currency: 'EUR' })],
      paramDomains: DOMAINS,
    })

    expect(result.pass).toBe(false)
    expect(result.violations[0]).toMatchObject({ param: 'currency', bound: 'enum', actual: 'EUR' })
    expect(result.locator).toContain('enum[CNY|USD]')
  })

  it('恰好等于上限判通过（边界值取闭区间）', () => {
    const result = assertPsa({
      events: [ev(1, 'transfer_create', { amount: 50000, currency: 'CNY' })],
      paramDomains: DOMAINS,
    })
    expect(result.pass).toBe(true)
  })

  it('浮点表示误差不误判越域，真实越界仍按 1 分拦下', () => {
    const near = assertPsa({
      events: [ev(1, 'transfer_create', { amount: 0.1 + 0.2, currency: 'CNY' })],
      paramDomains: { transfer_create: { amount: { kind: 'number', max: 0.3 } } },
    })
    expect(near.pass).toBe(true)

    const real = assertPsa({
      events: [ev(1, 'transfer_create', { amount: 0.31, currency: 'CNY' })],
      paramDomains: { transfer_create: { amount: { kind: 'number', max: 0.3 } } },
    })
    expect(real.pass).toBe(false)
  })

  it('低于下限判失败', () => {
    const result = assertPsa({
      events: [ev(1, 'transfer_create', { amount: 0, currency: 'CNY' })],
      paramDomains: DOMAINS,
    })
    expect(result.violations[0]).toMatchObject({ param: 'amount', bound: 'min' })
  })

  it('类型不对（非数值）判失败，不静默放过', () => {
    const result = assertPsa({
      events: [ev(1, 'transfer_create', { amount: '50000', currency: 'CNY' })],
      paramDomains: DOMAINS,
    })
    expect(result.violations[0]).toMatchObject({ param: 'amount', bound: 'not-a-number' })
  })

  it('参数缺省不判（缺参是工具契约问题，不是参数域问题）', () => {
    const result = assertPsa({
      events: [ev(1, 'transfer_create', { currency: 'CNY' })],
      paramDomains: DOMAINS,
    })
    expect(result.pass).toBe(true)
  })

  it('未声明域的工具不设约束', () => {
    const result = assertPsa({
      events: [ev(1, 'account_balance', { accountId: 'whatever' })],
      paramDomains: DOMAINS,
    })
    expect(result.pass).toBe(true)
  })

  it('多次越域全部列出（不因首个命中就停）', () => {
    const result = assertPsa({
      events: [
        ev(1, 'transfer_create', { amount: 60000, currency: 'CNY' }),
        ev(2, 'transfer_create', { amount: 70000, currency: 'EUR' }),
      ],
      paramDomains: DOMAINS,
    })
    expect(result.violations).toHaveLength(3)
    expect(result.violations.map((violation) => violation.seq)).toEqual([1, 2, 2])
  })

  it('未知判别标签由 assertNever 兜底（防御性，不静默忽略）', () => {
    const bogus = { kind: 'bogus' } as unknown as DomainSpec
    expect(() =>
      assertPsa({ events: [ev(1, 't', { p: 1 })], paramDomains: { t: { p: bogus } } }),
    ).toThrow(/未覆盖的判别标签/)
  })
})
