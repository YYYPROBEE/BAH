/**
 * mock 银行核心（施工单 07 §2–§4 / §6 的 T-BANK-002、003、007、008、012）。
 *
 * 重点不是 CRUD，而是三条权威口径：
 * 1. 写操作必须过票据核销（且核销在任何账本变更之前）；
 * 2. 日累计 / 剩余额度只从账本推导（换会话不重置）；
 * 3. 预检五规则的 block / warn 与业务校验一致。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, asTicketId, captureThrown } from '@bah/test-support'

import { buildBankDataset, DEFAULT_LIMITS, DEMO_NOW, type BankDataset } from '../forge/index.ts'
import { bankIds, type BankLimits, type Account } from './model.ts'
import { MockBankCore } from './mock.ts'
import type { TicketBinding, TicketRef } from './ticket.ts'

const NOW = DEMO_NOW

const ACCOUNT = bankIds.account('a-1')
const FIXED = bankIds.account('a-2')
const USER = bankIds.user('u-1')

/** demo 数据集（可逐字段覆盖）。 */
function dataset(overrides: Partial<BankDataset> = {}): BankDataset {
  return { ...buildBankDataset({ seed: 1 }), ...overrides }
}

/** 建核心；`now` 缺省固定在 `NOW`。 */
function setup(overrides: Partial<BankDataset> = {}, limits?: BankLimits): MockBankCore {
  return new MockBankCore({
    data: dataset(overrides),
    now: () => NOW,
    ...(limits === undefined ? {} : { limits }),
  })
}

let ticketSeq = 0

/** 签发 + 批准一张票据。 */
function ticket(
  core: MockBankCore,
  options: { session?: string; amountCents?: number; tool?: string; expiresAt?: number } = {},
): TicketRef {
  ticketSeq += 1
  const ticketId = asTicketId(`ticket-${ticketSeq}`)
  const binding: TicketBinding = {
    sessionId: asSessionId(options.session ?? 's-bank'),
    tool: options.tool ?? 'transfer_money',
    fingerprint: `${options.tool ?? 'transfer_money'}:${options.amountCents ?? 80_000}`,
    amountCents: options.amountCents ?? 80_000,
    expiresAt: options.expiresAt ?? NOW + 60_000,
  }
  core.tickets.issue(ticketId, binding, NOW)
  core.tickets.approve(ticketId, NOW)
  return { ticketId, binding }
}

/** demo 里向白名单收款人（王建国）的一笔 800 元转账。 */
function transfer(
  patch: Partial<{ amountCents: number; name: string; phone: string; memo: string }> = {},
): Parameters<MockBankCore['createTransfer']>[0] {
  return {
    fromAccountId: ACCOUNT,
    payee: {
      name: patch.name ?? '王建国',
      phone: patch.phone ?? '13900002222',
      ...(patch.memo === undefined ? {} : { memo: patch.memo }),
    },
    amountCents: patch.amountCents ?? 80_000,
    channel: 'app',
  }
}

/* ── 写操作与票据门禁 ─────────────────────────────────────────────────────── */

describe('T-BANK-002 合法核销', () => {
  it('T-BANK-002 approved 票据 → 转账成功、票据 redeemed、余额变动', async () => {
    const core = setup()
    const ref = ticket(core)
    const before = await core.balance(ACCOUNT)

    const result = await core.createTransfer(transfer(), ref)

    expect(core.tickets.status(ref.ticketId)).toBe('redeemed')
    expect(result.amountCents).toBe(80_000)
    expect(result.ticketId).toBe(ref.ticketId)
    expect(result.balanceCents).toBe(before.balanceCents - 80_000)
    expect(result.dailyUsedCents).toBe(80_000)
    expect(result.remainingCents).toBe(500_000 - 80_000)

    const after = await core.balance(ACCOUNT)
    expect(after.balanceCents).toBe(before.balanceCents - 80_000)
    expect(after.availableCents).toBe(before.availableCents - 80_000)
  })
})

