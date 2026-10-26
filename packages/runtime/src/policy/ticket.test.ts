/**
 * W12 · 票据 lease 纯函数：签发 / 装配期越界 / 过期 / 续租。
 *
 * 只测纯函数面（无 IO、无时钟）：执行点的接线在 interaction 与 bank-core 的单测里。
 */

import { describe, expect, it } from 'vitest'

import type { TicketId } from '@bah/core'

import {
  assertLeaseUsable,
  assertLeaseWithinTicket,
  isLeaseExpired,
  issueTicketLease,
  renewTicketLease,
} from './ticket.ts'

const TICKET = 'ticket:w12' as TicketId

function issue(overrides: Partial<Parameters<typeof issueTicketLease>[0]> = {}) {
  return issueTicketLease({
    leaseId: 'lease:w12',
    ticketId: TICKET,
    issuedAt: 1_000,
    ttlMs: 5_000,
    ticketExpiresAt: 10_000,
    ...overrides,
  })
}

describe('TC-W12-09 lease 不得越过票据 TTL（装配期 fail-loud）', () => {
  it('lease.expiresAt > ticket.expiresAt → lease-outlives-ticket（不静默截断）', () => {
    expect(() => issue({ ttlMs: 9_001 })).toThrowError(/lease-outlives-ticket/)
  })

  it('边界相等允许：lease.expiresAt === ticket.expiresAt', () => {
    const lease = issue({ ttlMs: 9_000 })
    expect(lease.expiresAt).toBe(10_000)
    expect(() => assertLeaseWithinTicket(lease, 10_000)).not.toThrow()
  })

  it('续租后越过票据 TTL → lease-outlives-ticket', () => {
    const lease = issue({ ttlMs: 2_000 })
    expect(() =>
      renewTicketLease(lease, { now: 2_000, expiresAt: 10_001, ticketExpiresAt: 10_000 }),
    ).toThrowError(/lease-outlives-ticket/)
  })

  it('非法输入不落一张“看起来能用”的 lease', () => {
    expect(() => issue({ ttlMs: 0 })).toThrowError(/lease-invalid/)
    expect(() => issue({ leaseId: '  ' })).toThrowError(/lease-invalid/)
    expect(() => issue({ ticketId: '' as TicketId })).toThrowError(/lease-invalid/)
    expect(() => issue({ issuedAt: Number.NaN })).toThrowError(/lease-invalid/)
  })
})

describe('TC-W12-02 lease 续租：leaseId 不变、到期时刻只前移', () => {
  it('续租成功返回同 leaseId 的新 lease；原对象不被改写', () => {
    const lease = issue({ ttlMs: 2_000 })
    const renewed = renewTicketLease(lease, { now: 2_000, expiresAt: 6_000, ticketExpiresAt: 10_000 })

    expect(renewed.leaseId).toBe(lease.leaseId)
    expect(renewed.ticketId).toBe(lease.ticketId)
    expect(renewed.expiresAt).toBe(6_000)
    expect(lease.expiresAt).toBe(3_000)
  })

  it('已过期 lease 不能续（重签 = 复活作废票据）', () => {
    const lease = issue({ ttlMs: 2_000 })
    expect(() =>
      renewTicketLease(lease, { now: 3_000, expiresAt: 5_000, ticketExpiresAt: 10_000 }),
    ).toThrowError(/ticket-expired/)
  })

  it('新到期时刻不前移（相等或更早）→ lease-renew-invalid', () => {
    const lease = issue({ ttlMs: 2_000 })
    expect(() =>
      renewTicketLease(lease, { now: 1_500, expiresAt: 3_000, ticketExpiresAt: 10_000 }),
    ).toThrowError(/lease-renew-invalid/)
    expect(() =>
      renewTicketLease(lease, { now: 1_500, expiresAt: 2_000, ticketExpiresAt: 10_000 }),
    ).toThrowError(/lease-renew-invalid/)
  })
})

describe('lease 过期边界', () => {
  it('now === expiresAt 即过期（边界归过期侧）', () => {
    const lease = issue({ ttlMs: 2_000 })
    expect(isLeaseExpired(lease, 2_999)).toBe(false)
    expect(isLeaseExpired(lease, 3_000)).toBe(true)
    expect(() => assertLeaseUsable(lease, 3_000)).toThrowError(/ticket-expired/)
    expect(() => assertLeaseUsable(lease, 2_999)).not.toThrow()
  })
})
