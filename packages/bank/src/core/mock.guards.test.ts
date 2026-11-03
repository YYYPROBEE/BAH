/**
 * 核心账本的**拒绝面与降级分支**（mock 的守卫生效证明）。
 *
 * 为什么单独一份：`mock.test.ts` 钉的是"正常路径的账本事实"，这里钉的是
 * "**不该发生的动作确实被拒**"——赎回回款账户归属、AA 参与人状态、卡消费冲正、
 * 卡号尾号冲突、内部划转方向。这些分支平时不进演示，但少一条就是账本可以被绕过。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, asTicketId, captureRejection } from '@bah/test-support'

import { buildBankDataset, DEMO_NOW, type BankDataset } from '../forge/index.ts'
import { bankIds, accountDisplayName, type Account } from './model.ts'
import { MockBankCore } from './mock.ts'
import type { TicketBinding, TicketRef } from './ticket.ts'

const USER = bankIds.user('u-1')
const OTHER = bankIds.user('u-2')
const ACCOUNT = bankIds.account('a-1')

/** 用 demo 数据集起核心（可逐字段覆盖）；时钟固定。 */
function coreOf(overrides: Partial<BankDataset> = {}): MockBankCore {
  return new MockBankCore({
    data: { ...buildBankDataset({ seed: 1 }), ...overrides },
    now: () => DEMO_NOW,
  })
}

let seq = 0

/** 签发 + 批准一张票据（赎回档）。 */
function ticket(core: MockBankCore, amountCents = 50_800): TicketRef {
  seq += 1
  const ticketId = asTicketId(`g-${String(seq)}`)
  const binding: TicketBinding = {
    sessionId: asSessionId('s-guards'),
    tool: 'redeem_wealth',
    fingerprint: `redeem_wealth:${String(amountCents)}`,
    amountCents,
    expiresAt: DEMO_NOW + 60_000,
  }
  core.tickets.issue(ticketId, binding, DEMO_NOW)
  core.tickets.approve(ticketId, DEMO_NOW)
  return { ticketId, binding }
}

/** 第二个主体（只为造"账户不属于本人"这条路径）。 */
function withSecondUser(base: BankDataset): BankDataset {
  return {
    ...base,
    users: [...base.users, { ...base.users[0]!, id: OTHER, name: '李四' }],
  }
}

describe('赎回：回款账户的三道闸', () => {
  it('只给 productId（不给 holdingId）⇒ 按产品找到持仓并全额赎回', async () => {
    const core = coreOf()
    const result = await core.redeemWealth({ userId: USER, productId: bankIds.product('w-1') }, ticket(core))
    expect(result).toMatchObject({ productId: bankIds.product('w-1'), amountCents: 50_800 })
  })

  it('持仓指向不存在的产品 ⇒ product-unknown（不按"查不到就免费赎回"处理）', async () => {
    const base = buildBankDataset({ seed: 1 })
    const core = coreOf({
      holdings: [{ ...base.holdings[0]!, productId: bankIds.product('w-9') }],
    })
    const error = await captureRejection(() =>
      core.redeemWealth({ userId: USER, holdingId: bankIds.holding('h-1') }, ticket(core)),
    )
    expect((error as { code?: string }).code).toBe('product-unknown')
  })

  it('回款账户属于别人 ⇒ account-forbidden（钱不能落到他人活期）', async () => {
    const base = withSecondUser(buildBankDataset({ seed: 1 }))
    const foreign: Account = {
      ...base.accounts[1]!,
      id: bankIds.account('a-9'),
      userId: OTHER,
    }
    const core = coreOf({
      users: base.users,
      accounts: [...base.accounts, foreign],
      holdings: [{ ...base.holdings[0]!, accountId: foreign.id }],
    })
    const error = await captureRejection(() =>
      core.redeemWealth({ userId: USER, holdingId: bankIds.holding('h-1') }, ticket(core)),
    )
    expect((error as { code?: string }).code).toBe('account-forbidden')
  })

  it('回款账户已冻结 ⇒ account-inactive（状态不 active 就不进账）', async () => {
    const base = buildBankDataset({ seed: 1 })
    const core = coreOf({
      accounts: base.accounts.map((item) =>
        item.id === bankIds.account('a-2') ? { ...item, status: 'frozen' as const } : item,
      ),
      holdings: [{ ...base.holdings[0]!, accountId: bankIds.account('a-2') }],
    })
    const error = await captureRejection(() =>
      core.redeemWealth({ userId: USER, holdingId: bankIds.holding('h-1') }, ticket(core)),
    )
    expect((error as { code?: string }).code).toBe('account-inactive')
  })

  it('部分赎回 ⇒ 只改这一笔持仓，别的持仓原样（不整体重写账本）', async () => {
    const base = buildBankDataset({ seed: 1 })
    const core = coreOf({
      holdings: [
        base.holdings[0]!,
        { ...base.holdings[0]!, id: bankIds.holding('h-2'), productId: bankIds.product('w-2') },
      ],
    })
    await core.redeemWealth(
      { userId: USER, holdingId: bankIds.holding('h-1'), amountCents: 25_400 },
      ticket(core, 25_400),
    )
    const holdings = await core.listHoldings(USER)
    expect(holdings.find((item) => item.id === 'h-2')).toMatchObject({
      marketValueCents: 50_800,
      costCents: 50_000,
    })
  })
})