describe('T-BANK-003 票据重放', () => {
  it('T-BANK-003 同一票据第二次转账 → 拒绝且账本不变', async () => {
    const core = setup()
    const ref = ticket(core)
    await core.createTransfer(transfer(), ref)
    const afterFirst = await core.balance(ACCOUNT)

    const error = await rejection(() => core.createTransfer(transfer(), ref))
    expect(error.code).toBe('ticket-already-redeemed')

    const afterSecond = await core.balance(ACCOUNT)
    expect(afterSecond.balanceCents).toBe(afterFirst.balanceCents)
  })
})

describe('T-BANK-007 日累计权威口径', () => {
  it('T-BANK-007 当日两笔成功后，preview 的剩余额度正确扣减', async () => {
    const core = setup()
    await core.createTransfer(transfer({ amountCents: 100_000 }), ticket(core, { amountCents: 100_000 }))
    await core.createTransfer(transfer({ amountCents: 100_000 }), ticket(core, { amountCents: 100_000 }))

    const preview = await core.previewTransfer(transfer({ amountCents: 100_000 }))
    expect(preview.dailyUsedCents).toBe(200_000)
    expect(preview.dailyLimitCents).toBe(500_000)
    expect(preview.remainingCents).toBe(300_000)
    // 同一收款人、同一金额在 2 分钟内重复 → 疑似重复提交（warn，不阻断）
    expect(preview.verdict).toBe('warn')
    expect(preview.risks.map((risk) => risk.code)).toContain('duplicate-transfer')
  })
})

describe('T-BANK-008 换会话不重置', () => {
  it('T-BANK-008 另一个会话的票据转账后，日累计仍含此前成功笔', async () => {
    const core = setup()
    await core.createTransfer(transfer({ amountCents: 50_000 }), ticket(core, { session: 's-1', amountCents: 50_000 }))

    const other = ticket(core, { session: 's-2', amountCents: 30_000 })
    const result = await core.createTransfer(transfer({ amountCents: 30_000 }), other)

    // 日累计来自账本，不来自会话：换会话后仍是 50,000 + 30,000
    expect(result.dailyUsedCents).toBe(80_000)
    const preview = await core.previewTransfer(transfer({ amountCents: 1_000 }))
    expect(preview.dailyUsedCents).toBe(80_000)
  })
})

describe('票据核销的并发安全（施工单 07 §7 验收清单）', () => {
  it('同一票据两个并发 createTransfer：只有一个成功，余额只扣一次', async () => {
    const core = setup()
    const ref = ticket(core, { amountCents: 10_000 })
    const before = await core.balance(ACCOUNT)

    const results = await Promise.allSettled([
      core.createTransfer(transfer({ amountCents: 10_000 }), ref),
      core.createTransfer(transfer({ amountCents: 10_000 }), ref),
    ])

    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((item) => item.status === 'rejected')
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({
      code: 'ticket-already-redeemed',
    })

    const after = await core.balance(ACCOUNT)
    expect(after.balanceCents).toBe(before.balanceCents - 10_000)
  })
})

describe('T-BANK-012 余额不足', () => {
  it('T-BANK-012 createTransfer 拒绝、账本不变、票据未被消费', async () => {
    const core = setup()
    const ref = ticket(core, { amountCents: 2_000_000 })
    const before = await core.balance(ACCOUNT)

    const error = await rejection(() => core.createTransfer(transfer({ amountCents: 2_000_000 }), ref))
    expect(error.code).toBe('insufficient-balance')
    expect(core.tickets.status(ref.ticketId)).toBe('approved')

    const after = await core.balance(ACCOUNT)
    expect(after).toEqual(before)
    const page = await core.queryTransactions({ userId: USER })
    expect(page.items).toHaveLength(dataset().transactions.length)
  })
})

/* ── 预检 ─────────────────────────────────────────────────────────────────── */

