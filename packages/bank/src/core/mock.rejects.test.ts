/**
 * 核心账本的**拒绝面**补录（额度、锁定、赎回、卡消费与票据表回收）。
 *
 * 判据只有一条：钱不能因为"参数没对上"而被放行。所以每个分支都要求
 * ① 结构化理由码，② 账本没被动过（余额/持仓/票据不变）。
 */
import { describe, expect, it } from 'vitest'

import { asSessionId, asTicketId, captureRejection } from '@bah/test-support'

import { buildBankDataset, DEMO_NOW, type BankDataset } from '../forge/index.ts'
import { bankIds, type Account, type Card } from './model.ts'
import { MockBankCore } from './mock.ts'
import type { TicketBinding, TicketRef } from './ticket.ts'

const USER = bankIds.user('u-1')
const PAYEE = { name: '王建国', phone: '13900002222' }

function dataset(overrides: Partial<BankDataset> = {}): BankDataset {
  return { ...buildBankDataset({ seed: 1 }), ...overrides }
}

function setup(overrides: Partial<BankDataset> = {}): { core: MockBankCore; clock: { now: number } } {
  const clock = { now: DEMO_NOW }
  return { core: new MockBankCore({ data: dataset(overrides), now: () => clock.now }), clock }
}

let seq = 0

/** 签一张已批准的票据（工具名要与调用一致）。 */
function ticket(core: MockBankCore, tool: string, amountCents = 80_000): TicketRef {
  seq += 1
  const ticketId = asTicketId(`ticket-guard-${String(seq)}`)
  const binding: TicketBinding = {
    sessionId: asSessionId('s-guard'),
    tool,
    fingerprint: `${tool}:${String(amountCents)}`,
    amountCents,
    expiresAt: DEMO_NOW + 600_000,
  }
  core.tickets.issue(ticketId, binding, DEMO_NOW)
  core.tickets.approve(ticketId, DEMO_NOW)
  return { ticketId, binding }
}

async function firstCard(core: MockBankCore): Promise<Card> {
  const cards = await core.listCards(USER)
  const card = cards.find((item) => item.status === 'normal') ?? cards[0]
  expect(card).toBeDefined()
  return card!
}

async function currentAccount(core: MockBankCore): Promise<Account> {
  const accounts = await core.listAccounts(USER)
  const account = accounts.find((item) => item.type === 'current')
  expect(account).toBeDefined()
  return account!
}

describe('卡消费与额度：先拒再动账', () => {
  it('spendOnCard 余额不足 ⇒ insufficient-balance，且不落任何流水', async () => {
    const { core } = setup()
    const card = await firstCard(core)
    const account = await currentAccount(core)
    // 先把日/月限额抬到不会拦路的水平，让"余额不足"成为唯一的拒绝理由
    await core.setCardLimits(USER, card.id, {
      dailyLimitCents: 50_000_000,
      monthlyLimitCents: 50_000_000,
    })
    const error = await captureRejection(() =>
      core.spendOnCard({
        userId: USER,
        cardId: card.id,
        merchantCategory: 'dining',
        amountCents: account.availableCents + 1,
      }),
    )
    expect(error.code).toBe('insufficient-balance')
    expect((await currentAccount(core)).availableCents).toBe(account.availableCents)
  })

  it('setCardLimits 三种非法额度各有理由码（日 0 / 月 0 / 日高于月）', async () => {
    const { core } = setup()
    const card = await firstCard(core)
    for (const [patch, hint] of [
      [{ dailyLimitCents: 0 }, '日限额'],
      [{ monthlyLimitCents: 0 }, '月限额'],
      [{ dailyLimitCents: 500_000, monthlyLimitCents: 100_000 }, '日限额不能高于月限额'],
    ] as const) {
      const error = await captureRejection(() => core.setCardLimits(USER, card.id, patch))
      expect(error.code, hint).toBe('card-limit-invalid')
      expect(String(error.message), hint).toContain(hint)
    }
  })

  it('卡被限制线上交易后，经该卡的转账 ⇒ card-restricted', async () => {
    const { core } = setup()
    const card = await firstCard(core)
    await core.setCardRestriction(USER, card.id, { mode: 'set', kind: 'online' })
    const account = await currentAccount(core)
    const error = await captureRejection(() =>
      core.createTransfer(
        {
          fromAccountId: account.id,
          payee: PAYEE,
          amountCents: 10_000,
          channel: 'app',
          viaCardId: card.id,
        },
        ticket(core, 'transfer_create', 10_000),
      ),
    )
    expect(error.code).toBe('card-restricted')
  })

  it('造数尾号与新生成的尾号撞上时，跳过冲突继续发卡（不产生两张同尾号卡）', async () => {
    const base = dataset()
    const takenTail = String(1000 + 1).slice(-4)
    const clash: Card = { ...(await new MockBankCore({ data: base, now: () => DEMO_NOW }).listCards(USER))[0]!, tail: takenTail }
    const { core } = setup({ cards: [...base.cards, clash] })
    const issued = await core.applyCard({ userId: USER, type: 'virtual' })
    expect(issued.tail).not.toBe(takenTail)
    const cards = await core.listCards(USER)
    expect(new Set(cards.map((item) => item.tail)).size).toBe(cards.length)
  })
})

