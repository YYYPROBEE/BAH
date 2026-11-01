/**
 * TC-W03-06：两个资产处置工具的档位必须"声明即执行"。
 *
 * 只钉声明面不够（`specOf().tier` 只是元数据）：真正要证明的是
 * **红档真的会带上强验证挑战、黄档真的只问一次**，且两者都落各自领域事件。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import { bankIds } from '../core/index.ts'
import type { AccountsResult } from './dto.ts'
import type { CardIssuedResult, CardLimitsResult, CardRestrictionsResult } from './dto.ts'
import type { CardStateResult } from './account-ops.ts'
import { BANK_TOOL_NAMES, specOf, type BankToolName } from './specs.ts'
import { decide } from './tier.ts'
import { createBankHarness, createPipelineHarness, TEST_CONFIG } from './testing.ts'

/** 取某类会话事件载荷。 */
function payloads(
  harness: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return harness
    .events()
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>)
}

describe('TC-W03-06 新工具的档位（声明 + 行为）', () => {
  const CONFIG = {
    dailyTransferLimitCents: TEST_CONFIG.dailyTransferLimit,
    riskyOps: TEST_CONFIG.riskyOps,
    riskyCallThreshold: TEST_CONFIG.riskyCallThreshold,
  }
  const levelOf = (name: BankToolName) =>
    decide({
      name,
      declared: specOf(name).tier.level,
      config: CONFIG,
      state: { userId: 'u-1', riskyCallsInTurn: 0, verifyLocked: false },
    })

  it('C1 挂失红 / 冻结黄 / 解冻红（同一模块跨三级）', () => {
    expect(levelOf('card_report_lost')).toMatchObject({ kind: 'ask', level: 'red', challenge: true })
    expect(levelOf('card_freeze')).toMatchObject({ kind: 'ask', level: 'yellow', challenge: false })
    expect(levelOf('card_unfreeze')).toMatchObject({ kind: 'ask', level: 'red', challenge: true })
    expect(levelOf('card_apply')).toMatchObject({ kind: 'ask', level: 'yellow', challenge: false })
    expect(levelOf('card_limit_set')).toMatchObject({ kind: 'ask', level: 'red', challenge: true })
    expect(levelOf('card_restriction')).toMatchObject({
      kind: 'ask',
      level: 'yellow',
      challenge: false,
    })
  })

  it('C2 未绑定身份：卡片写操作一律 deny no-identity', () => {
    const verdict = decide({
      name: 'card_freeze',
      declared: specOf('card_freeze').tier.level,
      config: CONFIG,
      state: { userId: undefined, riskyCallsInTurn: 0, verifyLocked: false },
    })
    expect(verdict).toMatchObject({ kind: 'deny', code: 'no-identity' })
  })

  it('C3 冻结后用该卡转账：预检 block，治理面据此拒', async () => {
    const h = createBankHarness()
    await h.call('card_freeze', { cardId: 'c-1' })
    const preview = await h.core.previewTransfer({
      fromAccountId: bankIds.account('a-1'),
      payee: { name: '王建国' },
      amountCents: 10_000,
      channel: 'app',
      viaCardId: bankIds.card('c-1'),
    })
    expect(preview.risks.find((risk) => risk.code === 'card-unavailable')?.severity).toBe('block')
    expect(preview.verdict).toBe('block')
  })

  it('C4 批量停卡：没有批量工具，两张卡必须两次调用', async () => {
    expect(BANK_TOOL_NAMES.some((name) => name.includes('batch'))).toBe(false)
    const h = createBankHarness()
    await h.call('card_freeze', { cardId: 'c-1' })
    await h.call('card_freeze', { cardId: 'c-2' })
    expect(h.auditsOf('card/state-changed')).toHaveLength(2)
  })

  it('先 account_list 取 cardId，再挂失（端到端可达）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const listed = await h.run('account_list', {})
      expect(listed.result.isError).toBe(false)

      const target = (listed.value as AccountsResult).cards.find((card) => card.tail === '1234')
      expect(target).toBeDefined()

      const execution = await h.run('card_report_lost', { cardId: target!.cardId })
      expect(execution.result.isError).toBe(false)
      expect(h.audits.find((record) => record.type === 'card/reported-lost')?.data).toMatchObject(
        { cardId: target!.cardId, status: 'lost' },
      )
    } finally {
      await h.dispose()
    }
  })

  it('声明面：card_report_lost 红档 / sub_cancel 黄档，且都不带 amountPath', () => {
    expect(specOf('card_report_lost').tier).toEqual({ level: 'red' })
    expect(specOf('sub_cancel').tier).toEqual({ level: 'yellow' })
  })

  it('card_report_lost 走红档：审批携带强验证挑战，落 card/reported-lost', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('card_report_lost', { cardId: bankIds.card('c-1') })

      expect(execution.result.isError).toBe(false)
      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        name: 'card_report_lost',
        challenge: TEST_CONFIG.redChallenge,
      })
      expect(h.audits.map((record) => record.type)).toContain('card/reported-lost')
      expect(h.audits.find((record) => record.type === 'card/reported-lost')?.data).toMatchObject({
        cardId: 'c-1',
        status: 'lost',
      })
    } finally {
      await h.dispose()
    }
  })

  it('sub_cancel 走黄档：只审批、不带强验证挑战，落 sub/cancelled', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('sub_cancel', {
        subscriptionId: bankIds.subscription('s-1'),
      })

      expect(execution.result.isError).toBe(false)
      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(1)
      expect(asked[0]?.['name']).toBe('sub_cancel')
      expect(asked[0]?.['challenge']).toBeUndefined()
      expect(h.audits.map((record) => record.type)).toContain('sub/cancelled')
      expect(h.audits.find((record) => record.type === 'sub/cancelled')?.data).toMatchObject({
        subscriptionId: 's-1',
        merchant: '视频会员',
      })
    } finally {
      await h.dispose()
    }
  })

  it('T1/T2 冻结：首次发一条迁移事件，重复调用 changed=false 且不发事件', async () => {
    const h = createBankHarness()
    const first = (await h.call('card_freeze', { cardId: 'c-1', reason: '疑似盗刷' })) as CardStateResult
    const second = (await h.call('card_freeze', { cardId: 'c-1' })) as CardStateResult

    expect(first).toMatchObject({ cardId: 'c-1', tail: '1234', status: 'frozen', changed: true })
    expect(second.changed).toBe(false)
    expect(h.auditsOf('card/state-changed')).toHaveLength(1)
    expect(h.auditsOf('card/state-changed')[0]).toMatchObject({
      cardId: 'c-1',
      tail: '1234',
      from: 'normal',
      to: 'frozen',
      reason: 'freeze',
      note: '疑似盗刷',
    })
  })

  it('T4 解冻：反向迁移事件，重复调用幂等', async () => {
    const h = createBankHarness()
    await h.call('card_freeze', { cardId: 'c-1' })
    const first = (await h.call('card_unfreeze', { cardId: 'c-1' })) as CardStateResult
    const second = (await h.call('card_unfreeze', { cardId: 'c-1' })) as CardStateResult

    expect(first).toMatchObject({ status: 'normal', changed: true })
    expect(second.changed).toBe(false)
    expect(h.auditsOf('card/state-changed')).toHaveLength(2)
    expect(h.auditsOf('card/state-changed')[1]).toMatchObject({
      from: 'frozen',
      to: 'normal',
      reason: 'unfreeze',
    })
  })

  it('T8 冻结后转账：管线早拒 card-unavailable，票据不签发', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      await h.run('card_freeze', { cardId: 'c-1' })

      const execution = await h.run('transfer_create', {
        amount: 100,
        payee: { name: '王建国', phone: '13900002222' },
        viaCardId: 'c-1',
      })
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('card-unavailable')
      const asked = payloads(h, 'approval/asked').filter(
        (payload) => payload['name'] === 'transfer_create',
      )
      expect(asked).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('拒绝即不执行：红档被拒后不落 card/reported-lost', async () => {
    const h = createPipelineHarness({ approval: 'rejected' })
    try {
      const execution = await h.run('card_report_lost', { cardId: bankIds.card('c-2') })

      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('approval-rejected')
      expect(h.audits.map((record) => record.type)).not.toContain('card/reported-lost')
    } finally {
      await h.dispose()
    }
  })
})

