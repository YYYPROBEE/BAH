/**
 * 卡限额与交易限制的**真拦截**（B-02 + B-03）。
 *
 * 钉四件事，任何一条都必须是"账本里可证伪"的：
 * 1. 月限额按**同卡、近 30 天滚动窗口**归集（转出 + 消费，冲正回退），不是自然月；
 * 2. 冲正流水继承 `viaCardId`，否则月累计的减法永远减不掉；
 * 3. `spendOnCard` 的校验顺序固定；品类限制只在卡消费通道命中；
 * 4. 限制写入面是**封闭品类**——写不进已知键的规则等于没拦。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, asTicketId, captureRejection } from '@bah/test-support'

import { buildBankDataset, DEMO_NOW } from '../forge/index.ts'
import { MockBankCore } from './mock.ts'
import type { TicketBinding, TicketRef } from './ticket.ts'
import { bankIds, type Card, type CardId } from './model.ts'
import { DAY_MS } from './time.ts'

const USER = bankIds.user('u-1')
const ACCOUNT = bankIds.account('a-1')
const C1 = bankIds.card('c-1')
const C2 = bankIds.card('c-2')

interface Harness {
  readonly core: MockBankCore
  now(): number
  advanceDays(days: number): void
  /** 签发 + 批准一张转账票据（五绑定里的指纹由工具层比对，core 只判状态/过期）。 */
  ticket(amountCents: number): TicketRef
}

function setup(cards?: readonly Card[]): Harness {
  let clock = DEMO_NOW
  const data = buildBankDataset({ seed: 1 })
  const core = new MockBankCore({
    data: cards === undefined ? data : { ...data, cards },
    now: () => clock,
  })
  let seq = 0
  return {
    core,
    now: () => clock,
    advanceDays(days) {
      clock += days * DAY_MS
    },
    ticket(amountCents) {
      seq += 1
      const ticketId = asTicketId(`tc-${String(seq)}`)
      const binding: TicketBinding = {
        sessionId: asSessionId('s-bank'),
        tool: 'transfer_create',
        fingerprint: `fp-${String(seq)}`,
        amountCents,
        expiresAt: clock + 120_000,
      }
      core.tickets.issue(ticketId, binding, clock)
      core.tickets.approve(ticketId, clock)
      return { ticketId, binding }
    },
  }
}

function transferReq(amountCents: number, cardId?: CardId) {
  return {
    fromAccountId: ACCOUNT,
    payee: { name: '王建国', phone: '13900002222' },
    amountCents,
    channel: 'app' as const,
    ...(cardId === undefined ? {} : { viaCardId: cardId }),
  }
}

/** 单卡夹具：把日/月限额放成容易命中边界的值。 */
function onlyCard(patch: Pick<Card, 'dailyLimitCents' | 'monthlyLimitCents'>): readonly Card[] {
  return [
    {
      id: C1,
      accountId: ACCOUNT,
      tail: '1234',
      type: 'physical',
      status: 'normal',
      dailyLimitCents: patch.dailyLimitCents,
      monthlyLimitCents: patch.monthlyLimitCents,
    },
  ]
}