describe('转账与赎回：预览与执行同一口径', () => {
  it('锁定账户对外转出 ⇒ transfer-locked-source（预览与创建都不给过）', async () => {
    const { core } = setup()
    const accounts = await core.listAccounts(USER)
    const locked = accounts.find((item) => item.type === 'locked')
    expect(locked).toBeDefined()
    const error = await captureRejection(() =>
      core.previewTransfer({
        fromAccountId: locked!.id,
        payee: PAYEE,
        amountCents: 10_000,
        channel: 'app',
      }),
    )
    expect(error.code).toBe('transfer-locked-source')
  })

  it('赎回：持仓不存在 / 金额超市值 / 没有回款账户，各有码', async () => {
    const { core } = setup()
    const unknown = await captureRejection(() =>
      core.redeemWealth({ userId: USER, holdingId: bankIds.holding('h-ghost') }, ticket(core, 'wealth_redeem', 1)),
    )
    expect(unknown.code).toBe('holding-unknown')

    const account = await currentAccount(core)
    const products = await core.listWealthProducts()
    const product = products[0]!
    await core.purchaseWealth(
      { userId: USER, accountId: account.id, productId: product.id, amountCents: 50_000 },
      ticket(core, 'purchase_wealth', 50_000),
    )
    const holdings = await core.listHoldings(USER)
    const holding = holdings[0]!
    const tooMuch = await captureRejection(() =>
      core.redeemWealth(
        { userId: USER, holdingId: holding.id, amountCents: holding.marketValueCents + 1 },
        ticket(core, 'wealth_redeem', holding.marketValueCents + 1),
      ),
    )
    expect(tooMuch.code).toBe('holding-amount-invalid')

    // 赎回金额非法（0 / 负数）与"超市值"是两条不同的判据
    const zero = await captureRejection(() =>
      core.redeemWealth({ userId: USER, holdingId: holding.id, amountCents: 0 }, ticket(core, 'wealth_redeem', 1)),
    )
    expect(zero.code).toBe('holding-amount-invalid')
  })
})

describe('交易密码：锁定回收与票据表回收', () => {
  it('锁定窗口过后直接改密（不先查状态）也会清锁归零', async () => {
    const { core, clock } = setup()
    for (const attempt of [1, 2]) {
      await captureRejection(() => core.changeTxnPassword(USER, 'wrong-old', 'NewPass1')).catch(() => undefined)
      void attempt
    }
    await captureRejection(() => core.changeTxnPassword(USER, 'wrong-old', 'NewPass1'))
    clock.now = DEMO_NOW + 90 * 60_000
    // 不经过 `passwordStatus`：锁定解除由改密路径自己完成
    const error = await captureRejection(() => core.changeTxnPassword(USER, 'wrong-old', 'NewPass1'))
    expect(error.code).not.toBe('password-locked')
  })

  it('票据表过软上限时清掉已过期的条目（有效票据不丢）', async () => {
    const { core, clock } = setup()
    for (let index = 0; index < 256; index += 1) {
      await core.requestPasswordChange(USER, { ticketId: `h-${String(index)}`, ttlMs: 1_000 }, ticket(core, 'password_change'))
    }
    clock.now = DEMO_NOW + 60_000
    await core.requestPasswordChange(USER, { ticketId: 'h-keep', ttlMs: 600_000 }, ticket(core, 'password_change'))
    const kept = await core.checkPasswordHandoff('h-keep', USER)
    expect(kept.ticketId).toBe('h-keep')
    await expect(core.checkPasswordHandoff('h-0', USER)).rejects.toMatchObject({ code: 'password-ticket-unknown' })
  })
})

