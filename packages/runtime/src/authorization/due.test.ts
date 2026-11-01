import { describe, expect, it } from 'vitest'

import { duePlans, idempotencyKey } from './due.ts'
import { occurrenceOf } from './recurrence.ts'

import type { ArmedPlan } from './types.ts'

const NOW = 1_761_200_000_000

function plan(overrides: Partial<ArmedPlan>): ArmedPlan {
  return {
    planId: 'p-1',
    windowId: 'w-1',
    planDigest: 'd',
    title: 't',
    tier: 'standard',
    conditions: [],
    budgetCents: 1000,
    dueAt: NOW,
    recurrence: { every: 'once', dueAt: NOW },
    plan: { planId: 'p-1', nodes: [] },
    armedAt: NOW - 1000,
    state: 'armed',
    ...overrides,
  }
}

describe('duePlans：到期扫描', () => {
  it('只选 armed 且 dueAt<=at；按 dueAt 升序、同刻按 planId', () => {
    const armed = [
      plan({ planId: 'p-b', windowId: 'w-b', dueAt: NOW - 10 }),
      plan({ planId: 'p-a', windowId: 'w-a', dueAt: NOW - 10 }),
      plan({ planId: 'p-c', windowId: 'w-c', dueAt: NOW + 10 }),
      plan({ planId: 'p-x', windowId: 'w-x', dueAt: NOW - 20, state: 'cancelled' }),
    ]
    const scan = duePlans(armed, NOW, NOW)
    expect(scan.ok).toBe(true)
    if (!scan.ok) throw new Error('unreachable')
    expect(scan.due.map((item) => item.planId)).toEqual(['p-a', 'p-b'])
  })

  it('过期窗口不进清单', () => {
    const armed = [plan({ expiresAt: NOW - 1 })]
    const scan = duePlans(armed, NOW, NOW)
    expect(scan.ok).toBe(true)
    if (!scan.ok) throw new Error('unreachable')
    expect(scan.due).toHaveLength(0)
  })

  it('边界取等号：dueAt === at 应当到期；expiresAt === at 仍然有效', () => {
    const scan = duePlans([plan({ dueAt: NOW, expiresAt: NOW })], NOW, NOW)
    expect(scan.ok).toBe(true)
    if (!scan.ok) throw new Error('unreachable')
    expect(scan.due.map((item) => item.planId)).toEqual(['p-1'])
  })

  it('判定时刻超过 now+maxSkew ⇒ window-clock-ahead，且一条都不给', () => {
    const armed = [plan({ dueAt: NOW - 10 })]
    const scan = duePlans(armed, NOW + 10 * 60 * 1000, NOW)
    expect(scan).toEqual({ ok: false, code: 'window-clock-ahead', at: NOW + 600_000, now: NOW })
  })

  it('5 分钟漂移内允许（边界相等也允许）', () => {
    const scan = duePlans([], NOW + 5 * 60 * 1000, NOW)
    expect(scan.ok).toBe(true)
  })

  it('幂等键 = planId#occurrence，与判定时刻无关', () => {
    const daily = { every: 'daily', at: '09:00' } as const
    const first = idempotencyKey('p-1', occurrenceOf(daily, NOW))
    const second = idempotencyKey('p-1', occurrenceOf(daily, NOW + 60 * 60 * 1000))
    expect(first).toBe(second)
  })
})