describe('previewTransfer（试算 + 五规则预检）', () => {
  it('白名单小额 → allow；新收款人 → warn；余额不足 → block', async () => {
    const core = setup()

    const allowed = await core.previewTransfer(transfer({ amountCents: 1_000 }))
    expect(allowed.verdict).toBe('allow')
    expect(allowed.risks).toEqual([])
    expect(allowed.payee.binding).toBe('whitelist')
    expect(allowed.payee.payeeId).toBe(bankIds.payee('p-1'))

    const warned = await core.previewTransfer(transfer({ name: '陌生人', phone: '13100009999', amountCents: 1_000 }))
    expect(warned.verdict).toBe('warn')
    expect(warned.risks.map((risk) => risk.code)).toContain('payee-new')
    expect(warned.payee.binding).toBe('new')
    expect(warned.payee.payeeId).toBeUndefined()

    const blocked = await core.previewTransfer(transfer({ amountCents: 9_000_000 }))
    expect(blocked.verdict).toBe('block')
    expect(blocked.risks.map((risk) => risk.code)).toContain('insufficient-balance')
  })

  it('adversarial 数据触发夜间大额与短时高频（与账本口径一致）', async () => {
    // 夜间 23:00（东八区）试算：夜间大额按**当前时刻**判定，不能用白天的基准钟
    const nightNow = DEMO_NOW + 13 * 60 * 60 * 1000
    const core = new MockBankCore({
      data: buildBankDataset({ seed: 1, tier: 'adversarial', now: nightNow }),
      now: () => nightNow,
    })
    const preview = await core.previewTransfer({
      fromAccountId: bankIds.account('a-1'),
      payee: { name: '韩梅梅', phone: '13700005555' },
      amountCents: 120_000,
      channel: 'app',
    })
    const codes = preview.risks.map((risk) => risk.code)
    expect(codes).toContain('payee-new')
    expect(codes).toContain('night-large-amount')
    expect(codes).toContain('velocity-high')
    // 490,000 + 5 × 10,000 已用；本笔 120,000 超出剩余额度
    expect(preview.dailyUsedCents).toBe(540_000)
    expect(preview.remainingCents).toBe(0)
  })

  it('无卡片账户 → 日限额回落到全局阈值', async () => {
    const core = setup({ cards: [] }, { ...DEFAULT_LIMITS, dailyTransferLimitCents: 123_456 })
    const preview = await core.previewTransfer(transfer({ amountCents: 1_000 }))
    expect(preview.dailyLimitCents).toBe(123_456)
  })

  it('未知账户 / 非法金额 → 结构化错误', async () => {
    const core = setup()
    expect((await rejection(() => core.previewTransfer({ ...transfer(), fromAccountId: bankIds.account('a-x') }))).code).toBe(
      'account-unknown',
    )
    expect((await rejection(() => core.previewTransfer(transfer({ amountCents: 0 })))).code).toBe('amount-invalid')
    expect((await rejection(() => core.previewTransfer(transfer({ amountCents: 1.5 })))).code).toBe('amount-invalid')
  })
})

/* ── 转账的业务校验顺序 ───────────────────────────────────────────────────── */

describe('createTransfer 的校验顺序（全部在核销之前）', () => {
  it('账户冻结 / 收款人为空 → 结构化拒绝，票据未消费', async () => {
    const frozen: Account = { ...dataset().accounts[0]!, status: 'frozen' }
    const core = setup({ accounts: [frozen, ...dataset().accounts.slice(1)] })
    const ref = ticket(core)

    expect((await rejection(() => core.createTransfer(transfer(), ref))).code).toBe('account-inactive')
    expect(core.tickets.status(ref.ticketId)).toBe('approved')
  })

  it('收款人姓名为空 → payee-invalid', async () => {
    const core = setup()
    const error = await rejection(() => core.createTransfer(transfer({ name: '   ' }), ticket(core)))
    expect(error.code).toBe('payee-invalid')
  })

  it('新收款人落 Payee 表（带手机号）；再次转账命中同一条记录', async () => {
    const core = setup()
    const first = await core.createTransfer(
      transfer({ name: '新朋友', phone: '13100001111', amountCents: 10_000, memo: '生日' }),
      ticket(core, { amountCents: 10_000 }),
    )
    const page = await core.queryTransactions({ userId: USER, category: 'transfer' })
    const created = page.items.find((item) => item.id === first.txnId)
    expect(created?.counterparty).toEqual({ name: '新朋友', phone: '13100001111', memo: '生日' })

    // 第二次同名同手机号 → 不再新增收款人，仍按新收款人（warn）处理
    const again = await core.previewTransfer(transfer({ name: '新朋友', phone: '13100001111', amountCents: 1_000 }))
    expect(again.payee.binding).toBe('new')
  })

  it('按 payeeId 命中白名单；姓名匹配时忽略手机号', async () => {
    const core = setup()
    const byId = await core.previewTransfer({
      ...transfer({ amountCents: 1_000 }),
      payee: { payeeId: bankIds.payee('p-1'), name: '随便写的' },
    })
    expect(byId.payee.binding).toBe('whitelist')
    expect(byId.payee.payeeId).toBe(bankIds.payee('p-1'))

    const byName = await core.previewTransfer(transfer({ amountCents: 1_000, name: '王建国' }))
    expect(byName.payee.binding).toBe('whitelist')
  })
})

