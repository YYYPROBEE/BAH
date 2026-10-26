/**
 * HALT 状态机（W07 / HP-3 的纯逻辑面）。
 *
 * 六件必须钉住的事：
 * 1. 三态触发原因与幂等（重复 HALT / 重复解除都不落重复事件）；
 * 2. P0 累计 3 次才触发，解除后清零；
 * 3. 解除票据四条校验：存在 / approved / mfa / 未过期；
 * 4. 票据一次性（解完即作废，重放不可能再解）；
 * 5. `requestUnfreeze` 没有审批端口时**不造票**（fail-closed）；
 * 6. 关掉开关时全部失效（回滚开关的行为本身也要被钉住）。
 */

import { describe, expect, it } from 'vitest'

import {
  HALT_SERVICE,
  HaltState,
  P0_HALT_AFTER_HITS,
  SAFETY_SESSION_EVENT_TYPES,
  type HaltEvent,
  type HaltTicket,
} from './halt.ts'

/** 固定时钟（每条用例可改 `at`）。 */
function clock(start = 1_792_000_000_000): { now: () => number; set: (value: number) => void } {
  let value = start
  return {
    now: () => value,
    set: (next) => {
      value = next
    },
  }
}

/** 解构一个状态机 + 事件收集器。 */
function harness(options: {
  readonly enabled?: boolean
  readonly requestTicket?: () => Promise<HaltTicket | undefined>
} = {}): {
  readonly halt: HaltState
  readonly events: HaltEvent[]
  readonly clock: ReturnType<typeof clock>
} {
  const time = clock()
  const events: HaltEvent[] = []
  const halt = new HaltState({
    now: time.now,
    recordHalt: (event) => events.push(event),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.requestTicket === undefined ? {} : { requestTicket: options.requestTicket }),
  })
  return { halt, events, clock: time }
}

/** 一张合法的 MFA 票据（默认 approved + mfa + 未过期）。 */
function ticket(overrides: Partial<HaltTicket> = {}): HaltTicket {
  return {
    ticketId: 't-unfreeze-1',
    status: 'approved',
    expiresAt: 1_792_000_000_000 + 120_000,
    mfa: true,
    ...overrides,
  }
}

describe('TC-W07-07 HALT 状态与幂等', () => {
  it('初始 RUNNING / enabled，view 不带 reason/detail', () => {
    const { halt } = harness()
    expect(halt.enabled).toBe(true)
    expect(halt.status).toBe('RUNNING')
    expect(halt.halted).toBe(false)
    expect(halt.reason).toBeUndefined()
    expect(halt.view()).toEqual({ enabled: true, status: 'RUNNING', halted: false, p0Hits: 0 })
  })

  it('manual HALT：落一条 safety/halt（载荷逐字冻结），重复 HALT 不落第二条', () => {
    const { halt, events } = harness()
    expect(halt.halt('manual', '值班主管按下停机')).toBe(true)
    expect(halt.halted).toBe(true)
    expect(halt.reason).toBe('manual')
    expect(events).toEqual([
      {
        type: 'safety/halt',
        data: { reason: 'manual', detail: '值班主管按下停机', at: 1_792_000_000_000 },
      },
    ])

    expect(halt.halt('manual')).toBe(false)
    expect(halt.halt('chain-broken')).toBe(false)
    expect(events).toHaveLength(1)
    // 首因不被后来的调用改写（审计要回答"为什么停的"）
    expect(halt.reason).toBe('manual')
  })

  it('不带 detail 时事件里没有 detail 键（不是 undefined 占位）', () => {
    const { halt, events } = harness()
    halt.halt('chain-broken')
    expect(events[0]).toEqual({
      type: 'safety/halt',
      data: { reason: 'chain-broken', at: 1_792_000_000_000 },
    })
    expect('detail' in (events[0]?.data ?? {})).toBe(false)
  })

  it('关闭开关后 halt 是 no-op', () => {
    const { halt, events } = harness({ enabled: false })
    expect(halt.enabled).toBe(false)
    expect(halt.halt('manual')).toBe(false)
    expect(halt.halted).toBe(false)
    expect(events).toHaveLength(0)
    expect(halt.view()).toEqual({ enabled: false, status: 'RUNNING', halted: false, p0Hits: 0 })
  })
})

