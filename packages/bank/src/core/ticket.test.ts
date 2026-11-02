/**
 * 票据状态机与原子核销。
 *
 * 这些用例钉的是**安全边界**：状态非法、过期、绑定不一致、重放，一行都不能松。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, asTicketId, captureThrown } from '@bah/test-support'

import { TicketStore, type TicketBinding, type TicketRef } from './ticket.ts'

const NOW = 1_000_000

/** 一份合法的五绑定（测试里逐字段改坏）。 */
function binding(patch: Partial<TicketBinding> = {}): TicketBinding {
  return {
    sessionId: asSessionId('s-bank'),
    tool: 'transfer_money',
    fingerprint: 'transfer_money:{"amount":800}',
    amountCents: 80_000,
    expiresAt: NOW + 60_000,
    ...patch,
  }
}

/** 签发 + 批准，返回可核销的引用。 */
function approved(store: TicketStore, id = 'ticket-1', patch: Partial<TicketBinding> = {}): TicketRef {
  const ticketId = asTicketId(id)
  const value = binding(patch)
  store.issue(ticketId, value, NOW)
  store.approve(ticketId, NOW)
  return { ticketId, binding: value }
}

describe('T-BANK-002 票据合法核销', () => {  it('T-BANK-002 approved → redeemed，记录核销时刻且只成功一次', () => {
    const store = new TicketStore()
    const ref = approved(store)
    expect(store.status(ref.ticketId)).toBe('approved')

    const record = store.redeem(ref, NOW)
    expect(record.status).toBe('redeemed')
    expect(record.redeemedAt).toBe(NOW)
    expect(store.status(ref.ticketId)).toBe('redeemed')
  })
})

describe('T-BANK-003 票据重放', () => {
  it('T-BANK-003 同一票据第二次核销 → already redeemed（原子转移后不可逆）', () => {
    const store = new TicketStore()
    const ref = approved(store)
    store.redeem(ref, NOW)

    const error = captureThrown(() => store.redeem(ref, NOW))
    expect(error.code).toBe('ticket-already-redeemed')
  })
})

describe('T-BANK-004 票据过期', () => {
  it('T-BANK-004 TTL 后核销 → ticket-expired，并顺带置 blocked(expired)', () => {
    const store = new TicketStore()
    const ref = approved(store, 'ticket-ttl', { expiresAt: NOW + 100 })

    const error = captureThrown(() => store.redeem(ref, NOW + 200))
    expect(error.code).toBe('ticket-expired')
    expect(store.status(ref.ticketId)).toBe('blocked')
    expect(store.get(ref.ticketId)?.blockedReason).toBe('expired')
  })

  it('票据签发时已过期 → 直接拒绝', () => {
    const store = new TicketStore()
    const error = captureThrown(() =>
      store.issue(asTicketId('ticket-stale'), binding({ expiresAt: NOW - 1 }), NOW),
    )
    expect(error.code).toBe('ticket-expired')
    expect(store.size).toBe(0)
  })

  it('批准时已过期 → blocked(expired) + ticket-expired', () => {
    const store = new TicketStore()
    const ticketId = asTicketId('ticket-late')
    store.issue(ticketId, binding({ expiresAt: NOW + 100 }), NOW)

    const error = captureThrown(() => store.approve(ticketId, NOW + 200))
    expect(error.code).toBe('ticket-expired')
    expect(store.status(ticketId)).toBe('blocked')
  })
})

describe('T-BANK-005 参数指纹变化', () => {
  it('T-BANK-005 同票据换金额（指纹/金额变化）→ ticket-binding-mismatch，且票据未被消费', () => {
    const store = new TicketStore()
    const ref = approved(store)

    const error = captureThrown(() =>
      store.redeem({ ...ref, binding: { ...ref.binding, amountCents: 100_000 } }, NOW),
    )
    expect(error.code).toBe('ticket-binding-mismatch')
    expect(store.status(ref.ticketId)).toBe('approved')

    // 绑定正确的引用仍然可以核销（失败不消耗票据）
    expect(store.redeem(ref, NOW).status).toBe('redeemed')
  })

  it('五绑定逐项比对：任何一项不一致都拒绝', () => {
    const mismatches: readonly (readonly [keyof TicketBinding, Partial<TicketBinding>])[] = [
      ['sessionId', { sessionId: asSessionId('s-other') }],
      ['tool', { tool: 'other_tool' }],
      ['fingerprint', { fingerprint: 'other' }],
      ['amountCents', { amountCents: 1 }],
      ['expiresAt', { expiresAt: NOW + 120_000 }],
    ]

    for (const [field, patch] of mismatches) {
      const store = new TicketStore()
      const ref = approved(store, `ticket-${field}`)
      const error = captureThrown(() => store.redeem({ ...ref, binding: { ...ref.binding, ...patch } }, NOW))
      expect(error.code).toBe('ticket-binding-mismatch')
      expect(error.detail).toMatchObject({ field })
      expect(store.status(ref.ticketId)).toBe('approved')
    }
  })
})