/* ── 理财购买 ─────────────────────────────────────────────────────────────── */

describe('purchaseWealth（写操作同样过票据）', () => {
  it('成功：扣款、生成持仓、票据核销', async () => {
    const core = setup()
    const ref = ticket(core, { tool: 'purchase_wealth', amountCents: 50_000 })
    const before = await core.balance(ACCOUNT)

    const holding = await core.purchaseWealth(
      {
        userId: USER,
        accountId: ACCOUNT,
        productId: bankIds.product('w-1'),
        amountCents: 50_000,
      },
      ref,
    )

    expect(holding.productId).toBe(bankIds.product('w-1'))
    expect(holding.shares).toBe(500)
    expect(holding.costCents).toBe(50_000)
    expect(core.tickets.status(ref.ticketId)).toBe('redeemed')
    expect((await core.balance(ACCOUNT)).balanceCents).toBe(before.balanceCents - 50_000)
  })

  it('账户不属于该用户 / 未知产品 / 低于起投额 / 余额不足 → 结构化拒绝', async () => {
    const core = setup()
    const base = { accountId: ACCOUNT, productId: bankIds.product('w-1'), amountCents: 10_000 }

    expect(
      (await rejection(() => core.purchaseWealth({ ...base, userId: bankIds.user('u-x') }, ticket(core)))).code,
    ).toBe('account-forbidden')
    expect(
      (await rejection(() =>
        core.purchaseWealth({ ...base, userId: USER, productId: bankIds.product('w-999') }, ticket(core)),
      )).code,
    ).toBe('product-unknown')
    expect(
      (await rejection(() =>
        core.purchaseWealth({ ...base, userId: USER, productId: bankIds.product('w-2') }, ticket(core)),
      )).code,
    ).toBe('below-minimum')
    expect(
      (await rejection(() =>
        core.purchaseWealth({ ...base, userId: USER, amountCents: 2_000_000 }, ticket(core)),
      )).code,
    ).toBe('insufficient-balance')
  })

  it('冻结账户购买被拒（account-inactive），票据不消耗', async () => {
    const frozen: Account = { ...dataset().accounts[0]!, status: 'frozen' }
    const core = setup({ accounts: [frozen, ...dataset().accounts.slice(1)] })
    const ref = ticket(core, { tool: 'purchase_wealth', amountCents: 50_000 })

    const error = await rejection(() =>
      core.purchaseWealth(
        {
          userId: USER,
          accountId: ACCOUNT,
          productId: bankIds.product('w-1'),
          amountCents: 50_000,
        },
        ref,
      ),
    )
    expect(error.code).toBe('account-inactive')
    expect(core.tickets.status(ref.ticketId)).toBe('approved')
  })
})

/* ── 读操作 ───────────────────────────────────────────────────────────────── */