describe('场景 4 补齐：卡申请 / 额度调整 / 交易限制', () => {
  it('card_apply 缺省虚拟卡：挂在主活期，落 card/issued', async () => {
    const h = createBankHarness()
    const issued = (await h.call('card_apply', {})) as CardIssuedResult
    expect(issued).toMatchObject({
      type: 'virtual',
      status: 'normal',
      dailyLimitCents: 200_000,
      monthlyLimitCents: 800_000,
    })
    expect(issued.tail).toMatch(/^\d{4}$/)
    expect(h.auditsOf('card/issued')).toEqual([
      {
        cardId: issued.cardId,
        accountId: issued.accountId,
        tail: issued.tail,
        type: 'virtual',
        dailyLimitCents: 200_000,
        monthlyLimitCents: 800_000,
        at: expect.any(Number),
      },
    ])
    const cards = await h.core.listCards(bankIds.user('u-1'))
    expect(cards.some((card) => card.id === issued.cardId)).toBe(true)
  })

  it('card_apply 实体卡 + 指定额度：参数落到账本', async () => {
    const h = createBankHarness()
    const issued = (await h.call('card_apply', {
      type: 'physical',
      dailyLimitYuan: 500,
      monthlyLimitYuan: 5_000,
    })) as CardIssuedResult
    expect(issued).toMatchObject({
      type: 'physical',
      dailyLimitCents: 50_000,
      monthlyLimitCents: 500_000,
    })
  })

  it('card_limit_set：调整并落 from/to；重复调用 changed=false 不发事件', async () => {
    const h = createBankHarness()
    const first = (await h.call('card_limit_set', {
      cardId: 'c-1',
      dailyLimitYuan: 500,
      monthlyLimitYuan: 5_000,
    })) as CardLimitsResult
    expect(first).toMatchObject({
      dailyLimitCents: 50_000,
      monthlyLimitCents: 500_000,
      changed: true,
    })
    expect(h.auditsOf('card/limits-changed')).toHaveLength(1)
    expect(h.auditsOf('card/limits-changed')[0]).toMatchObject({
      cardId: 'c-1',
      from: { dailyLimitCents: 100_000, monthlyLimitCents: 2_000_000 },
      to: { dailyLimitCents: 50_000, monthlyLimitCents: 500_000 },
    })

    const second = (await h.call('card_limit_set', {
      cardId: 'c-1',
      dailyLimitYuan: 500,
      monthlyLimitYuan: 5_000,
    })) as CardLimitsResult
    expect(second.changed).toBe(false)
    expect(h.auditsOf('card/limits-changed')).toHaveLength(1)
  })

  it('card_limit_set：日限额高于月限额 → card-limit-invalid', async () => {
    const h = createBankHarness()
    await expect(
      h.call('card_limit_set', {
        cardId: 'c-1',
        dailyLimitYuan: 5_000,
        monthlyLimitYuan: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'card-limit-invalid' })
  })

  it('card_restriction：set 后 clear，事件按次落账；category 缺 value 被拒', async () => {
    const h = createBankHarness()
    const set = (await h.call('card_restriction', {
      cardId: 'c-1',
      mode: 'set',
      kind: 'online',
      note: '防误刷',
    })) as CardRestrictionsResult
    expect(set.restrictions).toEqual([{ kind: 'online', note: '防误刷', at: expect.any(Number) }])

    const clear = (await h.call('card_restriction', {
      cardId: 'c-1',
      mode: 'clear',
      kind: 'online',
    })) as CardRestrictionsResult
    expect(clear.restrictions).toEqual([])
    expect(h.auditsOf('card/restrictions-changed')).toHaveLength(2)

    await expect(
      h.call('card_restriction', { cardId: 'c-1', mode: 'set', kind: 'category' }),
    ).rejects.toMatchObject({ code: 'card-restriction-invalid' })
  })

  it('挂失后不能调额或改交易限制', async () => {
    const h = createBankHarness()
    await h.call('card_report_lost', { cardId: 'c-1' })
    await expect(
      h.call('card_limit_set', { cardId: 'c-1', dailyLimitYuan: 500 }),
    ).rejects.toMatchObject({ code: 'card-lost' })
    await expect(
      h.call('card_restriction', { cardId: 'c-1', mode: 'set', kind: 'online' }),
    ).rejects.toMatchObject({ code: 'card-lost' })
  })

  it('card_limit_set 走红档：审批携带强验证挑战，落 card/limits-changed', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('card_limit_set', {
        cardId: bankIds.card('c-1'),
        dailyLimitYuan: 500,
        monthlyLimitYuan: 5_000,
      })
      expect(execution.result.isError).toBe(false)
      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        name: 'card_limit_set',
        challenge: TEST_CONFIG.redChallenge,
      })
      expect(h.audits.map((record) => record.type)).toContain('card/limits-changed')
    } finally {
      await h.dispose()
    }
  })

  it('交易限制：online 限制让以卡支付预检 block，核销前拒绝；解除后恢复', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      await h.run('card_restriction', { cardId: 'c-1', mode: 'set', kind: 'online' })

      const listed = await h.run('account_list', {})
      const listedCards = (listed.value as AccountsResult).cards
      expect(listedCards.find((card) => card.cardId === 'c-1')?.restrictions).toMatchObject([
        { kind: 'online' },
      ])

      const preview = await h.core.previewTransfer({
        fromAccountId: bankIds.account('a-1'),
        payee: { name: '王建国', phone: '13900002222' },
        amountCents: 10_000,
        channel: 'app',
        viaCardId: bankIds.card('c-1'),
      })
      expect(preview.risks.find((risk) => risk.code === 'card-restricted')?.severity).toBe('block')
      expect(preview.verdict).toBe('block')

      const blocked = await h.run('transfer_create', {
        amount: 100,
        payee: { name: '王建国', phone: '13900002222' },
        viaCardId: 'c-1',
      })
      expect(blocked.result.isError).toBe(true)
      expect(blocked.result.code).toBe('card-restricted')

      await h.run('card_restriction', { cardId: 'c-1', mode: 'clear', kind: 'online' })
      // 同一 turn 内完全相同的参数会被 ToolGuard 的单调 deny 记住；换金额即新指纹。
      const allowed = await h.run('transfer_create', {
        amount: 101,
        payee: { name: '王建国', phone: '13900002222' },
        viaCardId: 'c-1',
      })
      expect(allowed.result.isError).toBe(false)
    } finally {
      await h.dispose()
    }
  })

  it('category 限制不误伤转账（品类只在卡消费通道生效）', async () => {
    const h = createBankHarness()
    await h.call('card_restriction', { cardId: 'c-1', mode: 'set', kind: 'category', value: 'dining' })
    const preview = await h.core.previewTransfer({
      fromAccountId: bankIds.account('a-1'),
      payee: { name: '王建国', phone: '13900002222' },
      amountCents: 10_000,
      channel: 'app',
      viaCardId: bankIds.card('c-1'),
    })
    expect(preview.risks.some((risk) => risk.code === 'card-restricted')).toBe(false)
  })
})