describe('T-BANK-006 未审批票据', () => {
  it('T-BANK-006 issued 状态直接核销 → ticket-not-approved', () => {
    const store = new TicketStore()
    const ticketId = asTicketId('ticket-issued')
    const value = binding()
    store.issue(ticketId, value, NOW)

    const error = captureThrown(() => store.redeem({ ticketId, binding: value }, NOW))
    expect(error.code).toBe('ticket-not-approved')
    expect(store.status(ticketId)).toBe('issued')
  })
})

describe('状态机的其余边角', () => {
  it('重复签发 → ticket-duplicate', () => {
    const store = new TicketStore()
    approved(store, 'ticket-dup')
    const error = captureThrown(() => store.issue(asTicketId('ticket-dup'), binding(), NOW))
    expect(error.code).toBe('ticket-duplicate')
  })

  it('批准幂等；已核销再批准 → ticket-closed', () => {
    const store = new TicketStore()
    const ref = approved(store)
    expect(store.approve(ref.ticketId, NOW).status).toBe('approved')

    store.redeem(ref, NOW)
    const error = captureThrown(() => store.approve(ref.ticketId, NOW))
    expect(error.code).toBe('ticket-closed')
  })

  it('阻断：写入理由、幂等；已核销不可再阻断', () => {
    const store = new TicketStore()
    const ref = approved(store)
    const blocked = store.block(ref.ticketId, 'approval-rejected', NOW)
    expect(blocked.status).toBe('blocked')
    expect(store.block(ref.ticketId, 'again', NOW).blockedReason).toBe('approval-rejected')
    expect(captureThrown(() => store.redeem(ref, NOW)).code).toBe('ticket-blocked')

    const other = new TicketStore()
    const redeemedRef = approved(other, 'ticket-2')
    other.redeem(redeemedRef, NOW)
    expect(captureThrown(() => other.block(redeemedRef.ticketId, 'late', NOW)).code).toBe('ticket-closed')
  })

  it('批量吊销：issued / approved → blocked，redeemed / blocked 终态不动', () => {
    const store = new TicketStore()
    const pending = approved(store, 'ticket-pending')
    const issuedId = asTicketId('ticket-issued')
    store.issue(issuedId, binding(), NOW)
    const redeemed = approved(store, 'ticket-redeemed')
    store.redeem(redeemed, NOW)
    const blocked = approved(store, 'ticket-blocked')
    store.block(blocked.ticketId, 'approval-rejected', NOW)

    const revoked = store.revokeAll('sentry-breaker-frozen', NOW + 1)
    expect(revoked.map((record) => record.ticketId)).toEqual([pending.ticketId, issuedId])
    expect(store.status(pending.ticketId)).toBe('blocked')
    expect(store.status(issuedId)).toBe('blocked')
    expect(store.get(issuedId)?.blockedReason).toBe('sentry-breaker-frozen')
    expect(store.status(redeemed.ticketId)).toBe('redeemed')
    expect(store.status(blocked.ticketId)).toBe('blocked')
  })

  it('批量吊销幂等；吊销后的旧票据不能再核销', () => {
    const store = new TicketStore()
    const ref = approved(store)
    expect(store.revokeAll('sentry-breaker-frozen', NOW + 1)).toHaveLength(1)
    expect(store.revokeAll('sentry-breaker-frozen', NOW + 2)).toHaveLength(0)
    expect(captureThrown(() => store.redeem(ref, NOW + 3)).code).toBe('ticket-blocked')
  })

  it('未知票据：approve / block / redeem 都是 ticket-unknown；get/status 返回 undefined', () => {
    const store = new TicketStore()
    const missing = asTicketId('ticket-missing')
    expect(captureThrown(() => store.approve(missing, NOW)).code).toBe('ticket-unknown')
    expect(captureThrown(() => store.block(missing, 'x', NOW)).code).toBe('ticket-unknown')
    expect(captureThrown(() => store.redeem({ ticketId: missing, binding: binding() }, NOW)).code).toBe(
      'ticket-unknown',
    )
    expect(store.get(missing)).toBeUndefined()
    expect(store.status(missing)).toBeUndefined()
  })
})

describe('票据表软上限', () => {
  it('超过上限时清理终态票据，活动票据保留', () => {
    const store = new TicketStore()
    for (let index = 0; index < 2048; index += 1) {
      const id = asTicketId(`old-${index}`)
      store.issue(id, binding({ expiresAt: NOW + 60_000 }), NOW)
      store.block(id, 'done', NOW)
    }
    const activeId = asTicketId('active')
    store.issue(activeId, binding(), NOW)

    expect(store.size).toBeLessThan(2048)
    expect(store.status(activeId)).toBe('issued')
  })
})