describe('读操作', () => {
  it('listAccounts 按用户过滤并稳定排序；余额只反映账本', async () => {
    const core = setup()
    const accounts = await core.listAccounts(USER)
    expect(accounts.map((item) => item.id)).toEqual([ACCOUNT, FIXED, bankIds.account('a-3')])
    expect(await core.listAccounts(bankIds.user('u-x'))).toEqual([])

    const balance = await core.balance(ACCOUNT)
    expect(balance.balanceCents).toBe(1_234_567)
    expect(balance.asOf).toBe(NOW)
    expect((await rejection(() => core.balance(bankIds.account('a-x')))).code).toBe('account-unknown')
  })

  it('queryTransactions：过滤、倒序、分页游标与非法游标', async () => {
    const core = setup()

    const all = await core.queryTransactions({ userId: USER })
    expect(all.items).toHaveLength(8)
    expect(all.nextCursor).toBeUndefined()
    expect(all.items[0]?.at).toBeGreaterThan(all.items[1]?.at ?? 0)

    const page1 = await core.queryTransactions({ userId: USER, limit: 3 })
    expect(page1.items).toHaveLength(3)
    expect(page1.nextCursor).toBe('3')
    const page2 = await core.queryTransactions({ userId: USER, limit: 3, cursor: '3' })
    expect(page2.items).toHaveLength(3)
    const page3 = await core.queryTransactions({ userId: USER, limit: 3, cursor: '6' })
    expect(page3.items).toHaveLength(2)
    expect(page3.nextCursor).toBeUndefined()

    expect((await core.queryTransactions({ userId: USER, accountId: FIXED })).items).toEqual([])
    expect((await core.queryTransactions({ userId: USER, category: 'salary' })).items).toHaveLength(1)
    expect(
      (
        await core.queryTransactions({
          userId: USER,
          from: NOW - 20 * 86_400_000,
          to: NOW - 10 * 86_400_000,
        })
      ).items,
    ).toHaveLength(3)
    // limit 越界被夹到 [1, 100]
    expect((await core.queryTransactions({ userId: USER, limit: 0 })).items).toHaveLength(1)
    expect((await core.queryTransactions({ userId: USER, limit: 500 })).items).toHaveLength(8)

    expect((await rejection(() => core.queryTransactions({ userId: USER, cursor: 'abc' }))).code).toBe('cursor-invalid')
    expect((await rejection(() => core.queryTransactions({ userId: USER, cursor: '-1' }))).code).toBe('cursor-invalid')
  })

  it('analyzeBill：默认账期、环比、分类汇总与异常标记', async () => {
    const core = setup()
    const report = await core.analyzeBill({ userId: USER })
    expect(report.period).toBe('2026-10')
    expect(report.comparedPeriod).toBe('2026-09')
    expect(report.totalOutCents).toBe(45_600 + 3_000 + 6_800)
    expect(report.byCategory.consumption).toBe(45_600 + 6_800)
    expect(report.momChangePct).toBeLessThan(0)
    expect(report.anomalies).toEqual([])

    const september = await core.analyzeBill({ userId: USER, period: '2026-09' })
    expect(september.totalInCents).toBe(1_500_000)
    expect(september.byCategory.transfer).toBe(80_000)

    const empty = setup({ transactions: [] })
    const noPrevious = await empty.analyzeBill({ userId: USER, period: '2026-10' })
    expect(noPrevious.totalOutCents).toBe(0)
    expect(noPrevious.momChangePct).toBeUndefined()
  })

  it('analyzeBill：adversarial 档标出大额 / 夜间大额 / 重复扣费', async () => {
    const core = new MockBankCore({
      data: buildBankDataset({ seed: 1, tier: 'adversarial' }),
      now: () => NOW,
    })
    const report = await core.analyzeBill({ userId: bankIds.user('u-1') })
    const kinds = report.anomalies.map((item) => item.kind)
    expect(kinds).toContain('large')
    expect(kinds).toContain('late-night')
    expect(kinds).toContain('duplicate')

    // 只统计指定账户时结果一致（adversarial 只有一个账户）
    expect((await core.analyzeBill({ userId: bankIds.user('u-1'), accountId: bankIds.account('a-1') })).anomalies).toHaveLength(
      report.anomalies.length,
    )
  })

  it('listWealthProducts：按风险等级 / 类型 / 期限过滤', async () => {
    const core = setup()
    expect(await core.listWealthProducts()).toHaveLength(3)
    expect((await core.listWealthProducts({ riskGrade: 'R1' })).map((item) => item.id)).toEqual([bankIds.product('w-1')])
    expect((await core.listWealthProducts({ kind: 'fund' })).map((item) => item.id)).toEqual([bankIds.product('w-3')])
    expect((await core.listWealthProducts({ maxTermDays: 100 })).map((item) => item.id)).toEqual([
      bankIds.product('w-1'),
    ])
  })

  it('limits 暴露阈值；缺省时钟与票据库由核心自建', async () => {
    const core = new MockBankCore({ data: dataset() })
    expect(core.limits()).toEqual(DEFAULT_LIMITS)
    expect(core.tickets.size).toBe(0)
    const preview = await core.previewTransfer(transfer({ amountCents: 1_000 }))
    // 缺省 now = 数据基准时刻（不是真实时钟）
    expect(preview.risks).toEqual([])
  })
})