/**
 * 补发（2026-11-01）：挂失之后必须有一条"补一张"的路。
 *
 * 这条补的是赛题场景 4 的断链——原实现挂失后只回一句"补发流程以银行通知为准"，
 * 用户拿着废卡无处可去。语义边界：**只有已挂失**能补；补发不改账户归属；
 * 旧卡保持 lost 终态（补发不是解挂）。
 */
describe('card_apply 补发', () => {
  it('未挂失 → card-not-lost；挂失后补发挂回同一账户，旧卡仍 lost', async () => {
    const h = createBankHarness()
    const before = await h.core.listCards(bankIds.user('u-1'))
    const original = before.find((item) => item.id === 'c-1')
    expect(original).toBeDefined()

    const notLost = await captureRejection(() => h.call('card_apply', { replacesCardId: 'c-1' }))
    expect((notLost as { code?: string }).code).toBe('card-not-lost')

    await h.call('card_report_lost', { cardId: 'c-1' })
    const issued = (await h.call('card_apply', { replacesCardId: 'c-1' })) as CardIssuedResult
    expect(issued.replacedCardId).toBe('c-1')
    expect(issued.accountId).toBe(original?.accountId)
    expect(issued.cardId).not.toBe('c-1')
    // 补发不是解挂：旧卡必须留在 lost 终态
    const after = await h.core.listCards(bankIds.user('u-1'))
    expect(after.find((item) => item.id === 'c-1')?.status).toBe('lost')
  })
})

