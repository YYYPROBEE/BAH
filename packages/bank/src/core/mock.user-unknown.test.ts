/**
 * `purchaseWealth` 的第二道闸门：客户主体缺失时的 `user-unknown`。
 *
 * 与 `mock.purchase-gate.test.ts`（等级不匹配）同一条闸门的另一半：治理面读的是
 * `core.getUser()`，直接调核心时这里也必须读得到人。**读不到人就拒绝**，
 * 不能因为"拿不到风险等级"退化成"按最低风险放行"——那等于给不存在的客户批了 R4。
 *
 * 夹具做法：账本里保留账户（归属校验才能过），只把客户主体从数据集里摘掉，
 * 模拟"账户与主体两套真相漂移"（半写入 / 人工搬数据）这种线上真会出现的形状。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, asTicketId, captureRejection } from '@bah/test-support'

import { buildBankDataset, DEMO_NOW } from '../forge/index.ts'
import { MockBankCore } from './mock.ts'
import { bankIds } from './model.ts'
import type { TicketBinding, TicketRef } from './ticket.ts'

const USER = bankIds.user('u-1')
const ACCOUNT = bankIds.account('a-1')

/** 造一个"账户还在、客户主体没了"的核心。 */
function orphanCore(): MockBankCore {
  const data = buildBankDataset({ seed: 1 })
  return new MockBankCore({
    data: { ...data, users: data.users.filter((user) => user.id !== USER) },
    now: () => DEMO_NOW,
  })
}

function ticketRef(core: MockBankCore): TicketRef {
  const binding: TicketBinding = {
    sessionId: asSessionId('s-bank'),
    tool: 'wealth_purchase',
    fingerprint: 'wealth_purchase:100000',
    amountCents: 100_000,
    expiresAt: DEMO_NOW + 60_000,
  }
  const ticketId = asTicketId('ticket-wealth-orphan')
  core.tickets.issue(ticketId, binding, DEMO_NOW)
  core.tickets.approve(ticketId, DEMO_NOW)
  return { ticketId, binding }
}

describe('purchaseWealth · 客户主体缺失', () => {
  it('账户归属正常但账本没有该客户 ⇒ user-unknown，且在核销票据之前就拒绝', async () => {
    const core = orphanCore()
    const before = (await core.listAccounts(USER))[0]?.balanceCents

    const error = await captureRejection(() =>
      core.purchaseWealth(
        {
          userId: USER,
          accountId: ACCOUNT,
          // w-1 是 R1 低门槛产品：连它都被拒，才证明拒绝来自"没有主体"而不是等级比对
          productId: bankIds.product('w-1'),
          amountCents: 100_000,
        },
        ticketRef(core),
      ),
    )
    expect(error.code).toBe('user-unknown')
    expect((await core.listAccounts(USER))[0]?.balanceCents).toBe(before)
    // 票据停在已批准、没被核销：拒绝发生在扣款之前，不会留下"批了却没买成"的半态
    expect(core.tickets.status(asTicketId('ticket-wealth-orphan'))).toBe('approved')
  })

  it('同一夹具把主体放回去 ⇒ 通过（拒绝只来自缺失的那条主体）', async () => {
    const core = new MockBankCore({ data: buildBankDataset({ seed: 1 }), now: () => DEMO_NOW })
    const holding = await core.purchaseWealth(
      { userId: USER, accountId: ACCOUNT, productId: bankIds.product('w-1'), amountCents: 100_000 },
      ticketRef(core),
    )
    expect(holding.costCents).toBe(100_000)
    expect(core.tickets.status(asTicketId('ticket-wealth-orphan'))).toBe('redeemed')
  })
})
