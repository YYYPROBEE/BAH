import { describe, expect, it } from 'vitest'

import type { ArmedPlan, WorldSnapshot } from './types.ts'
import { checkCondition, checkWindow, digestOfInputs } from './window.ts'

const NOW = 1_761_200_000_000

function window(overrides: Partial<ArmedPlan> = {}): ArmedPlan {
  return {
    planId: 'p-1',
    windowId: 'w-1',
    planDigest: 'digest-1',
    title: '生日采购',
    tier: 'standard',
    conditions: [],
    budgetCents: 100_000,
    dueAt: NOW,
    recurrence: { every: 'once', dueAt: NOW },
    plan: { planId: 'p-1', nodes: [] },
    armedAt: NOW - 1000,
    state: 'armed',
    ...overrides,
  }
}

function snapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    now: NOW,
    balanceCents: 500_000,
    factVersions: {},
    cancelledPlans: [],
    addressVersions: {},
    ...overrides,
  }
}

describe('checkWindow：条件复验', () => {
  it('无条件且未过期 ⇒ ok，且带输入与摘要', () => {
    const verdict = checkWindow(window(), snapshot(), NOW)
    expect(verdict.ok).toBe(true)
    expect(verdict.inputs.balanceCents).toBe(500_000)
    expect(verdict.inputs.planState).toBe('armed')
    expect(verdict.digest).toBe(digestOfInputs(verdict.inputs))
  })

  it('余额失守 ⇒ condition-failed + downgrade:ask（不自动放行）', () => {
    const verdict = checkWindow(
      window({ conditions: [{ kind: 'balance-at-least', cents: 600_000 }] }),
      snapshot(),
      NOW,
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.code).toBe('condition-failed')
    expect(verdict.downgrade).toBe('ask')
    expect(verdict.failed[0]).toEqual({
      kind: 'balance-at-least',
      expected: '>= 600000',
      actual: '500000',
    })
  })

  it('事实版本漂移 ⇒ condition-failed', () => {
    const verdict = checkWindow(
      window({ conditions: [{ kind: 'fact-unchanged', factId: 'f-1', version: 2 }] }),
      snapshot({ factVersions: { 'f-1': 3 } }),
      NOW,
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.failed).toEqual([
      { kind: 'fact-unchanged', expected: 'f-1@2', actual: 'f-1@3' },
    ])
  })

  it('事实缺失也算失守（宁可不执行）', () => {
    const verdict = checkWindow(
      window({ conditions: [{ kind: 'fact-unchanged', factId: 'f-9', version: 1 }] }),
      snapshot(),
      NOW,
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.failed[0]?.actual).toBe('缺失')
  })

  it('计划被撤销 ⇒ plan-cancelled（快照里的取消集合优先于窗口自身状态）', () => {
    const verdict = checkWindow(window(), snapshot({ cancelledPlans: ['p-1'] }), NOW)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.code).toBe('plan-cancelled')
  })

  it('窗口自身 state=cancelled 即失守（快照漏报取消集合也不许放行）', () => {
    const verdict = checkWindow(window({ state: 'cancelled' }), snapshot(), NOW)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.code).toBe('plan-cancelled')
    expect(verdict.failed).toContainEqual({
      kind: 'plan-not-cancelled',
      expected: 'armed',
      actual: 'cancelled',
    })
  })

  it('plan-not-cancelled 条件：目标计划未撤销通过；已撤销失守且主码为 plan-cancelled', () => {
    const condition = { kind: 'plan-not-cancelled', planId: 'p-2' } as const
    expect(checkCondition(condition, window(), snapshot())).toEqual({ ok: true })
    expect(checkCondition(condition, window(), snapshot({ cancelledPlans: ['p-2'] }))).toEqual({
      ok: false,
      failure: { kind: 'plan-not-cancelled', expected: '未被撤销', actual: '已撤销' },
    })

    const verdict = checkWindow(
      window({ conditions: [condition] }),
      snapshot({ cancelledPlans: ['p-2'] }),
      NOW,
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.code).toBe('plan-cancelled')
  })

  it('窗口已过期 ⇒ window-expired', () => {
    const verdict = checkWindow(window({ expiresAt: NOW - 1 }), snapshot(), NOW)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.code).toBe('window-expired')
  })

  it('判定时刻越界（远期 at）⇒ window-clock-ahead 优先级最高', () => {
    const verdict = checkWindow(
      window({ expiresAt: NOW - 1 }),
      snapshot(),
      NOW + 60 * 60 * 1000,
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.code).toBe('window-clock-ahead')
  })

  it('budget 越界（amount-within）与地址版本各有判据', () => {
    const overBudget = checkCondition(
      { kind: 'amount-within', cents: 50_000 },
      { budgetCents: 80_000, planId: 'p-1' },
      snapshot(),
    )
    expect(overBudget.ok).toBe(false)
    expect(overBudget.failure?.actual).toBe('80000')

    const addressMoved = checkCondition(
      { kind: 'address-unchanged', addressId: 'a-1', version: 1 },
      { budgetCents: 1, planId: 'p-1' },
      snapshot({ addressVersions: { 'a-1': 2 } }),
    )
    expect(addressMoved.ok).toBe(false)
    expect(addressMoved.failure?.expected).toBe('a-1@1')
  })

  it('摘要对输入敏感：改一个余额数字，digest 就变', () => {
    const left = checkWindow(window(), snapshot(), NOW)
    const right = checkWindow(window(), snapshot({ balanceCents: 500_001 }), NOW)
    expect(left.digest).not.toBe(right.digest)
  })

  it('摘要稳定：同一输入两次复验得到同一 digest（回放可重算的前提）', () => {
    const left = checkWindow(window(), snapshot(), NOW)
    const right = checkWindow(window(), snapshot(), NOW)
    expect(left.digest).toBe(right.digest)
  })
})