describe('P0 阈值（写死 3 次）', () => {
  it('前两次不触发，第 3 次进入 HALT 且 detail 带计数', () => {
    const { halt, events } = harness()
    expect(P0_HALT_AFTER_HITS).toBe(3)
    expect(halt.noteP0Hit()).toBe(false)
    expect(halt.noteP0Hit()).toBe(false)
    expect(halt.halted).toBe(false)
    expect(events).toHaveLength(0)

    expect(halt.noteP0Hit()).toBe(true)
    expect(halt.halted).toBe(true)
    expect(halt.reason).toBe('p0-threshold')
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('safety/halt')
    expect(events[0]?.data).toMatchObject({
      reason: 'p0-threshold',
      detail: 'P0 规则累计命中 3 次（阈值 3）',
    })
    expect(halt.view().p0Hits).toBe(3)
  })

  it('已 HALT 或已关闭时不再累计', () => {
    const on = harness()
    on.halt.halt('manual')
    expect(on.halt.noteP0Hit()).toBe(false)
    expect(on.events).toHaveLength(1)

    const off = harness({ enabled: false })
    expect(off.halt.noteP0Hit()).toBe(false)
    expect(off.halt.view().p0Hits).toBe(0)
  })

  it('解除后计数清零：再命中两次不会立刻停，第三次才停', () => {
    const { halt, events } = harness()
    halt.noteP0Hit()
    halt.noteP0Hit()
    halt.noteP0Hit()
    halt.registerTicket(ticket())
    expect(halt.unfreeze('t-unfreeze-1')).toEqual({ ok: true })
    expect(halt.view().p0Hits).toBe(0)

    expect(halt.noteP0Hit()).toBe(false)
    expect(halt.noteP0Hit()).toBe(false)
    expect(halt.halted).toBe(false)
    expect(halt.noteP0Hit()).toBe(true)
    expect(events.filter((event) => event.type === 'safety/halt')).toHaveLength(2)
  })
})

describe('TC-W07-04 / 05 解除票据校验', () => {
  it('非 HALTED 时拒绝，且不落事件', () => {
    const { halt, events } = harness()
    expect(halt.unfreeze('t-unfreeze-1')).toEqual({ ok: false, code: 'halt-not-halted' })
    expect(events).toHaveLength(0)
  })

  it('关闭开关时拒绝', () => {
    const { halt } = harness({ enabled: false })
    expect(halt.unfreeze('t-unfreeze-1')).toEqual({ ok: false, code: 'halt-disabled' })
  })

  it('未知票据 / 非 approved / 无 MFA / 已过期 四类都拒绝，状态仍 HALTED', () => {
    const { halt, events } = harness()
    halt.halt('manual')

    expect(halt.unfreeze('t-missing')).toEqual({ ok: false, code: 'halt-ticket-unknown' })

    halt.registerTicket(ticket({ ticketId: 't-issued', status: 'issued' }))
    expect(halt.unfreeze('t-issued')).toEqual({ ok: false, code: 'halt-ticket-not-approved' })

    halt.registerTicket(ticket({ ticketId: 't-redeemed', status: 'redeemed' }))
    expect(halt.unfreeze('t-redeemed')).toEqual({ ok: false, code: 'halt-ticket-not-approved' })

    halt.registerTicket(ticket({ ticketId: 't-no-mfa', mfa: false }))
    expect(halt.unfreeze('t-no-mfa')).toEqual({ ok: false, code: 'halt-ticket-mfa-required' })

    halt.registerTicket(ticket({ ticketId: 't-expired', expiresAt: 1_792_000_000_000 }))
    expect(halt.unfreeze('t-expired')).toEqual({ ok: false, code: 'halt-ticket-expired' })

    expect(halt.halted).toBe(true)
    // 只有最初那条 safety/halt；失败尝试不落 safety/unfreeze
    expect(events).toHaveLength(1)
  })

  it('有效票据解除：状态回 RUNNING、落 safety/unfreeze，票据一次性', () => {
    const { halt, events, clock } = harness()
    halt.halt('manual')
    halt.registerTicket(ticket())
    clock.set(1_792_000_000_010)

    expect(halt.unfreeze('t-unfreeze-1')).toEqual({ ok: true })
    expect(halt.status).toBe('RUNNING')
    expect(halt.reason).toBeUndefined()
    expect(events[1]).toEqual({
      type: 'safety/unfreeze',
      data: { ticketId: 't-unfreeze-1', mfa: true, at: 1_792_000_000_010 },
    })

    // 重复解除：不是 HALTED，因此 no-op（不落第二条）
    expect(halt.unfreeze('t-unfreeze-1')).toEqual({ ok: false, code: 'halt-not-halted' })
    expect(events).toHaveLength(2)

    // 再 HALT 后重放同一张票：票已作废
    halt.halt('manual')
    expect(halt.unfreeze('t-unfreeze-1')).toEqual({ ok: false, code: 'halt-ticket-unknown' })
    expect(halt.halted).toBe(true)
  })
})

