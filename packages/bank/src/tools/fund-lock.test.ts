/**
 * `fund_lock`：资金锁定 / 释放（earmark 的显式入口）。
 *
 * 三条必须钉住的语义：
 * 1. 锁定 = 活期 → 本人锁定账户：可用余额下降、锁定户上升、**总资产不变**；
 * 2. 释放 = 锁定账户 → 活期：反向回收，票照样核销；
 * 3. 锁定账户对外转出仍然被拒（earmark 不能当余额花）——那条在 `core/mock.test.ts` 钉。
 */

import { describe, expect, it } from 'vitest'

import type { TicketId } from '@bah/core'

import { captureRejection } from '@bah/test-support'

import type { FundLockResult } from './fund-lock.ts'
import { fingerprintOf } from './fingerprint.ts'
import { createBankHarness } from './testing.ts'

function approve(
  h: ReturnType<typeof createBankHarness>,
  callId: string,
  args: Readonly<Record<string, unknown>>,
  amountCents: number,
): TicketId {
  const now = h.deps.now?.() ?? 0
  const ticketId = `ticket:${callId}` as TicketId
  h.core.tickets.issue(
    ticketId,
    {
      sessionId: h.ctx.sessionId,
      tool: 'fund_lock',
      fingerprint: fingerprintOf('fund_lock', args),
      amountCents,
      expiresAt: now + 120_000,
    },
    now,
  )
  h.core.tickets.approve(ticketId, now)
  return ticketId
}

describe('fund_lock', () => {
  it('status 只读：不签票也能查锁定金额与可用余额', async () => {
    const h = createBankHarness()
    const result = (await h.call('fund_lock', { action: 'status' }, 'c-fund-status')) as FundLockResult
    expect(result.action).toBe('status')
    expect(result.lockedCents).toBeGreaterThan(0)
    expect(result.availableCents).toBeGreaterThan(0)
    expect(result.txnId).toBeUndefined()
  })

  it('lock：可用余额下降、锁定户上升，总资产不变', async () => {
    const h = createBankHarness()
    const before = (await h.call('fund_lock', { action: 'status' }, 'c-fund-before')) as FundLockResult
    const args = { action: 'lock', amountYuan: 500 }
    approve(h, 'c-fund-lock', args, 50_000)
    const result = (await h.call('fund_lock', args, 'c-fund-lock')) as FundLockResult

    expect(result.action).toBe('lock')
    expect(result.amountCents).toBe(50_000)
    expect(result.availableCents).toBe(before.availableCents - 50_000)
    expect(result.lockedCents).toBe(before.lockedCents + 50_000)
    // 总资产（可用 + 锁定）守恒：earmark 不是花钱
    expect(result.availableCents + result.lockedCents).toBe(
      before.availableCents + before.lockedCents,
    )
    expect(result.txnId).toBeTypeOf('string')
  })

  it('release：反向回收，锁定户下降、可用余额回升', async () => {
    const h = createBankHarness()
    const lockArgs = { action: 'lock', amountYuan: 400 }
    approve(h, 'c-fund-lock', lockArgs, 40_000)
    await h.call('fund_lock', lockArgs, 'c-fund-lock')

    const mid = (await h.call('fund_lock', { action: 'status' }, 'c-fund-mid')) as FundLockResult
    const releaseArgs = { action: 'release', amountYuan: 150 }
    approve(h, 'c-fund-release', releaseArgs, 15_000)
    const result = (await h.call('fund_lock', releaseArgs, 'c-fund-release')) as FundLockResult

    expect(result.availableCents).toBe(mid.availableCents + 15_000)
    expect(result.lockedCents).toBe(mid.lockedCents - 15_000)
  })

  it('没有票据 → ticket-missing（写操作必须先过审批）', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() =>
      h.call('fund_lock', { action: 'lock', amountYuan: 100 }, 'c-fund-no-ticket'),
    )
    expect((error as { code?: string }).code).toBe('ticket-missing')
  })
})