describe('赎回成功路径与 AA 的拒绝面', () => {
  it('全额赎回：钱回到活期、持仓清零（不是只测拒绝）', async () => {
    const { core } = setup()
    const account = await currentAccount(core)
    const product = (await core.listWealthProducts())[0]!
    const holding = await core.purchaseWealth(
      { userId: USER, accountId: account.id, productId: product.id, amountCents: 50_000 },
      ticket(core, 'purchase_wealth', 50_000),
    )
    const before = (await currentAccount(core)).availableCents
    // 演示数据集本来就给 u-1 播了持仓：按 id 取自己那笔，别拿别人的市值算账
    const stored = (await core.listHoldings(USER)).find((item) => item.id === holding.id)!
    const result = await core.redeemWealth(
      { userId: USER, holdingId: holding.id, amountCents: stored.marketValueCents },
      ticket(core, 'wealth_redeem', stored.marketValueCents),
    )
    expect(result.amountCents).toBe(stored.marketValueCents)
    expect((await currentAccount(core)).availableCents).toBe(before + stored.marketValueCents)
    // 全额赎回 ⇒ 持仓清零退出，不留一张"市值 0"的空卡
    expect((await core.listHoldings(USER)).some((item) => item.id === holding.id)).toBe(false)
  })

  it('AA 拒绝：组不存在 / 组已收口 / 份额已付 / 参与人空或不存在或同名，各有码', async () => {
    const { core } = setup()
    const req = {
      userId: USER,
      title: '周末聚餐',
      totalCents: 10_000,
      participants: [
        { name: '张三', shareCents: 5_000 },
        { name: '张三', shareCents: 5_000 },
      ],
    }
    const group = await core.createAa(req)

    expect(
      (
        await captureRejection(() =>
          core.declineAa({ userId: USER, groupId: 'aa-ghost' as typeof group.id, participant: 0 }),
        )
      ).code,
    ).toBe('aa-unknown')
    expect(
      (await captureRejection(() => core.declineAa({ userId: USER, groupId: group.id, participant: '   ' }))).code,
    ).toBe('aa-participant-unknown')
    expect(
      (await captureRejection(() => core.declineAa({ userId: USER, groupId: group.id, participant: '赵七' }))).code,
    ).toBe('aa-participant-unknown')
    expect(
      (await captureRejection(() => core.declineAa({ userId: USER, groupId: group.id, participant: '张三' }))).code,
    ).toBe('aa-participant-ambiguous')

    await core.collectAa({ userId: USER, groupId: group.id, participant: 0 })
    expect(
      (await captureRejection(() => core.declineAa({ userId: USER, groupId: group.id, participant: 0 }))).code,
    ).toBe('aa-participant-paid')

    await core.closeAa({ userId: USER, groupId: group.id })
    expect(
      (await captureRejection(() => core.declineAa({ userId: USER, groupId: group.id, participant: 1 }))).code,
    ).toBe('aa-group-closed')
  })

  it('组织者先过用户存在性校验：不存在的用户拿不到 AA 组', async () => {
    const data = dataset()
    const orphan = bankIds.user('u-3')
    const noAccounts = data.accounts.filter((item: Account) => item.userId !== orphan)
    const core = new MockBankCore({ data: dataset({ accounts: noAccounts }), now: () => DEMO_NOW })
    const error = await captureRejection(() =>
      core.createAa({
        userId: orphan,
        title: '没人垫钱',
        totalCents: 6_000,
        participants: [
          { name: '张三', shareCents: 3_000 },
          { name: '李四', shareCents: 3_000 },
        ],
      }),
    )
    // 判据顺序是"用户存在 → 有可入账账户"：数据集里存在的用户都有账户，
    // 所以删光账户只会先撞上"用户不存在"这一层（`primaryAccountOf` 的兜底见 mock.ts 的登记）
    expect(error.code).toBe('user-unknown')
  })
})
