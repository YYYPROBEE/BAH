import { describe, expect, it } from 'vitest'

import { asSessionId, asTicketId, captureRejection, captureThrown } from '@bah/test-support'

import { buildBankDataset, DEFAULT_LIMITS, DEMO_NOW, type BankDataset } from '../forge/index.ts'
import { MockBankCore } from './mock.ts'
import type { TicketBinding, TicketRef } from './ticket.ts'
import {
  accountDisplayName,
  bankIds,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  type Account,
  type BankLimits,
  type Card,
  type MerchantAuthorization,
  type Subscription,
  type User,
} from './model.ts'

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
    expect(result.remainingCents).toBe(100_000 - 80_000)

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
    await core.createTransfer(transfer({ amountCents: 30_000 }), ticket(core, { amountCents: 30_000 }))
    await core.createTransfer(transfer({ amountCents: 30_000 }), ticket(core, { amountCents: 30_000 }))

    const preview = await core.previewTransfer(transfer({ amountCents: 30_000 }))
    expect(preview.dailyUsedCents).toBe(60_000)
    expect(preview.dailyLimitCents).toBe(100_000)
    expect(preview.remainingCents).toBe(40_000)
    // 同一收款人、同一金额在 2 分钟内重复 → 疑似重复提交（warn，不阻断）
    expect(preview.verdict).toBe('warn')
    expect(preview.risks.map((risk) => risk.code)).toContain('duplicate-transfer')
  })

  it('卡片限额与全局阈值取更紧者：配置降到 500 元 → 预览剩余额度同源下降', async () => {
    // demo 的卡与全局缺省都是 1000 元（100_000 分）；这里把配置再压到 500 元。
    // 若只取卡片值，判决层按 500 升红、预览层却显示"还可转 1000"——口径分裂。
    const core = setup({}, { ...DEFAULT_LIMITS, dailyTransferLimitCents: 50_000 })
    const preview = await core.previewTransfer(transfer({ amountCents: 80_000 }))

    expect(preview.dailyLimitCents).toBe(50_000)
    expect(preview.remainingCents).toBe(50_000)
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

describe('票据核销的并发安全', () => {
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
    // 自洽式：不钉魔数，钉"一页最多取 PAGE_LIMIT_DEFAULT 条"的过滤语义
    expect(page.items).toHaveLength(
      Math.min(PAGE_LIMIT_DEFAULT, dataset().transactions.length),
    )
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
    // 99,000 + 5 × 10,000 已用（只计 transfer 类）；本笔 120,000 超出剩余额度
    expect(preview.dailyUsedCents).toBe(149_000)
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

  it('11 位手机号命中联系人库：预览返回联系人姓名，不按新收款人处理', async () => {
    const core = setup()
    const byPhone = await core.previewTransfer(transfer({ amountCents: 1_000, name: '13900002222' }))
    expect(byPhone.payee).toMatchObject({
      name: '王建国',
      phone: '13900002222',
      binding: 'whitelist',
      payeeId: bankIds.payee('p-1'),
    })
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

/* ── 理财赎回 / 风险测评 ─────────────────────────────────────────────────── */

describe('redeemWealth / assessRisk（场景 3 补齐）', () => {
  it('全额赎回：持仓移除、余额增加、流水入账、票据核销', async () => {
    const core = setup()
    const ref = ticket(core, { tool: 'redeem_wealth', amountCents: 50_800 })
    const before = await core.balance(ACCOUNT)
    const holding = (await core.listHoldings(USER))[0]!
    expect(holding.marketValueCents).toBe(50_800)

    const result = await core.redeemWealth(
      { userId: USER, holdingId: holding.id, amountCents: 50_800 },
      ref,
    )
    expect(result).toMatchObject({
      holdingId: holding.id,
      productId: bankIds.product('w-1'),
      amountCents: 50_800,
      shares: 508,
    })
    expect((await core.listHoldings(USER))).toEqual([])
    expect((await core.balance(ACCOUNT)).balanceCents).toBe(before.balanceCents + 50_800)
    expect(core.tickets.status(ref.ticketId)).toBe('redeemed')
    const txn = (await core.queryTransactions({ userId: USER, category: 'wealth' })).items.find(
      (item) => item.id === result.txnId,
    )
    expect(txn).toMatchObject({ direction: 'in', amountCents: 50_800, status: 'success' })
  })

  it('部分赎回：份额/成本/市值按比例保留', async () => {
    const core = setup()
    const holding = (await core.listHoldings(USER))[0]!
    const result = await core.redeemWealth(
      { userId: USER, holdingId: holding.id, amountCents: 25_400 },
      ticket(core, { tool: 'redeem_wealth', amountCents: 25_400 }),
    )
    expect(result.amountCents).toBe(25_400)
    const remaining = (await core.listHoldings(USER))[0]!
    expect(remaining).toMatchObject({
      shares: 250,
      costCents: 25_000,
      marketValueCents: 25_400,
      profitCents: 400,
    })
  })

  it('未知持仓 / 超市值 / 非正整数金额 → 结构化拒绝', async () => {
    const core = setup()
    expect(
      (
        await rejection(() =>
          core.redeemWealth(
            { userId: USER, holdingId: bankIds.holding('h-missing') },
            ticket(core),
          ),
        )
      ).code,
    ).toBe('holding-unknown')

    const holding = (await core.listHoldings(USER))[0]!
    expect(
      (
        await rejection(() =>
          core.redeemWealth(
            { userId: USER, holdingId: holding.id, amountCents: 50_801 },
            ticket(core, { amountCents: 50_801 }),
          ),
        )
      ).code,
    ).toBe('holding-amount-invalid')
    expect(
      (
        await rejection(() =>
          core.redeemWealth(
            { userId: USER, holdingId: holding.id, amountCents: 0 },
            ticket(core, { amountCents: 1 }),
          ),
        )
      ).code,
    ).toBe('holding-amount-invalid')
  })

  it('风险测评：服务端发卷 + 用户逐题作答 → 更新客户等级；非法卷/答案拒绝', async () => {
    const core = setup()
    const before = await core.getUser(USER)
    const questionnaire = await core.issueRiskQuestions(USER)
    // 5 题全选最激进 → 25 分 → R5（分值来自服务端常量表，不由调用方给分）
    const answers = questionnaire.questions.map((question) => ({
      index: question.index,
      key: 'aggressive' as const,
    }))
    const result = await core.assessRisk({
      userId: USER,
      questionnaireId: questionnaire.id,
      answers,
    })
    expect(result).toMatchObject({ score: 25, from: before?.riskGrade, to: 'R5' })
    expect((await core.getUser(USER))?.riskGrade).toBe('R5')

    // 一次性凭证：同一张卷不能再提交一次（否则同一份"用户确认"可以被重放）
    expect(
      (
        await rejection(() =>
          core.assessRisk({ userId: USER, questionnaireId: questionnaire.id, answers }),
        )
      ).code,
    ).toBe('risk-questionnaire-unknown')

    const second = await core.issueRiskQuestions(USER)
    expect(
      (
        await rejection(() =>
          core.assessRisk({
            userId: USER,
            questionnaireId: second.id,
            answers: [{ index: 1, key: 'middle' }],
          }),
        )
      ).code,
    ).toBe('risk-questionnaire-incomplete')
    expect(
      (
        await rejection(() =>
          core.assessRisk({
            userId: USER,
            questionnaireId: second.id,
            answers: second.questions.map((question) => ({ index: question.index, key: 'radical' })),
          }),
        )
      ).code,
    ).toBe('risk-questionnaire-option-invalid')
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
    const data = dataset()
    const total = data.transactions.length

    const all = await core.queryTransactions({ userId: USER })
    // 自洽式：一页最多 PAGE_LIMIT_DEFAULT 条；还有下一页就返回游标
    const firstPage = Math.min(PAGE_LIMIT_DEFAULT, total)
    expect(all.items).toHaveLength(firstPage)
    expect(all.nextCursor).toBe(total > firstPage ? String(firstPage) : undefined)
    expect(all.items[0]?.at).toBeGreaterThan(all.items[1]?.at ?? 0)

    const page1 = await core.queryTransactions({ userId: USER, limit: 3 })
    expect(page1.items).toHaveLength(3)
    expect(page1.nextCursor).toBe('3')
    const page2 = await core.queryTransactions({ userId: USER, limit: 3, cursor: '3' })
    expect(page2.items).toHaveLength(3)
    const page3 = await core.queryTransactions({ userId: USER, limit: 3, cursor: '6' })
    expect(page3.items).toHaveLength(Math.min(3, total - 6))
    expect(page3.nextCursor).toBe(total > 9 ? '9' : undefined)

    expect((await core.queryTransactions({ userId: USER, accountId: FIXED })).items).toEqual([])
    const salaryCount = data.transactions.filter((item) => item.category === 'salary').length
    expect((await core.queryTransactions({ userId: USER, category: 'salary' })).items).toHaveLength(
      Math.min(PAGE_LIMIT_DEFAULT, salaryCount),
    )
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
    expect((await core.queryTransactions({ userId: USER, limit: 500 })).items).toHaveLength(
      Math.min(PAGE_LIMIT_MAX, total),
    )

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
    expect(await core.listWealthProducts()).toHaveLength(5)
    expect((await core.listWealthProducts({ riskGrade: 'R1' })).map((item) => item.id)).toEqual([bankIds.product('w-1')])
    expect((await core.listWealthProducts({ kind: 'fund' })).map((item) => item.id)).toEqual([
      bankIds.product('w-3'),
      bankIds.product('w-4'),
      bankIds.product('w-5'),
    ])
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

  /**
   * B-1（S0）：幂等表是 **core 实例级**（一进程一 core），键却由客户端提供。
   * 不加 actor 维度时，两个用户用同一个键会互相命中：后一笔既不扣款、又拿到前一笔的 txnId。
   * 断言写成 `toBe(before - 1_000)` 而不是 `toBeLessThan(...)`——后者在"只扣了一笔"时也绿，
   * 而那正是要抓的静默吞没。
   */
  it('同键跨用户不串号：两笔独立扣款、txnId 不同', async () => {
    const data = buildBankDataset({ seed: 1, tier: 'stress', now: NOW })
    const core = new MockBankCore({ data, now: () => NOW })
    const [userA, userB] = data.users
    const accountA = data.accounts.find((item) => item.userId === userA!.id)!
    const accountB = data.accounts.find((item) => item.userId === userB!.id)!
    const beforeA = (await core.balance(accountA.id)).balanceCents
    const beforeB = (await core.balance(accountB.id)).balanceCents

    // 收款人与金额完全相同 → fingerprint 相同；唯一区别是转出账户。
    const req = (from: typeof accountA.id) => ({
      ...transfer({ amountCents: 1_000 }),
      fromAccountId: from,
      idempotencyKey: 'shared-key',
    })

    const first = await core.createTransfer(req(accountA.id), ticket(core, { amountCents: 1_000 }))
    const second = await core.createTransfer(req(accountB.id), ticket(core, { amountCents: 1_000 }))

    expect(second.txnId).not.toBe(first.txnId)
    expect((await core.balance(accountA.id)).balanceCents).toBe(beforeA - 1_000)
    expect((await core.balance(accountB.id)).balanceCents).toBe(beforeB - 1_000)
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

describe('W12 冲正（补偿回读的账本面）', () => {
  it('reverse 保留原交易并新增冲正流水：余额回补、额度回退、对账看得见两条', async () => {
    const core = setup()
    const before = await core.balance(ACCOUNT)
    const created = await core.createTransfer(transfer(), ticket(core))

    const reversal = await core.reverse(created.txnId)

    expect(reversal.txnId).toBe(created.txnId)
    expect(reversal.reversalTxnId).not.toBe(created.txnId)
    expect(reversal.amountCents).toBe(80_000)

    const after = await core.balance(ACCOUNT)
    expect(after.balanceCents).toBe(before.balanceCents)
    expect(after.availableCents).toBe(before.availableCents)
    expect(reversal.dailyUsedCents).toBe(0)

    const page = await core.queryTransactions({
      userId: USER,
      accountId: ACCOUNT,
      from: NOW - 1_000,
      to: NOW + 1_000,
    })
    const flows = page.items.filter((item) => item.id === created.txnId || item.id === reversal.reversalTxnId)
    expect(flows).toHaveLength(2)
    expect(flows.find((item) => item.id === created.txnId)).toMatchObject({
      direction: 'out',
      category: 'transfer',
      status: 'success',
    })
    expect(flows.find((item) => item.id === reversal.reversalTxnId)).toMatchObject({
      direction: 'in',
      category: 'refund',
      status: 'success',
      reversalOf: created.txnId,
    })
  })

  it('TC-W12-04 同一 txnId 冲正两次只生效一次（幂等，不重复回补）', async () => {
    const core = setup()
    const created = await core.createTransfer(transfer(), ticket(core))
    const first = await core.reverse(created.txnId)
    const afterFirst = await core.balance(ACCOUNT)

    const second = await core.reverse(created.txnId)
    const afterSecond = await core.balance(ACCOUNT)

    expect(second).toEqual(first)
    expect(afterSecond).toEqual(afterFirst)
    expect(core.reversalOf(created.txnId)).toEqual(first)

    const page = await core.queryTransactions({ userId: USER, accountId: ACCOUNT })
    const reversals = page.items.filter((item) => item.reversalOf === created.txnId)
    expect(reversals).toHaveLength(1)
  })

  it('只允许冲正“成功 + 转出 + transfer”：其余 fail-loud，不静默跳过', async () => {
    const core = setup()
    expect((await captureThrownAsync(() => core.reverse('txn:missing'))).code).toBe('txn-unknown')

    const created = await core.createTransfer(transfer(), ticket(core))
    const reversal = await core.reverse(created.txnId)
    expect((await captureThrownAsync(() => core.reverse(reversal.reversalTxnId))).code).toBe(
      'txn-not-reversible',
    )
  })
})

describe('银行卡 / 订阅的归属校验', () => {
  it('未知卡 / 非本人卡 / 未知订阅 / 非本人订阅 → fail-loud，绝不静默改状态', async () => {
    const core = setup()
    const stranger = bankIds.user('u-999')

    expect((await captureThrownAsync(() => core.reportCardLost(USER, bankIds.card('c-missing')))).code).toBe(
      'card-unknown',
    )
    expect((await captureThrownAsync(() => core.reportCardLost(stranger, bankIds.card('c-1')))).code).toBe(
      'card-not-owned',
    )
    expect(
      (await captureThrownAsync(() => core.cancelSubscription(USER, bankIds.subscription('s-missing')))).code,
    ).toBe('subscription-unknown')
    expect(
      (await captureThrownAsync(() => core.cancelSubscription(stranger, bankIds.subscription('s-1')))).code,
    ).toBe('subscription-not-owned')
  })
})

/** 异步抛错捕获（本文件其余用例用同步 rejection；冲正是 Promise）。 */
async function captureThrownAsync(run: () => Promise<unknown>): Promise<{ readonly code?: string }> {
  try {
    await run()
  } catch (error) {
    return error as { readonly code?: string }
  }
  throw new Error('预期应抛错，但调用成功了')
}

/* ── 内部划转（04 单生日案例：锁定 1000 元） ─────────────────────────────── */

const LOCKED = bankIds.account('a-3')

/** 内部划转到本人锁定账户。 */
function selfTransfer(amountCents = 100_000): Parameters<MockBankCore['createTransfer']>[0] {
  return {
    fromAccountId: ACCOUNT,
    payee: { name: '锁定账户(9012)', memo: '生日预算锁定' },
    amountCents,
    channel: 'app',
  }
}

describe('内部划转：本人账户命中与方向约束', () => {
  it('活期 → 锁定：扣源、贷目标、两条流水、计入日累计', async () => {
    const core = setup()
    const beforeSource = await core.balance(ACCOUNT)
    const beforeTarget = await core.balance(LOCKED)
    const ref = ticket(core, { amountCents: 100_000 })

    const result = await core.createTransfer(selfTransfer(), ref)

    expect(result.amountCents).toBe(100_000)
    expect(result.balanceCents).toBe(beforeSource.balanceCents - 100_000)
    expect(result.dailyUsedCents).toBe(100_000)
    // 核销发生在账本变更之前：转账成功 ⇒ 票据已核销
    expect(core.tickets.status(ref.ticketId)).toBe('redeemed')

    const afterSource = await core.balance(ACCOUNT)
    const afterTarget = await core.balance(LOCKED)
    expect(afterSource.balanceCents).toBe(beforeSource.balanceCents - 100_000)
    expect(afterTarget.balanceCents).toBe(beforeTarget.balanceCents + 100_000)
    expect(afterTarget.availableCents).toBe(beforeTarget.availableCents + 100_000)

    // 两条流水：源账户 out（对方=锁定账户）、目标账户 in（对方=活期账户）
    // 展示名由 `accountDisplayName` 生成——判定与流水共用同一函数，改口径只改一处。
    const sourcePage = await core.queryTransactions({ userId: USER, accountId: ACCOUNT, limit: 5 })
    const targetPage = await core.queryTransactions({ userId: USER, accountId: LOCKED, limit: 5 })
    const out = sourcePage.items.find((item) => item.id === result.txnId)
    expect(out?.direction).toBe('out')
    const lockedAccount = dataset().accounts.find((item) => item.id === LOCKED) as Account
    expect(out?.counterparty.name).toBe(accountDisplayName(lockedAccount))
    const incoming = targetPage.items.find((item) => item.amountCents === 100_000 && item.direction === 'in')
    expect(incoming?.direction).toBe('in')
    expect(incoming?.counterparty.name).toBe('活期账户(1234)')
  })

  it('预览：本人账户报 whitelist，不触发 new-payee 升红', async () => {
    const core = setup()
    const preview = await core.previewTransfer(selfTransfer())
    expect(preview.payee).toMatchObject({ name: '锁定账户(9012)', binding: 'whitelist' })
    expect(preview.risks.some((risk) => risk.code === 'new-payee')).toBe(false)
  })

  it('锁定账户 → 本人活期 = 释放（earmark 回收），票据核销、双流水', async () => {
    const core = setup()
    const ref = ticket(core, { amountCents: 50_000 })
    const beforeLocked = await core.balance(LOCKED)
    const beforeCurrent = await core.balance(ACCOUNT)
    const result = await core.createTransfer(
      {
        ...selfTransfer(),
        fromAccountId: LOCKED,
        payee: { name: '活期账户(1234)' },
        amountCents: 50_000,
      },
      ref,
    )
    expect(result.amountCents).toBe(50_000)
    expect((await core.balance(LOCKED)).balanceCents).toBe(beforeLocked.balanceCents - 50_000)
    expect((await core.balance(ACCOUNT)).balanceCents).toBe(beforeCurrent.balanceCents + 50_000)
    expect(core.tickets.status(ref.ticketId)).toBe('redeemed')
  })

  it('锁定账户对外转出仍拒 → transfer-locked-source（票据未核销）', async () => {
    const core = setup()
    const ref = ticket(core)
    const error = await captureThrownAsync(() =>
      core.createTransfer(
        { ...selfTransfer(), fromAccountId: LOCKED, payee: { name: '王建国' } },
        ref,
      ),
    )
    expect(error.code).toBe('transfer-locked-source')
    expect(core.tickets.status(ref.ticketId)).toBe('approved')
  })

  it('定期作转出方 → transfer-internal-unsupported（v1 只允许活期转出）', async () => {
    const core = setup()
    const error = await captureThrownAsync(() =>
      core.createTransfer(
        { ...selfTransfer(), fromAccountId: FIXED, payee: { name: '锁定账户(9012)' } },
        ticket(core),
      ),
    )
    expect(error.code).toBe('transfer-internal-unsupported')
  })

  it('目标账户冻结 → account-inactive', async () => {
    const accounts = dataset().accounts.map((item) =>
      item.id === LOCKED ? { ...item, status: 'frozen' as const } : item,
    )
    const core = setup({ accounts })
    const error = await captureThrownAsync(() => core.createTransfer(selfTransfer(), ticket(core)))
    expect(error.code).toBe('account-inactive')
  })

  it('内部划转的幂等键：第二次同键不重复扣款，返回同一 txnId', async () => {
    const core = setup()
    const first = await core.createTransfer({ ...selfTransfer(), idempotencyKey: 'k-self' }, ticket(core))
    const second = await core.createTransfer({ ...selfTransfer(), idempotencyKey: 'k-self' }, ticket(core))
    expect(second.txnId).toBe(first.txnId)
    expect((await core.balance(ACCOUNT)).balanceCents).toBe(first.balanceCents)
  })

  it('转给自己所在的账户 → payee-invalid（内部划转不能同账户）', async () => {
    const core = setup()
    const error = await captureThrownAsync(() =>
      core.createTransfer({ ...selfTransfer(), payee: { name: '活期账户(1234)' } }, ticket(core)),
    )
    expect(error.code).toBe('payee-invalid')
  })

  it('展示名命中多个本人账户 → payee-ambiguous（fail-loud，不猜）', async () => {
    const base = dataset().accounts
    const twin: Account = {
      ...(base.find((item) => item.id === LOCKED) as Account),
      id: bankIds.account('a-9'),
    }
    const core = setup({ accounts: [...base, twin] })
    const error = await captureThrownAsync(() => core.createTransfer(selfTransfer(), ticket(core)))
    expect(error.code).toBe('payee-ambiguous')
  })
})

/* ── 主体读取（实体槽位的数据来源） ───────────────────────────────────────── */

describe('getUser（只读主体，实体槽位用它校验"是谁"）', () => {
  it('存在 → 返回主体（S0 后 demo u-1 是张三）', async () => {
    const core = setup()
    const user = await core.getUser(USER)
    expect(user?.id).toBe(USER)
    expect(user?.name).toBe('张三')
    expect(user?.phone).toBe('13800001111')
  })

  it('不存在 → undefined（"查无此人"是业务结果，不是异常）', async () => {
    const core = setup()
    await expect(core.getUser(bankIds.user('u-404'))).resolves.toBeUndefined()
  })

  it('返回副本：调用方改字段不污染账本主体', async () => {
    const core = setup()
    const first = await core.getUser(USER)
    if (first === undefined) throw new Error('demo 数据集缺少 u-1')
    Object.assign(first, { name: '李四' })
    const second = await core.getUser(USER)
    expect(second?.name).toBe('张三')
    expect(first.name).toBe('李四')
  })
})


/* ── 订阅 / 代扣协议（场景 5 · P1 的 6 个新方法） ─────────────────────────── */

const VIDEO = bankIds.subscription('s-video')
const MUSIC = bankIds.subscription('s-music')
const AUTH_VIDEO = bankIds.authorization('auth-video')
const AUTH_MUSIC = bankIds.authorization('auth-music')

const SUB_VIDEO: Subscription = {
  id: VIDEO,
  userId: USER,
  merchant: '视频会员',
  merchantKey: '视频会员',
  cycle: 'monthly',
  nextChargeAt: NOW + 5 * 24 * 60 * 60 * 1000,
  amountCents: 3000,
  status: 'active',
  contractEndAt: NOW + 90 * 24 * 60 * 60 * 1000,
}
const SUB_MUSIC: Subscription = {
  id: MUSIC,
  userId: USER,
  merchant: '支付宝-云音乐',
  merchantKey: '云音乐',
  cycle: 'monthly',
  nextChargeAt: NOW + 7 * 24 * 60 * 60 * 1000,
  amountCents: 1200,
  status: 'active',
}
const AUTHORIZATIONS: MerchantAuthorization[] = [
  {
    id: AUTH_VIDEO,
    userId: USER,
    merchant: '视频会员',
    merchantKey: '视频会员',
    agreementNo: 'AG-VIDEO-0001',
    accountId: ACCOUNT,
    status: 'active',
    signedAt: NOW - 200 * 24 * 60 * 60 * 1000,
  },
  {
    id: AUTH_MUSIC,
    userId: USER,
    merchant: '支付宝-云音乐',
    merchantKey: '云音乐',
    agreementNo: 'AG-MUSIC-0001',
    accountId: ACCOUNT,
    status: 'active',
    signedAt: NOW - 150 * 24 * 60 * 60 * 1000,
  },
]

function subscriptionSetup(): MockBankCore {
  return setup({ subscriptions: [SUB_VIDEO, SUB_MUSIC], authorizations: AUTHORIZATIONS })
}

describe('订阅与代扣协议（P1）', () => {
  it('listSubscriptions：只返回本人订阅的副本（改副本不污染账本）', async () => {
    const core = subscriptionSetup()
    const first = await core.listSubscriptions(USER)
    expect(first.map((item) => item.id)).toEqual([MUSIC, VIDEO])
    Object.assign(first[1] as Subscription, { merchant: '被改坏' })
    const second = await core.listSubscriptions(USER)
    expect(second[1]?.merchant).toBe('视频会员')
    expect(await core.listSubscriptions(bankIds.user('u-999'))).toEqual([])
  })

  it('listAuthorizations：只返回本人协议', async () => {
    const core = subscriptionSetup()
    const list = await core.listAuthorizations(USER)
    expect(list.map((item) => item.id)).toEqual([AUTH_MUSIC, AUTH_VIDEO])
    expect(await core.listAuthorizations(bankIds.user('u-999'))).toEqual([])
  })

  it('revokeAuthorization：关协议 → 该 merchantKey 下 active 订阅全部暂停；重复调用幂等', async () => {
    const core = subscriptionSetup()
    const result = await core.revokeAuthorization(USER, AUTH_MUSIC)
    expect(result).toMatchObject({
      authorizationId: AUTH_MUSIC,
      merchant: '支付宝-云音乐',
      revokedAt: NOW,
      affectedSubscriptions: [MUSIC],
    })
    const music = (await core.listSubscriptions(USER)).find((item) => item.id === MUSIC)
    expect(music).toMatchObject({ status: 'paused', pauseUntil: SUB_MUSIC.nextChargeAt })

    const again = await core.revokeAuthorization(USER, AUTH_MUSIC)
    expect(again.revokedAt).toBe(NOW)
    expect(again.affectedSubscriptions).toEqual([])
  })

  it('revokeAuthorization：未知协议 / 他人协议 → 结构化失败', async () => {
    const core = subscriptionSetup()
    expect(
      (await captureThrownAsync(() => core.revokeAuthorization(USER, bankIds.authorization('auth-404'))))
        .code,
    ).toBe('authorization-unknown')
    expect(
      (await captureThrownAsync(() => core.revokeAuthorization(bankIds.user('u-999'), AUTH_MUSIC)))
        .code,
    ).toBe('authorization-not-owned')
  })

  it('setSubscriptionWatch：remind / idle / none 三态互斥写入，且可清空', async () => {
    const core = subscriptionSetup()
    const reminded = await core.setSubscriptionWatch(USER, VIDEO, { watch: 'remind', aheadDays: 5 })
    expect(reminded.reminderAheadDays).toBe(5)
    expect(reminded.note).toBeUndefined()

    const idle = await core.setSubscriptionWatch(USER, VIDEO, { watch: 'idle' })
    expect(idle.note).toBe('idle')
    expect(idle.reminderAheadDays).toBeUndefined()

    const cleared = await core.setSubscriptionWatch(USER, VIDEO, { watch: 'none' })
    expect(cleared.note).toBeUndefined()
    expect(cleared.reminderAheadDays).toBeUndefined()

    const defaulted = await core.setSubscriptionWatch(USER, VIDEO, { watch: 'remind' })
    expect(defaulted.reminderAheadDays).toBe(3)

    await core.cancelSubscription(USER, VIDEO)
    expect(
      (await captureThrownAsync(() => core.setSubscriptionWatch(USER, VIDEO, { watch: 'none' }))).code,
    ).toBe('subscription-cancelled')
  })

  it('setSubscriptionWatch：提前量越界 / 越权 → 结构化失败', async () => {
    const core = subscriptionSetup()
    expect(
      (await captureThrownAsync(() => core.setSubscriptionWatch(USER, VIDEO, { watch: 'remind', aheadDays: 0 })))
        .code,
    ).toBe('reminder-ahead-invalid')
    expect(
      (await captureThrownAsync(() => core.setSubscriptionWatch(USER, VIDEO, { watch: 'idle', aheadDays: 3 })))
        .code,
    ).toBe('reminder-ahead-invalid')
    expect(
      (await captureThrownAsync(() => core.setSubscriptionWatch(bankIds.user('u-999'), VIDEO, { watch: 'none' })))
        .code,
    ).toBe('subscription-not-owned')
  })

  it('upcomingCharges：只回 active、窗口内；同一到期日按订阅 ID 稳定排序', async () => {
    const core = subscriptionSetup()
    const sameDue: Subscription[] = [
      { ...SUB_MUSIC, id: bankIds.subscription('s-z'), nextChargeAt: NOW + 3 * 24 * 60 * 60 * 1000 },
      { ...SUB_MUSIC, id: bankIds.subscription('s-a'), nextChargeAt: NOW + 3 * 24 * 60 * 60 * 1000 },
      { ...SUB_VIDEO, nextChargeAt: NOW + 5 * 24 * 60 * 60 * 1000 },
    ]
    const core2 = setup({ subscriptions: sameDue, authorizations: AUTHORIZATIONS })
    const listed = await core2.upcomingCharges(USER, 7)
    expect(listed.map((item) => item.subscriptionId)).toEqual([
      bankIds.subscription('s-a'),
      bankIds.subscription('s-z'),
      VIDEO,
    ])
    expect(await core.upcomingCharges(USER, 0)).toEqual([])
  })

  it('cancelSubscription(mode=at-next-cycle)：置 paused + pauseUntil（到期即断）', async () => {
    const core = subscriptionSetup()
    const result = await core.cancelSubscription(USER, VIDEO, 'at-next-cycle')
    expect(result.pausedUntil).toBe(SUB_VIDEO.nextChargeAt)
    const found = (await core.listSubscriptions(USER)).find((item) => item.id === VIDEO)
    expect(found).toMatchObject({ status: 'paused', pauseUntil: SUB_VIDEO.nextChargeAt })

    const cancelled = await core.cancelSubscription(USER, VIDEO)
    expect(cancelled.pausedUntil).toBeUndefined()
    expect((await core.listSubscriptions(USER)).find((item) => item.id === VIDEO)?.status).toBe(
      'cancelled',
    )

    // 已取消是终态：再调 at-next-cycle 不得复活成 paused
    await core.cancelSubscription(USER, VIDEO, 'at-next-cycle')
    expect((await core.listSubscriptions(USER)).find((item) => item.id === VIDEO)?.status).toBe(
      'cancelled',
    )
  })

  it('recordCancelRequest / listCancelRequests：落事实、校验时间顺序与订阅归属', async () => {
    const core = subscriptionSetup()
    const record = await core.recordCancelRequest({
      userId: USER,
      subscriptionId: VIDEO,
      path: 'merchant',
      mode: 'now',
      requestedAt: NOW,
      expectedEffectiveAt: NOW,
      verifyBy: NOW + 3 * 24 * 60 * 60 * 1000,
    })
    expect(record.id).toBe(bankIds.cancelRequest('cr-new-1'))
    expect(await core.listCancelRequests(USER)).toEqual([record])

    // 非有限时间戳
    expect(
      (
        await captureThrownAsync(() =>
          core.recordCancelRequest({
            userId: USER,
            subscriptionId: VIDEO,
            path: 'merchant',
            mode: 'now',
            requestedAt: Number.NaN,
            expectedEffectiveAt: NOW,
            verifyBy: NOW,
          }),
        )
      ).code,
    ).toBe('cancel-request-invalid')

    expect(
      (
        await captureThrownAsync(() =>
          core.recordCancelRequest({
            userId: USER,
            subscriptionId: VIDEO,
            path: 'merchant',
            mode: 'now',
            requestedAt: NOW,
            expectedEffectiveAt: NOW + 1000,
            verifyBy: NOW,
          }),
        )
      ).code,
    ).toBe('cancel-request-invalid')
    expect(
      (
        await captureThrownAsync(() =>
          core.recordCancelRequest({
            userId: USER,
            subscriptionId: bankIds.subscription('s-404'),
            path: 'merchant',
            mode: 'now',
            requestedAt: NOW,
            expectedEffectiveAt: NOW,
            verifyBy: NOW,
          }),
        )
      ).code,
    ).toBe('subscription-unknown')
  })
})

/* ── 卡片状态机（ADR-0006 / L3 T1–T10 的 core 面） ───────────────────────── */

describe('卡片冻结 / 解冻（core）', () => {
  const CARD_1 = bankIds.card('c-1')

  it('T1 冻结正常卡 → frozen；T2 重复冻结幂等 changed=false', async () => {
    const core = setup()
    expect(await core.freezeCard(USER, CARD_1)).toEqual({
      cardId: CARD_1,
      tail: '1234',
      status: 'frozen',
      changed: true,
    })
    expect((await core.freezeCard(USER, CARD_1)).changed).toBe(false)
  })

  it('T3 冻结已挂失卡 → card-lost', async () => {
    const core = setup()
    await core.reportCardLost(USER, CARD_1)
    expect((await rejection(() => core.freezeCard(USER, CARD_1))).code).toBe('card-lost')
  })

  it('T4 解冻冻结卡 → normal；T5 解冻正常卡幂等 changed=false', async () => {
    const core = setup()
    await core.freezeCard(USER, CARD_1)
    expect(await core.unfreezeCard(USER, CARD_1)).toEqual({
      cardId: CARD_1,
      tail: '1234',
      status: 'normal',
      changed: true,
    })
    expect((await core.unfreezeCard(USER, CARD_1)).changed).toBe(false)
  })

  it('T6 解冻已挂失卡 → card-lost', async () => {
    const core = setup()
    await core.reportCardLost(USER, CARD_1)
    expect((await rejection(() => core.unfreezeCard(USER, CARD_1))).code).toBe('card-lost')
  })

  it('T7 冻结他人卡 → card-not-owned（跨用户是越权）', async () => {
    const base = dataset()
    const otherUser: User = { ...base.users[0]!, id: bankIds.user('u-2') }
    const otherAccount: Account = {
      ...base.accounts[0]!,
      id: bankIds.account('a-9'),
      userId: otherUser.id,
      number: '6222 0202 0000 0009',
    }
    const otherCard: Card = {
      ...base.cards[0]!,
      id: bankIds.card('c-9'),
      accountId: otherAccount.id,
      tail: '0009',
    }
    const core = setup({
      users: [...base.users, otherUser],
      accounts: [...base.accounts, otherAccount],
      cards: [...base.cards, otherCard],
    })
    expect((await rejection(() => core.freezeCard(USER, bankIds.card('c-9')))).code).toBe(
      'card-not-owned',
    )
  })

  it('T8 冻结卡：预检 block card-unavailable；直调 createTransfer 也拒且票据不核销', async () => {
    const core = setup()
    await core.freezeCard(USER, CARD_1)
    const preview = await core.previewTransfer({ ...transfer({ amountCents: 10_000 }), viaCardId: CARD_1 })
    expect(preview.verdict).toBe('block')
    expect(preview.risks.find((risk) => risk.code === 'card-unavailable')?.severity).toBe('block')
    expect(preview.viaCard).toEqual({ tail: '1234', status: 'frozen' })

    const ref = ticket(core, { amountCents: 10_000 })
    const before = await core.balance(ACCOUNT)
    expect(
      (await rejection(() => core.createTransfer({ ...transfer({ amountCents: 10_000 }), viaCardId: CARD_1 }, ref)))
        .code,
    ).toBe('card-unavailable')
    expect(core.tickets.status(ref.ticketId)).toBe('approved')
    expect(await core.balance(ACCOUNT)).toEqual(before)
  })

  it('T9 正常卡 viaCardId：预检带 viaCard，执行成功', async () => {
    const core = setup()
    const preview = await core.previewTransfer({ ...transfer({ amountCents: 10_000 }), viaCardId: CARD_1 })
    expect(preview.viaCard).toEqual({ tail: '1234', status: 'normal' })
    expect(preview.verdict).toBe('allow')

    const created = await core.createTransfer(
      { ...transfer({ amountCents: 10_000 }), viaCardId: CARD_1 },
      ticket(core, { amountCents: 10_000 }),
    )
    expect(created.amountCents).toBe(10_000)
  })

  it('T10 不传 viaCardId：零回归（无 viaCard、原语义）', async () => {
    const core = setup()
    const preview = await core.previewTransfer(transfer({ amountCents: 10_000 }))
    expect(preview.viaCard).toBeUndefined()
    expect(preview.verdict).toBe('allow')
    expect((await core.createTransfer(transfer({ amountCents: 10_000 }), ticket(core, { amountCents: 10_000 }))).amountCents).toBe(
      10_000,
    )
  })

  it('跨账户用卡 → card-not-owned（不是参数错）', async () => {
    const core = setup()
    expect(
      (await rejection(() =>
        core.previewTransfer({
          ...transfer({ amountCents: 10_000 }),
          fromAccountId: FIXED,
          viaCardId: CARD_1,
        }),
      )).code,
    ).toBe('card-not-owned')
  })
})

/* ── 信用额度（ADR-0015 · 02 单：额度必须真的约束支付） ───────────────────── */

const CARD_3 = bankIds.card('c-3')

/** 一次卡消费（商户报价是分；`merchantCategory` 用 shopping 避开品类限制噪声）。 */
function spend(
  amountCents: number,
  cardId: Parameters<MockBankCore['spendOnCard']>[0]['cardId'] = CARD_3,
): Parameters<MockBankCore['spendOnCard']>[0] {
  return { userId: USER, cardId, merchantCategory: 'shopping', amountCents }
}

describe('授信额度：申请与额度调整的硬约束', () => {
  it('信用卡不给额度 / 借记卡给额度 / 0 额度 → 各自的结构化拒绝', async () => {
    const core = setup()
    expect((await captureRejection(() => core.applyCard({ userId: USER, kind: 'credit' }))).code).toBe(
      'credit-limit-required',
    )
    expect(
      (await captureRejection(() =>
        core.applyCard({ userId: USER, kind: 'debit', creditLimitCents: 500_000 }),
      )).code,
    ).toBe('credit-not-applicable')
    expect(
      (await captureRejection(() =>
        core.applyCard({ userId: USER, kind: 'credit', creditLimitCents: 0 }),
      )).code,
    ).toBe('credit-limit-invalid')
  })

  it('信用卡的日/月限额缺省 = 授信额度；显式给限额时按给的来', async () => {
    const core = setup()
    const issued = await core.applyCard({ userId: USER, kind: 'credit', creditLimitCents: 300_000 })
    expect(issued).toMatchObject({
      kind: 'credit',
      creditLimitCents: 300_000,
      usedCreditCents: 0,
      dailyLimitCents: 300_000,
      monthlyLimitCents: 300_000,
    })

    const explicit = await core.applyCard({
      userId: USER,
      kind: 'credit',
      creditLimitCents: 300_000,
      dailyLimitCents: 100_000,
      monthlyLimitCents: 900_000,
    })
    expect(explicit).toMatchObject({ dailyLimitCents: 100_000, monthlyLimitCents: 900_000 })
  })

  it('借记卡的授信额度：申请与调整都拒（不把交易限额冒充授信额度）', async () => {
    const core = setup()
    expect(
      (await captureRejection(() =>
        core.setCardLimits(USER, bankIds.card('c-1'), { creditLimitCents: 900_000 }),
      )).code,
    ).toBe('credit-not-applicable')
    // 三项一项都没给：仍然报"至少给一项"（错误码不变）
    expect(
      (await captureRejection(() => core.setCardLimits(USER, bankIds.card('c-1'), {}))).code,
    ).toBe('card-limit-invalid')
  })
})

describe('授信额度：支付时真的生效（ADR-0015 §2.3）', () => {
  it('刷 1200 元成功并占用额度；再刷 4000 元 → credit-limit-exceeded，已用额度一分不动', async () => {
    const core = setup()
    const first = await core.spendOnCard(spend(120_000))
    expect(first.amountCents).toBe(120_000)
    expect((await core.listCards(USER)).find((card) => card.id === CARD_3)?.usedCreditCents).toBe(
      120_000,
    )

    const balanceBefore = await core.balance(ACCOUNT)
    const error = await captureRejection(() => core.spendOnCard(spend(400_000)))
    expect(error.code).toBe('credit-limit-exceeded')
    // detail 三件套：额度 / 已用 / 本笔需要多少（可读文案另说，detail 是机器口径）
    expect(error.detail).toMatchObject({
      creditLimitCents: 500_000,
      usedCreditCents: 120_000,
      neededCents: 400_000,
    })
    expect(error.message).toContain('已用 ¥1,200.00')
    expect(error.message).toContain('可用 ¥3,800.00')

    // 失败不占用、不记账（"扣了钱才发现超额度"是不允许的）
    expect((await core.listCards(USER)).find((card) => card.id === CARD_3)?.usedCreditCents).toBe(
      120_000,
    )
    expect(await core.balance(ACCOUNT)).toEqual(balanceBefore)
  })

  it('边界：正好用满授信额度通过；多 1 分就拒（判定是 ≤ 不是 <）', async () => {
    const core = setup()
    await core.spendOnCard(spend(120_000))
    await core.spendOnCard(spend(380_000)) // 1200 + 3800 = 5000 = 额度
    expect((await core.listCards(USER)).find((card) => card.id === CARD_3)?.usedCreditCents).toBe(
      500_000,
    )
    expect((await captureRejection(() => core.spendOnCard(spend(1)))).code).toBe(
      'credit-limit-exceeded',
    )
  })

  it('降额不得低于已用：调 3000 成功，调 1000 失败（credit-in-use 说清已用多少）', async () => {
    const core = setup()
    await core.spendOnCard(spend(120_000))

    const changed = await core.setCardLimits(USER, CARD_3, { creditLimitCents: 300_000 })
    expect(changed).toMatchObject({
      kind: 'credit',
      creditLimitCents: 300_000,
      usedCreditCents: 120_000,
      changed: true,
    })
    // 额度调低不改日/月交易限额（两者语义不同，改一项不动另一项）
    expect(changed.dailyLimitCents).toBe(500_000)

    const error = await captureRejection(() =>
      core.setCardLimits(USER, CARD_3, { creditLimitCents: 100_000 }),
    )
    expect(error.code).toBe('credit-in-use')
    expect(error.detail).toMatchObject({
      creditLimitCents: 100_000,
      usedCreditCents: 120_000,
      minimumCents: 120_000,
    })
    // 拒绝后额度不变（不是"先改再回滚"）
    expect((await core.listCards(USER)).find((card) => card.id === CARD_3)?.creditLimitCents).toBe(
      300_000,
    )
  })

  it('已用额度是账本事实：幂等重放不重复占用，返回值是副本', async () => {
    const core = setup()
    const req = { ...spend(120_000), idempotencyKey: 'idem-1' }
    const first = await core.spendOnCard(req)
    const replay = await core.spendOnCard(req)
    expect(replay.txnId).toBe(first.txnId)
    expect((await core.listCards(USER)).find((card) => card.id === CARD_3)?.usedCreditCents).toBe(
      120_000,
    )

    const cards = await core.listCards(USER)
    const mutable = cards.find((card) => card.id === CARD_3) as unknown as {
      usedCreditCents: number
    }
    mutable.usedCreditCents = 0
    expect((await core.listCards(USER)).find((card) => card.id === CARD_3)?.usedCreditCents).toBe(
      120_000,
    )
  })

  it('借记卡零回归：没有 kind 的卡不判授信额度，仍走原来的日/月限额路径', async () => {
    const core = setup()
    // c-1：日限 1,000 元。刷 1,200 元被**日限额**拒（错误码必须还是原来那个）
    expect((await captureRejection(() => core.spendOnCard(spend(120_000, bankIds.card('c-1'))))).code).toBe(
      'card-daily-limit-exceeded',
    )
    // 1,000 元整正好用满日限：与改动前同语义
    const ok = await core.spendOnCard(spend(100_000, bankIds.card('c-1')))
    expect(ok.amountCents).toBe(100_000)
    expect((await core.listCards(USER)).find((card) => card.id === bankIds.card('c-1'))?.usedCreditCents).toBeUndefined()
  })
})
