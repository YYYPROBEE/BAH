import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { replayArmedPlans, createArmedStore, executedInstanceKeys } from './armed.ts'
import { occurrenceOf } from './recurrence.ts'

import type { AnySessionEvent } from '../session/types.ts'
import type { ArmedPlan } from './types.ts'

function plan(overrides: Partial<ArmedPlan> = {}): ArmedPlan {
  return {
    planId: 'p-1',
    windowId: 'w-1',
    planDigest: 'digest-1',
    title: '生日采购',
    tier: 'standard',
    conditions: [{ kind: 'balance-at-least', cents: 100_000 }],
    budgetCents: 100_000,
    dueAt: 1_761_200_000_000,
    recurrence: { every: 'once', dueAt: 1_761_200_000_000 },
    plan: { planId: 'p-1', nodes: [] },
    armedAt: 1_761_199_000_000,
    state: 'armed',
    ...overrides,
  }
}

function resultEvent(name: string, payload: unknown, seq = 1): AnySessionEvent {
  return {
    seq,
    at: seq,
    formatVersion: 1,
    type: 'tool/result',
    data: {
      callId: `call-${String(seq)}`,
      name,
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
  } as AnySessionEvent
}

describe('ArmedStore', () => {
  it('arm / get / byPlan / listArmed', () => {
    const store = createArmedStore()
    store.arm(plan())
    expect(store.get('w-1')?.planId).toBe('p-1')
    expect(store.byPlan('p-1')).toHaveLength(1)
    expect(store.listArmed()).toHaveLength(1)
  })

  it('同一 windowId 重复武装 ⇒ window-duplicate（窗口是身份，不是缓存键）', () => {
    const store = createArmedStore()
    store.arm(plan())
    expect(captureThrown(() => store.arm(plan())).code).toBe('window-duplicate')
  })

  it('同一 planId 换窗口再武装是允许的（改预算后重新授权）', () => {
    const store = createArmedStore()
    store.arm(plan())
    store.arm(plan({ windowId: 'w-2', budgetCents: 50_000 }))
    expect(store.byPlan('p-1').map((item) => item.windowId)).toEqual(['w-1', 'w-2'])
  })

  it('disarm 幂等；未知窗口 ⇒ window-unknown', () => {
    const store = createArmedStore()
    store.arm(plan())
    expect(store.disarm('w-1').state).toBe('cancelled')
    expect(store.disarm('w-1').state).toBe('cancelled')
    expect(captureThrown(() => store.disarm('w-x')).code).toBe('window-unknown')
  })
})

describe('replayArmedPlans', () => {
  it('arm 后重建出同一条计划；disarm 后重建为 cancelled（不删除）', () => {
    const armed = plan()
    const events = [
      resultEvent('plan_arm', armed, 1),
      resultEvent('plan_disarm', { windowId: 'w-1', state: 'cancelled' }, 2),
    ]
    const replayed = replayArmedPlans(events)
    expect(replayed.list()).toHaveLength(1)
    expect(replayed.get('w-1')?.state).toBe('cancelled')
  })

  it('失败结果与无关工具不投影', () => {
    const failed = {
      ...resultEvent('plan_arm', plan(), 1),
      data: {
        callId: 'c1',
        name: 'plan_arm',
        isError: true,
        content: [{ type: 'text', text: 'boom' }],
      },
    } as AnySessionEvent
    const unrelated = resultEvent('goal_set', { anything: true }, 2)
    expect(replayArmedPlans([failed, unrelated]).list()).toHaveLength(0)
  })

  it('坏 JSON / 缺字段 ⇒ fail-loud（审计断代，不许猜）', () => {
    const badJson = {
      ...resultEvent('plan_arm', {}, 1),
      data: {
        callId: 'c1',
        name: 'plan_arm',
        isError: false,
        content: [{ type: 'text', text: 'not-json' }],
      },
    } as AnySessionEvent
    expect(captureThrown(() => replayArmedPlans([badJson])).code).toBe('window-replay-invalid')

    const missing = resultEvent('plan_arm', { planId: 'p-1' }, 2)
    expect(captureThrown(() => replayArmedPlans([missing])).code).toBe('window-replay-invalid')
  })

  it('结果不是对象（数组 / null）⇒ fail-loud，不把坏记录当窗口装进账本', () => {
    expect(captureThrown(() => replayArmedPlans([resultEvent('plan_arm', [], 1)])).code).toBe(
      'window-replay-invalid',
    )
    expect(captureThrown(() => replayArmedPlans([resultEvent('plan_arm', null, 2)])).code).toBe(
      'window-replay-invalid',
    )
  })

  it('plan_disarm 出参缺 windowId ⇒ fail-loud', () => {
    const broken = resultEvent('plan_disarm', { state: 'cancelled' }, 1)
    expect(captureThrown(() => replayArmedPlans([broken])).code).toBe('window-replay-invalid')
  })
})

describe('executedInstanceKeys（从 plan/created 派生，不新增事件键）', () => {
  const DAY = 24 * 60 * 60 * 1000

  function created(planId: string, at: number, seq = 1): AnySessionEvent {
    return { seq, at, formatVersion: 1, type: 'plan/created', data: { planId, at } } as unknown as AnySessionEvent
  }

  const daily = plan({
    planId: 'p-daily',
    windowId: 'w-daily',
    dueAt: 1_761_200_000_000,
    armedAt: 1_761_100_000_000,
    recurrence: { every: 'daily', at: '09:00' },
  })

  it('武装前的 run 不算；武装后的同实例 run 计入', () => {
    expect(executedInstanceKeys([created('p-daily', daily.armedAt - 1)], [daily]).size).toBe(0)
    const instance = occurrenceOf(daily.recurrence, daily.dueAt)
    expect(executedInstanceKeys([created('p-daily', daily.dueAt)], [daily]).has(`p-daily#${instance}`)).toBe(
      true,
    )
  })

  it('上一个实例的 run 不会吞掉当前实例', () => {
    const keys = executedInstanceKeys([created('p-daily', daily.dueAt - DAY)], [daily])
    expect(keys.size).toBe(0)
  })

  it('别的计划互不干扰', () => {
    const keys = executedInstanceKeys([created('p-other', daily.dueAt)], [daily])
    expect(keys.size).toBe(0)
  })
})
