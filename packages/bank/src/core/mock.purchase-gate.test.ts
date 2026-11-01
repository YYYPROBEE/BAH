/**
 * `purchaseWealth` 的第二道适当性闸门。
 *
 * 治理面（工具 pre-execute）会拦一次，但核心自己的闸门也必须真实生效：
 * 测试、CLI 或未来适配器直接调核心时，不能因为"反正上层会拦"就放行
 * R4 产品给 R2 客户。拒绝必须发生在核销票据与扣款之前。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, asTicketId, captureRejection } from '@bah/test-support'

import { buildBankDataset, DEMO_NOW } from '../forge/index.ts'
import { MockBankCore } from './mock.ts'
import { bankIds } from './model.ts'
import type { TicketBinding, TicketRef } from './ticket.ts'

const USER = bankIds.user('u-1')
const ACCOUNT = bankIds.account('a-1')

function setup(): MockBankCore {
  return new MockBankCore({ data: buildBankDataset({ seed: 1 }), now: () => DEMO_NOW })
}

function ticket(core: MockBankCore): TicketRef {
  const binding: TicketBinding = {
    sessionId: asSessionId('s-bank'),
    tool: 'wealth_purchase',
    fingerprint: 'wealth_purchase:100000',
    amountCents: 100_000,
    expiresAt: DEMO_NOW + 60_000,
  }
  const ticketId = asTicketId('ticket-wealth-gate')
  core.tickets.issue(ticketId, binding, DEMO_NOW)
  core.tickets.approve(ticketId, DEMO_NOW)
  return { ticketId, binding }
}

describe('purchaseWealth · 适当性第二道闸门', () => {
  it('R2 客户直接买 R4 产品 ⇒ suitability-mismatch，且扣款前就拒绝', async () => {
    const core = setup()
    const before = (await core.listAccounts(USER))[0]?.balanceCents
    const error = await captureRejection(() =>
      core.purchaseWealth(
        {
          userId: USER,
          accountId: ACCOUNT,
          productId: bankIds.product('w-4'),
          amountCents: 100_000,
        },
        ticket(core),
      ),
    )
    expect(error.code).toBe('suitability-mismatch')
    // 拒绝发生在核销票据与扣款之前：余额不能被"先扣再拒"
    expect((await core.listAccounts(USER))[0]?.balanceCents).toBe(before)
  })
})