describe('requestUnfreeze（票据只能来自会话内审批）', () => {
  it('未 HALT / 已关闭 → 拒绝', async () => {
    await expect(harness().halt.requestUnfreeze()).resolves.toEqual({
      ok: false,
      code: 'halt-not-halted',
    })
    await expect(harness({ enabled: false }).halt.requestUnfreeze()).resolves.toEqual({
      ok: false,
      code: 'halt-disabled',
    })
  })

  it('没有审批端口 → halt-approval-absent（绝不自己造票）', async () => {
    const { halt } = harness()
    halt.halt('manual')
    await expect(halt.requestUnfreeze()).resolves.toEqual({
      ok: false,
      code: 'halt-approval-absent',
    })
  })

  it('审批拒绝（端口返回 undefined）→ halt-approval-rejected', async () => {
    const { halt } = harness({ requestTicket: () => Promise.resolve(undefined) })
    halt.halt('manual')
    await expect(halt.requestUnfreeze()).resolves.toEqual({
      ok: false,
      code: 'halt-approval-rejected',
    })
    expect(halt.halted).toBe(true)
  })

  it('审批通过 → 返回票号并自动登记，随后可解除', async () => {
    const issued = ticket({ ticketId: 't-from-approval' })
    const { halt } = harness({ requestTicket: () => Promise.resolve(issued) })
    halt.halt('manual')

    await expect(halt.requestUnfreeze()).resolves.toEqual({
      ok: true,
      ticketId: 't-from-approval',
      expiresAt: issued.expiresAt,
    })
    expect(halt.unfreeze('t-from-approval')).toEqual({ ok: true })
  })
})

describe('事件表声明（TC-W07-06 的声明面）', () => {
  it('两个键逐字冻结；服务键是 safety:halt', () => {
    expect(SAFETY_SESSION_EVENT_TYPES).toEqual(['safety/halt', 'safety/unfreeze'])
    expect(HALT_SERVICE.id).toBe('safety:halt')
  })
})

describe('票据登记表的内存边界（长跑宿主）', () => {
  it('注册新票时清掉过期票；过期票被拒后即删除（再试是 unknown）', () => {
    const { halt, clock } = harness()
    halt.halt('manual')
    halt.registerTicket(ticket({ ticketId: 't-expired', expiresAt: 1_792_000_000_000 + 10 }))
    clock.set(1_792_000_000_000 + 20)

    // 注册新票触发清理：过期票被删，再解是 unknown 而不是 expired
    halt.registerTicket(ticket({ ticketId: 't-fresh', expiresAt: 1_792_000_000_000 + 120_000 }))
    expect(halt.unfreeze('t-expired')).toEqual({ ok: false, code: 'halt-ticket-unknown' })

    // 失败票据同样不驻留
    halt.registerTicket(ticket({ ticketId: 't-issued', status: 'issued' }))
    expect(halt.unfreeze('t-issued')).toEqual({ ok: false, code: 'halt-ticket-not-approved' })
    expect(halt.unfreeze('t-issued')).toEqual({ ok: false, code: 'halt-ticket-unknown' })

    // 有效票仍可用
    expect(halt.unfreeze('t-fresh')).toEqual({ ok: true })
  })

  it('过期票在 unfreeze 时被删除，重复尝试落到 unknown', () => {
    const { halt, clock } = harness()
    halt.halt('manual')
    halt.registerTicket(ticket({ ticketId: 't-expired', expiresAt: 1_792_000_000_000 }))
    clock.set(1_792_000_000_000 + 1)
    expect(halt.unfreeze('t-expired')).toEqual({ ok: false, code: 'halt-ticket-expired' })
    expect(halt.unfreeze('t-expired')).toEqual({ ok: false, code: 'halt-ticket-unknown' })
    expect(halt.halted).toBe(true)
  })
})