/** 断言异步拒绝是结构化 `BahError` 并取出它。 */
async function rejection(run: () => Promise<unknown>): Promise<{ code: string }> {
  try {
    await run()
  } catch (error) {
    return error as { code: string }
  }
  throw new Error('预期抛出结构化错误，但调用成功了')
}

describe('幂等键（可选，防同参数重复提交）', () => {
  it('同键同参数：只扣款一次，返回首笔 txnId，重试票据仍核销', async () => {
    const core = setup()
    const before = await core.balance(ACCOUNT)
    const first = await core.createTransfer(
      { ...transfer({ amountCents: 1_000 }), idempotencyKey: 'idem-1' },
      ticket(core, { amountCents: 1_000 }),
    )
    const second = await core.createTransfer(
      { ...transfer({ amountCents: 1_000 }), idempotencyKey: 'idem-1' },
      ticket(core, { amountCents: 1_000 }),
    )

    const after = await core.balance(ACCOUNT)
    expect(second.txnId).toBe(first.txnId)
    expect(second.balanceCents).toBe(first.balanceCents)
    expect(after.balanceCents).toBe(before.balanceCents - 1_000)
    expect(core.tickets.status(second.ticketId)).toBe('redeemed')
  })

  it('同键换参数：idempotency-conflict（不复用旧结果）', async () => {
    const core = setup()
    await core.createTransfer(
      { ...transfer({ amountCents: 1_000 }), idempotencyKey: 'idem-2' },
      ticket(core, { amountCents: 1_000 }),
    )
    await expect(
      core.createTransfer(
        { ...transfer({ amountCents: 2_000 }), idempotencyKey: 'idem-2' },
        ticket(core, { amountCents: 2_000 }),
      ),
    ).rejects.toMatchObject({ code: 'idempotency-conflict' })
  })
})

describe('幂等表软上限', () => {
  it('超过 1024 条后清扫过期键（不无界增长）', async () => {
    let now = NOW
    const core = new MockBankCore({ data: dataset(), now: () => now })
    let ticketSeq = 0
    const ticketAt = (amountCents: number): TicketRef => {
      ticketSeq += 1
      const id = asTicketId(`idem-t-${ticketSeq}`)
      const binding: TicketBinding = {
        sessionId: asSessionId('s-bank'),
        tool: 'transfer_money',
        fingerprint: `fp-${id}`,
        amountCents,
        expiresAt: now + 60_000,
      }
      core.tickets.issue(id, binding, now)
      core.tickets.approve(id, now)
      return { ticketId: id, binding }
    }

    for (let index = 0; index < 1024; index += 1) {
      await core.createTransfer(
        { ...transfer({ amountCents: 1 }), idempotencyKey: `idem-${index}` },
        ticketAt(1),
      )
    }
    // 推进到所有幂等键过期，再写入一条触发清扫
    now += 11 * 60_000
    await core.createTransfer(
      { ...transfer({ amountCents: 1 }), idempotencyKey: 'idem-after-expiry' },
      ticketAt(1),
    )
    expect((await core.balance(ACCOUNT)).balanceCents).toBeLessThan(NOW)
  })
})
