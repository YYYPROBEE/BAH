/**
 * 计划卡（G7）的投影用例：只喂事件，断言帧。
 *
 * 四条口径：
 * 1. `plan_arm` 成功 → 一张 `plan-card`（state=armed，条件 = unknown）；
 * 2. `plan_wake` 失守 → 同 key 替换成 failed，并带 `lastVerdict.code` 与条件实际值；
 * 3. `plan_disarm` → state=cancelled（不删卡，审计要看得见撤回过什么）；
 * 4. 失败调用 / 坏 JSON 一律不投影（宁可少一张，不造一张假的）。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { projectSession } from './project.ts'
import type { PlanCardFrame } from './frames.ts'

let cursor = 0

function ev(type: string, data: unknown, at = 1_761_200_000_000): AnySessionEvent {
  cursor += 1
  return { seq: cursor, at, formatVersion: 1, type, data } as unknown as AnySessionEvent
}

const ARMED = {
  planId: 'plan-1',
  windowId: 'w-call-1',
  planDigest: 'sha-1',
  title: '生日采购',
  tier: 'standard',
  conditions: [
    { kind: 'balance-at-least', cents: 100_000 },
    { kind: 'fact-unchanged', factId: 'f-1', version: 2 },
  ],
  budgetCents: 80_000,
  dueAt: 1_761_300_000_000,
  occurrence: 'once:1761300000000',
  recurrence: { every: 'once', dueAt: 1_761_300_000_000 },
  plan: { planId: 'plan-1', nodes: [{ id: 'n1', tool: 'transfer_create', args: {}, deps: [] }] },
  armedAt: 1_761_200_000_000,
  state: 'armed',
}

function toolResult(name: string, payload: unknown, isError = false): AnySessionEvent {
  return ev('tool/result', {
    callId: `call-${String(cursor + 1)}`,
    name,
    isError,
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
  })
}

function planCards(events: readonly AnySessionEvent[]): PlanCardFrame[] {
  return [...projectSession(events).frames].filter(
    (frame): frame is PlanCardFrame => frame.kind === 'plan-card',
  )
}

describe('plan-card 投影', () => {
  it('plan_arm 成功 ⇒ 一张 armed 卡（四块信息齐）', () => {
    cursor = 0
    const cards = planCards([toolResult('plan_arm', ARMED)])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      windowId: 'w-call-1',
      planId: 'plan-1',
      tier: 'standard',
      state: 'armed',
      nodeCount: 1,
      dueAt: 1_761_300_000_000,
      digest: 'sha-1',
    })
    expect(cards[0]?.conditions.map((condition) => condition.kind)).toEqual([
      'balance-at-least',
      'fact-unchanged',
    ])
    expect(cards[0]?.conditions.every((condition) => condition.state === 'unknown')).toBe(true)
  })

  it('plan_wake 失守 ⇒ 同 key 替换为 failed + 判决码 + 条件实际值', () => {
    cursor = 0
    const frames = projectSession([
      toolResult('plan_arm', ARMED),
      toolResult('plan_wake', {
        at: ARMED.dueAt,
        now: ARMED.dueAt,
        source: 'tool',
        ok: true,
        entries: [
          {
            planId: 'plan-1',
            windowId: 'w-call-1',
            occurrence: 'once:1761300000000',
            key: 'plan-1#once:1761300000000',
            status: 'downgraded',
            code: 'condition-failed',
            digest: 'digest-x',
            failed: [
              { kind: 'balance-at-least', expected: '>= 100000', actual: '60000' },
            ],
          },
        ],
        notified: [],
      }),
    ])
    const cards = frames.frames.filter((frame): frame is PlanCardFrame => frame.kind === 'plan-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.state).toBe('failed')
    expect(cards[0]?.lastVerdict?.code).toBe('condition-failed')
    expect(cards[0]?.conditions[0]).toMatchObject({ state: 'failed', actual: '60000' })
    expect(cards[0]?.conditions[1]?.state).toBe('unknown')
  })

  it('plan_wake 成功 ⇒ done（失败节点数>0 ⇒ failed）', () => {
    cursor = 0
    const wake = (failed: number): AnySessionEvent =>
      toolResult('plan_wake', {
        at: ARMED.dueAt,
        now: ARMED.dueAt,
        source: 'tick',
        ok: true,
        entries: [
          {
            planId: 'plan-1',
            windowId: 'w-call-1',
            occurrence: 'once:1761300000000',
            key: 'k',
            status: 'executed',
            summary: { status: failed > 0 ? 'failed' : 'succeeded', succeeded: 1 - failed, failed, blocked: 0, durationMs: 10 },
          },
        ],
        notified: [],
      })
    expect(planCards([toolResult('plan_arm', ARMED), wake(0)])[0]?.state).toBe('done')
    cursor = 0
    expect(planCards([toolResult('plan_arm', ARMED), wake(1)])[0]?.state).toBe('failed')
  })

  it('plan_disarm ⇒ cancelled（卡保留）', () => {
    cursor = 0
    const cards = planCards([
      toolResult('plan_arm', ARMED),
      toolResult('plan_disarm', { windowId: 'w-call-1', planId: 'plan-1', state: 'cancelled' }),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0]?.state).toBe('cancelled')
  })

  it('失败调用 / 坏 JSON / 未知窗口的唤醒条目 ⇒ 不投影', () => {
    cursor = 0
    const failed = toolResult('plan_arm', ARMED, true)
    const badJson = toolResult('plan_arm', 'not-json')
    const orphan = toolResult('plan_wake', {
      ok: true,
      entries: [{ windowId: 'w-unknown', planId: 'p', status: 'executed' }],
    })
    expect(planCards([failed, badJson, orphan])).toHaveLength(0)
  })
})