/**
 * 信用额度（ADR-0015 · 02 单）：工具面必须把"授信额度"与"交易限额"分开，
 * 且额度真的落在支付路径上（不是展示字段）。
 *
 * 这里钉的是**工具边界**的四件事：参数成对校验、事件载荷只在信用产品上多两个键、
 * 文案能读出"额度 / 已用 / 可用"、降额不得低于已用。
 */
describe('信用卡授信额度（ADR-0015）', () => {
  it('card_apply：kind=credit + 额度 → 落账并落 card/issued 的 creditLimitCents', async () => {
    const h = createBankHarness()
    const issued = (await h.call('card_apply', {
      kind: 'credit',
      creditLimitYuan: 5_000,
    })) as CardIssuedResult
    expect(issued).toMatchObject({
      kind: 'credit',
      type: 'virtual',
      status: 'normal',
      creditLimitCents: 500_000,
      usedCreditCents: 0,
      // 缺省日/月限额 = 授信额度（额度是天花板）
      dailyLimitCents: 500_000,
      monthlyLimitCents: 500_000,
    })
    expect(h.auditsOf('card/issued')).toEqual([
      {
        cardId: issued.cardId,
        accountId: issued.accountId,
        tail: issued.tail,
        type: 'virtual',
        dailyLimitCents: 500_000,
        monthlyLimitCents: 500_000,
        creditLimitCents: 500_000,
        at: expect.any(Number),
      },
    ])

    const text = ((h.tools.get('card_apply')!.projectContent?.(issued) ?? [])[0] as {
      text: string
    }).text
    expect(text).toContain('虚拟信用卡')
    expect(text).toContain('授信额度 ¥5,000.00、已用 ¥0.00、可用 ¥5,000.00')
  })

  it('card_apply：借记卡传额度 / 信用卡不给额度 → tool-args-invalid（参数成对）', async () => {
    const h = createBankHarness()
    expect(
      (await captureRejection(() => h.call('card_apply', { creditLimitYuan: 5_000 }))).code,
    ).toBe('tool-args-invalid')
    expect(
      (await captureRejection(() => h.call('card_apply', { kind: 'debit', creditLimitYuan: 5_000 })))
        .code,
    ).toBe('tool-args-invalid')
    expect((await captureRejection(() => h.call('card_apply', { kind: 'credit' }))).code).toBe(
      'tool-args-invalid',
    )
    // 拒绝之后没有多余的卡落账
    expect(h.auditsOf('card/issued')).toHaveLength(0)
  })

  it('额度真的约束支付：刷 1200 成功；再刷 4000 被额度拒（日/月限额没挡住）', async () => {
    const h = createBankHarness()
    const issued = (await h.call('card_apply', { kind: 'credit', creditLimitYuan: 5_000 })) as CardIssuedResult
    const cardId = issued.cardId as never

    const first = await h.core.spendOnCard({
      userId: bankIds.user('u-1'),
      cardId,
      merchantCategory: 'shopping',
      amountCents: 120_000,
    })
    expect(first.amountCents).toBe(120_000)

    const error = await captureRejection(() =>
      h.core.spendOnCard({
        userId: bankIds.user('u-1'),
        cardId,
        merchantCategory: 'shopping',
        amountCents: 400_000,
      }),
    )
    // 关键判据：失败码是 credit-limit-exceeded，不是 card-daily-limit-exceeded
    expect(error.code).toBe('credit-limit-exceeded')

    const listed = (await h.call('account_list')) as AccountsResult
    const view = listed.cards.find((card) => card.cardId === issued.cardId)
    expect(view).toMatchObject({ creditLimitCents: 500_000, usedCreditCents: 120_000 })
  })

  it('card_limit_set：调授信额度落 from/to + creditLimitCents/usedCreditCents；降额低于已用 → credit-in-use', async () => {
    const h = createBankHarness()
    await h.core.spendOnCard({
      userId: bankIds.user('u-1'),
      cardId: bankIds.card('c-3'),
      merchantCategory: 'shopping',
      amountCents: 120_000,
    })

    const raised = (await h.call('card_limit_set', {
      cardId: 'c-3',
      creditLimitYuan: 3_000,
    })) as CardLimitsResult
    expect(raised).toMatchObject({
      kind: 'credit',
      creditLimitCents: 300_000,
      usedCreditCents: 120_000,
      changed: true,
    })
    expect(h.auditsOf('card/limits-changed')).toEqual([
      {
        cardId: 'c-3',
        tail: '2468',
        from: { dailyLimitCents: 500_000, monthlyLimitCents: 500_000 },
        to: { dailyLimitCents: 500_000, monthlyLimitCents: 500_000 },
        creditLimitCents: 300_000,
        usedCreditCents: 120_000,
        at: expect.any(Number),
      },
    ])

    const text = ((h.tools.get('card_limit_set')!.projectContent?.(raised) ?? [])[0] as {
      text: string
    }).text
    expect(text).toContain('授信额度 ¥3,000.00、已用 ¥1,200.00、可用 ¥1,800.00')

    // 降到已用（1200 元）以下：拒，且额度不变
    const error = await captureRejection(() =>
      h.call('card_limit_set', { cardId: 'c-3', creditLimitYuan: 1_000 }),
    )
    expect(error.code).toBe('credit-in-use')
    const cards = await h.core.listCards(bankIds.user('u-1'))
    expect(cards.find((card) => card.id === 'c-3')?.creditLimitCents).toBe(300_000)
    // 拒绝不落事件（只有上面那次成功的事件）
    expect(h.auditsOf('card/limits-changed')).toHaveLength(1)
  })

  it('card_limit_set：借记卡传 creditLimitYuan → tool-args-invalid（不把交易限额冒充授信额度）', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() =>
      h.call('card_limit_set', { cardId: 'c-1', creditLimitYuan: 9_000 }),
    )
    expect(error.code).toBe('tool-args-invalid')
    expect(error.message).toContain('借记卡')
    // 借记卡的三个限额一项都没动
    const cards = await h.core.listCards(bankIds.user('u-1'))
    expect(cards.find((card) => card.id === 'c-1')).toMatchObject({
      dailyLimitCents: 100_000,
      monthlyLimitCents: 2_000_000,
    })
  })
})