describe('月限额：同卡近 30 天滚动窗口（以卡转账）', () => {
  it('已用 + 本笔 = 月限额 ⇒ 通过；+1 分 ⇒ preview 报 block、create 在核销前拒', async () => {
    const h = setup()
    // c-2：月限 800,000 分；分三天转出 600,000（跨日避开单卡日限额的噪声）
    for (const days of [0, 5, 10]) {
      if (days > 0) h.advanceDays(5)
      await h.core.createTransfer(transferReq(200_000, C2), h.ticket(200_000))
    }
    h.advanceDays(5)

    // 边界：600,000 + 200,000 = 800,000 = 月限额 ⇒ 不出现月限额风险
    const boundary = await h.core.previewTransfer(transferReq(200_000, C2))
    expect(boundary.risks.some((risk) => risk.code === 'card-monthly-limit-exceeded')).toBe(false)
    await expect(h.core.createTransfer(transferReq(200_000, C2), h.ticket(200_000))).resolves.toBeDefined()

    h.advanceDays(1)
    const balanceBefore = await h.core.balance(ACCOUNT)
    const over = await h.core.previewTransfer(transferReq(1, C2))
    const finding = over.risks.find((risk) => risk.code === 'card-monthly-limit-exceeded')
    expect(finding).toMatchObject({
      rule: 'card-monthly-limit',
      severity: 'block',
      code: 'card-monthly-limit-exceeded',
    })
    expect(over.verdict).toBe('block')
    expect(finding?.message).toContain('近 30 天')

    const ticket = h.ticket(1)
    const error = await captureRejection(() => h.core.createTransfer(transferReq(1, C2), ticket))
    expect(error.code).toBe('card-monthly-limit-exceeded')
    // 核销前拒：账本不动、票据仍可用（不是"扣了钱又退回"）
    expect((await h.core.balance(ACCOUNT)).availableCents).toBe(balanceBefore.availableCents)
    expect(h.core.tickets.status(ticket.ticketId)).toBe('approved')
  })

  it('滚动窗口：第 29 天仍占用，第 31 天自动退出（不是自然月清零）', async () => {
    const h = setup(onlyCard({ dailyLimitCents: 1_000_000, monthlyLimitCents: 100_000 }))
    await h.core.createTransfer(transferReq(100_000, C1), h.ticket(100_000))

    h.advanceDays(29)
    const inside = await h.core.previewTransfer(transferReq(1, C1))
    expect(inside.risks.some((risk) => risk.code === 'card-monthly-limit-exceeded')).toBe(true)

    h.advanceDays(2)
    const outside = await h.core.previewTransfer(transferReq(100_000, C1))
    expect(outside.risks.some((risk) => risk.code === 'card-monthly-limit-exceeded')).toBe(false)
    await expect(h.core.createTransfer(transferReq(100_000, C1), h.ticket(100_000))).resolves.toBeDefined()
  })

  it('不带 viaCardId 的账户转账不吃卡月限额（没有卡就没有按卡归集的对象）', async () => {
    const h = setup(onlyCard({ dailyLimitCents: 1_000_000, monthlyLimitCents: 100_000 }))
    await expect(
      h.core.createTransfer(transferReq(800_000), h.ticket(800_000)),
    ).resolves.toBeDefined()
  })
})

describe('冲正：继承 viaCardId 并回退月已用', () => {
  it('冲正流水带原卡 ID，月额度回到 0，可再转满额', async () => {
    const h = setup()
    const created = await h.core.createTransfer(transferReq(800_000, C2), h.ticket(800_000))
    await h.core.reverse(created.txnId)

    const page = await h.core.queryTransactions({ userId: USER, limit: 100 })
    const reversal = page.items.find((item) => item.reversalOf === created.txnId)
    expect(reversal).toMatchObject({
      direction: 'in',
      category: 'refund',
      viaCardId: C2,
    })

    const again = await h.core.previewTransfer(transferReq(800_000, C2))
    expect(again.risks.some((risk) => risk.code === 'card-monthly-limit-exceeded')).toBe(false)
    await expect(h.core.createTransfer(transferReq(800_000, C2), h.ticket(800_000))).resolves.toBeDefined()
  })
})

describe('spendOnCard：品类限制的落点', () => {
  it('category 限制命中即拒，未命中放行；账本落 consumption/out + viaCardId', async () => {
    const h = setup()
    await h.core.setCardRestriction(USER, C2, { mode: 'set', kind: 'category', value: 'dining' })

    const hit = await captureRejection(() =>
      h.core.spendOnCard({
        userId: USER,
        cardId: C2,
        merchantCategory: 'dining',
        amountCents: 10_000,
        memo: '海底捞',
      }),
    )
    expect(hit.code).toBe('card-restricted')

    const ok = await h.core.spendOnCard({
      userId: USER,
      cardId: C2,
      merchantCategory: 'coffee',
      amountCents: 10_000,
      memo: '瑞幸咖啡',
    })
    expect(ok.merchantCategory).toBe('coffee')
    expect(ok.dailyUsedCents).toBe(10_000)
    expect(ok.monthlyUsedCents).toBe(10_000)

    const page = await h.core.queryTransactions({ userId: USER, limit: 100 })
    expect(page.items.find((item) => item.id === ok.txnId)).toMatchObject({
      direction: 'out',
      category: 'consumption',
      viaCardId: C2,
    })
  })

  it('online 限制拒绝卡消费；overseas 不拦国内 mock 消费（不冒充境外通道）', async () => {
    const h = setup()
    await h.core.setCardRestriction(USER, C2, { mode: 'set', kind: 'online' })
    const online = await captureRejection(() =>
      h.core.spendOnCard({ userId: USER, cardId: C2, merchantCategory: 'coffee', amountCents: 1_000 }),
    )
    expect(online.code).toBe('card-restricted')

    await h.core.setCardRestriction(USER, C2, { mode: 'clear', kind: 'online' })
    await h.core.setCardRestriction(USER, C2, { mode: 'set', kind: 'overseas' })
    await expect(
      h.core.spendOnCard({ userId: USER, cardId: C2, merchantCategory: 'coffee', amountCents: 1_000 }),
    ).resolves.toBeDefined()
  })

  it('category 的 value 是封闭集合：未知品类写不进规则', async () => {
    const h = setup()
    const error = await captureRejection(() =>
      h.core.setCardRestriction(USER, C1, { mode: 'set', kind: 'category', value: 'travel' }),
    )
    expect(error.code).toBe('card-restriction-invalid')
  })
})