describe('卡与内部划转：形状与方向', () => {
  it('尾号撞车 ⇒ 顺延到下一个未被占用的尾号（不发出两张同尾号卡）', async () => {
    const base = buildBankDataset({ seed: 1 })
    // 卡序号从"已有张数"续：3 张 ⇒ 下一张 1004，正好被占 ⇒ 必须顺延到 1005
    const cards = [base.cards[0]!, base.cards[1]!, { ...base.cards[2]!, tail: '1004' }]
    const core = coreOf({ cards })
    const issued = await core.applyCard({ userId: USER })
    expect(issued.tail).toBe('1005')
  })

  it('锁定账户转给本人**定期**账户 ⇒ transfer-locked-source（只许回活期）', async () => {
    const base = buildBankDataset({ seed: 1 })
    const core = coreOf()
    const fixed = base.accounts.find((item) => item.id === bankIds.account('a-2'))!
    const error = await captureRejection(() =>
      core.previewTransfer({
        fromAccountId: bankIds.account('a-3'),
        payee: { name: accountDisplayName(fixed) },
        amountCents: 10_000,
        channel: 'app',
      }),
    )
    expect((error as { code?: string }).code).toBe('transfer-locked-source')
  })

  it('锁定账户转回本人活期但活期已冻结 ⇒ account-inactive（目标状态也要判）', async () => {
    const base = buildBankDataset({ seed: 1 })
    const core = coreOf({
      accounts: base.accounts.map((item) => (item.id === ACCOUNT ? { ...item, status: 'frozen' as const } : item)),
    })
    const error = await captureRejection(() =>
      core.previewTransfer({
        fromAccountId: bankIds.account('a-3'),
        payee: { name: accountDisplayName(base.accounts.find((item) => item.id === ACCOUNT)!) },
        amountCents: 10_000,
        channel: 'app',
      }),
    )
    expect((error as { code?: string }).code).toBe('account-inactive')
  })

  it('同日退款冲正计入卡日累计的减项（已用 = 转出/消费 − 退款）', async () => {
    const base = buildBankDataset({ seed: 1 })
    const at = DEMO_NOW
    const spend = {
      id: base.transactions[0]!.id,
      accountId: ACCOUNT,
      at,
      amountCents: 30_000,
      direction: 'out' as const,
      counterparty: { name: '测试商户' },
      category: 'consumption' as const,
      channel: 'app' as const,
      status: 'success' as const,
      viaCardId: bankIds.card('c-1'),
    }
    const refund = {
      ...spend,
      id: `r-${String(spend.id)}`,
      amountCents: 10_000,
      direction: 'in' as const,
      category: 'refund' as const,
      reversalOf: spend.id,
    }
    const core = coreOf({ transactions: [...base.transactions, spend, refund] })
    const result = await core.spendOnCard({
      userId: USER,
      cardId: bankIds.card('c-1'),
      merchantCategory: 'dining',
      amountCents: 1_000,
    })
    // 30,000 消费 − 10,000 退款 + 本笔 1,000 = 21,000
    expect(result.dailyUsedCents).toBe(21_000)
  })
})
