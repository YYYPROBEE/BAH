/**
 * 断路器锁存（施工单 10 §5）：窗口计数 → 锁存冻结 → 吊销票据；显式解冻是唯一解除路径。
 */

import { describe, expect, it } from 'vitest'

import { TraceLog } from '../kernel/index.ts'

import { SentryBreaker } from './breaker.ts'
import { resolveSentrySettings } from './config.ts'
import type { SentrySessionEventType } from './events.ts'
import { SentryState } from './state.ts'

/** 造一个可拨时钟 + 事件收集器。 */
function harness(overrides: Readonly<Record<string, unknown>> = {}): {
  readonly breaker: SentryBreaker
  readonly events: { type: SentrySessionEventType; data: unknown }[]
  readonly revoked: { reason: string; at: number }[]
  readonly trace: TraceLog
  tick(at: number): void
} {
  // W08：trace.sink 无缺省值；单测不必落盘，显式选 memory
  const settings = resolveSentrySettings({ trace: { sink: 'memory' }, ...overrides })
  const state = new SentryState()
  let now = 1_000
  const events: { type: SentrySessionEventType; data: unknown }[] = []
  const revoked: { reason: string; at: number }[] = []
  const trace = new TraceLog({ now: () => now })
  const breaker = new SentryBreaker({
    sessionId: 's-1',
    settings: settings.breaker,
    state,
    now: () => now,
    trace,
    record: (type, data) => events.push({ type, data }),
    revokeTickets: (reason, at) => {
      revoked.push({ reason, at })
      return 2
    },
  })
  return {
    breaker,
    events,
    revoked,
    trace,
    tick(at: number) {
      now = at
    },
  }
}

describe('SentryBreaker（窗口 + 锁存 + 解冻）', () => {
  it('T-SNT-008 窗口拒绝数达阈值 → 锁存冻结 + 吊销票据（事件只落一次）', () => {
    const { breaker, events, revoked, trace } = harness()
    for (let index = 1; index <= 4; index += 1) {
      expect(breaker.recordDeny(`call-${index}`, 1_000 + index)).toBe(false)
    }
    expect(breaker.frozen).toBe(false)
    expect(breaker.recordDeny('call-5', 1_005)).toBe(true)
    expect(breaker.frozen).toBe(true)
    expect(revoked).toEqual([{ reason: 'sentry-breaker-frozen', at: 1_005 }])
    expect(events.filter((event) => event.type === 'sentry/breaker-frozen')).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({ denies: 5, windowSeconds: 600, ticketsRevoked: 2 })
    expect(trace.counters.breakerTrips).toBe(1)
    // 冻结后新的拒绝不再触发第二次冻结
    expect(breaker.recordDeny('call-6', 1_006)).toBe(false)
    expect(revoked).toHaveLength(1)
  })

  it('同一次调用重复上报只计一次拒绝', () => {
    const { breaker } = harness()
    for (let index = 1; index <= 5; index += 1) {
      expect(breaker.recordDeny('call-same', 1_000 + index)).toBe(false)
    }
    expect(breaker.frozen).toBe(false)
    expect(breaker.countInWindow(1_005)).toBe(1)
  })

  it('T-SNT-009 锁存后窗口滑出仍冻结（窗口不是解冻计时器）', () => {
    const { breaker, tick } = harness({ breaker: { denyThreshold: 2, windowSeconds: 10 } })
    breaker.recordDeny('call-1', 1_000)
    breaker.recordDeny('call-2', 1_001)
    expect(breaker.frozen).toBe(true)

    tick(1_000 + 60_000)
    expect(breaker.countInWindow(1_000 + 60_000)).toBe(0)
    expect(breaker.frozen).toBe(true)
  })

  it('T-SNT-010 显式人工解冻是唯一解除路径；未冻结时是 no-op', () => {
    const { breaker, events, tick } = harness({ breaker: { denyThreshold: 1, windowSeconds: 600 } })
    expect(breaker.unfreeze('ops', 'not-frozen', 1_000)).toBe(false)
    expect(events).toHaveLength(0)

    breaker.recordDeny('call-1', 1_000)
    expect(breaker.frozen).toBe(true)
    tick(1_100)
    expect(breaker.unfreeze('ops', '人工复核通过', 1_100)).toBe(true)
    expect(breaker.frozen).toBe(false)
    expect(breaker.countInWindow(1_100)).toBe(0)
    expect(events.map((event) => event.type)).toEqual(['sentry/breaker-frozen', 'sentry/unfrozen'])

    // 解冻后重新计数：再次达到阈值才会再冻结
    expect(breaker.recordDeny('call-2', 1_200)).toBe(true)
  })

  it('revokeTickets=false 时冻结仍落账，但不吊销票据', () => {
    const { breaker, events, revoked } = harness({
      breaker: { denyThreshold: 1, revokeTickets: false },
    })
    breaker.recordDeny('call-1', 1_000)
    expect(breaker.frozen).toBe(true)
    expect(revoked).toEqual([])
    expect(events[0]?.data).toMatchObject({ ticketsRevoked: 0 })
  })
})