describe('spendOnCard：日/月限额与越权', () => {
  it('月限额边界：花满月限额通过，再花 1 分拒且账本不变', async () => {
    const h = setup(onlyCard({ dailyLimitCents: 1_000_000, monthlyLimitCents: 100_000 }))
    const first = await h.core.spendOnCard({
      userId: USER,
      cardId: C1,
      merchantCategory: 'coffee',
      amountCents: 100_000,
    })
    expect(first.monthlyUsedCents).toBe(100_000)

    const balanceBefore = await h.core.balance(ACCOUNT)
    const error = await captureRejection(() =>
      h.core.spendOnCard({ userId: USER, cardId: C1, merchantCategory: 'coffee', amountCents: 1 }),
    )
    expect(error.code).toBe('card-monthly-limit-exceeded')
    expect((await h.core.balance(ACCOUNT)).availableCents).toBe(balanceBefore.availableCents)
  })

  it('日限额把"以卡转账 + 卡消费"合并计算（同一张卡的日累计是一个口径）', async () => {
    const h = setup(onlyCard({ dailyLimitCents: 100_000, monthlyLimitCents: 1_000_000 }))
    await h.core.createTransfer(transferReq(100_000, C1), h.ticket(100_000))
    const error = await captureRejection(() =>
      h.core.spendOnCard({ userId: USER, cardId: C1, merchantCategory: 'coffee', amountCents: 1 }),
    )
    expect(error.code).toBe('card-daily-limit-exceeded')
  })

  it('拿别人的卡消费 ⇒ card-not-owned（归属走账户，不走调用方自称）', async () => {
    const h = setup()
    const error = await captureRejection(() =>
      h.core.spendOnCard({
        userId: bankIds.user('u-999'),
        cardId: C1,
        merchantCategory: 'coffee',
        amountCents: 1_000,
      }),
    )
    expect(error.code).toBe('card-not-owned')
  })

  it('冻结卡不能消费', async () => {
    const h = setup()
    await h.core.freezeCard(USER, C2)
    const error = await captureRejection(() =>
      h.core.spendOnCard({ userId: USER, cardId: C2, merchantCategory: 'coffee', amountCents: 1_000 }),
    )
    expect(error.code).toBe('card-unavailable')
  })

  it('幂等键：同键同参数只扣一次；同键换参数即冲突', async () => {
    const h = setup()
    const first = await h.core.spendOnCard({
      userId: USER,
      cardId: C2,
      merchantCategory: 'coffee',
      amountCents: 10_000,
      idempotencyKey: 'spend-1',
    })
    const second = await h.core.spendOnCard({
      userId: USER,
      cardId: C2,
      merchantCategory: 'coffee',
      amountCents: 10_000,
      idempotencyKey: 'spend-1',
    })
    expect(second.txnId).toBe(first.txnId)
    expect(second.balanceCents).toBe(first.balanceCents)
    const page = await h.core.queryTransactions({ userId: USER, limit: 100 })
    expect(page.items.filter((item) => item.id === first.txnId)).toHaveLength(1)

    const conflict = await captureRejection(() =>
      h.core.spendOnCard({
        userId: USER,
        cardId: C2,
        merchantCategory: 'coffee',
        amountCents: 10_001,
        idempotencyKey: 'spend-1',
      }),
    )
    expect(conflict.code).toBe('idempotency-conflict')
  })
})
