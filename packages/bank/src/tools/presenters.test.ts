/**
 * 工具族 presenter：新卡片与未覆盖面。
 *
 * 只钉**语义**不钉排版：金额必须由「分」换算、状态与标题必须自洽、
 * 合约期后果与告警必须在卡上、可选字段不该凭空出现。
 * 覆盖此前完全没走到的分支：冻结/解冻卡、强验证锁定、订阅列表可选行、
 * 账单报告 / 计算卡、理财列表映射与确认卡坏参数兜底。
 */

import { describe, expect, it } from 'vitest'

import { bankIds } from '../core/index.ts'
import type {
  AnalysisResult,
  BalanceResult,
  BillAnalysisResult,
  BillReportResult,
  SubscriptionListResult,
  TransferPreviewResult,
  TxnQueryResult,
  VerifyResult,
} from './dto.ts'
import type { CardStateResult } from './account-ops.ts'
import {
  analysisCard,
  balanceCard,
  billAnalysisCard,
  billReportCard,
  cardStateCard,
  subscriptionAuthorizeConfirmCard,
  subscriptionCancelConfirmCard,
  subscriptionsCard,
  transferConfirmCard,
  transferPreviewCard,
  txnsCard,
  verifyCard,
  wealthCard,
  wealthPurchaseConfirmCard,
} from './presenters.ts'

/** 2026-10-22 10:00 +08:00（`when()` 按 UTC 展示为 02:00）。 */
const T = Date.UTC(2026, 9, 22, 2, 0, 0)
const DAY = 24 * 60 * 60 * 1000

describe('卡片状态迁移卡（冻结 / 解冻）', () => {
  it('frozen 与 normal 的标题和状态文案都自洽（此前只走到一个分支）', () => {
    const frozen: CardStateResult = {
      cardId: 'c-1',
      tail: '1234',
      status: 'frozen',
      changed: true,
      at: T,
    }
    const unfrozen: CardStateResult = { ...frozen, status: 'normal', changed: true }

    expect(cardStateCard(frozen)).toMatchObject({
      kind: 'bank.card-state',
      data: { title: '卡片已冻结', statusLabel: '已冻结', status: 'frozen', changed: true },
    })
    expect(cardStateCard(unfrozen)).toMatchObject({
      kind: 'bank.card-state',
      data: { title: '卡片已解冻', statusLabel: '正常', status: 'normal', changed: true },
    })
  })

  it('幂等调用（changed=false）如实透传，不伪装成发生过迁移', () => {
    const card = cardStateCard({ cardId: 'c-1', tail: '1234', status: 'frozen', changed: false, at: T })
    expect((card.data as Record<string, unknown>)['changed']).toBe(false)
  })
})

describe('强验证结果卡：锁定提示', () => {
  const base: VerifyResult = {
    channel: 'sms',
    challengeId: 'vc-1',
    success: false,
    attempts: 3,
    remainingAttempts: 0,
  }

  it('lockedUntil 存在 → 带锁定时间与说明', () => {
    const card = verifyCard({ ...base, lockedUntil: T })
    expect(card.data).toMatchObject({
      channelLabel: '短信验证码',
      lockedUntilText: '2026-10-22 02:00',
    })
    expect(String((card.data as Record<string, unknown>)['lockedNote'])).toContain('锁定')
  })

  it('未锁定 → 两个锁定字段都不出现', () => {
    const data = verifyCard(base).data as Record<string, unknown>
    expect(Object.hasOwn(data, 'lockedUntilText')).toBe(false)
    expect(Object.hasOwn(data, 'lockedNote')).toBe(false)
  })
})

describe('转账 / 理财确认卡：坏参数退化为「待定」而不抛错', () => {
  it('合法金额按分换算、收款人姓名去空白', () => {
    const card = transferConfirmCard({ amount: 800, payee: { name: '  王建国 ' } }, 120)
    expect(card.data).toMatchObject({
      amountText: '¥800.00',
      payeeName: '王建国',
      ticketTtlText: '120 秒',
      tier: 'yellow',
    })
  })

  it('金额非正 / 非数字 / 姓名空白 → 对应字段显示待定', () => {
    const data = transferConfirmCard({ amount: -5, payee: { name: '   ' } }, 60).data
    expect(data).toMatchObject({ amountText: '（金额待定）', payeeName: '（收款人待定）' })
  })

  it('理财确认卡缺 productId → 产品待定，金额仍按分换算', () => {
    const data = wealthPurchaseConfirmCard({ amount: 1000 }, 90).data
    expect(data).toMatchObject({
      productId: '（产品待定）',
      amountText: '¥1,000.00',
      tier: 'red',
    })
  })
})

describe('退订 / 关协议确认卡：后果必须复述', () => {
  it('默认「立即取消」；未确认合约期时 note 明确警示合约期硬拦', () => {
    const data = subscriptionCancelConfirmCard({}, 60).data
    expect(data).toMatchObject({ mode: 'now', modeLabel: '立即取消', subscriptionId: '（订阅待定）' })
    expect(String((data as Record<string, unknown>)['note'])).toContain('合约期')
  })

  it('已显式确认合约期 → 文案改成已确认后果（违约金 / 争议工单）', () => {
    const data = subscriptionCancelConfirmCard(
      { subscriptionId: 's-1', mode: 'at-next-cycle', confirmContract: true },
      60,
    ).data
    expect(data).toMatchObject({ contractConfirmed: true, modeLabel: '到期即断' })
    const note = String((data as Record<string, unknown>)['note'])
    expect(note).toContain('已确认合约期后果')
    expect(note).toContain('违约金')
  })

  it('关协议缺商户 → 待定；影响面（全部订阅 / 不可恢复）必须在卡上', () => {
    const data = subscriptionAuthorizeConfirmCard({}, 60).data
    expect(data).toMatchObject({ merchant: '（商户待定）', operation: 'sub_authorize' })
    const note = String((data as Record<string, unknown>)['note'])
    expect(note).toContain('全部订阅')
    expect(note).toContain('不提供恢复')
  })
})

describe('订阅列表卡：事实行可选字段与告警过滤', () => {
  function listResult(): SubscriptionListResult {
    return {
      confirmed: [
        {
          subscriptionId: bankIds.subscription('s-1'),
          merchant: '视频会员',
          merchantKey: 'video',
          cycle: 'monthly',
          amountCents: 1999,
          monthlyCents: 1999,
          nextChargeAt: T,
          status: 'active',
          note: 'hesitating',
          reminderAheadDays: 3,
          contractEndAt: T + 30 * DAY,
          authorizationStatus: 'revoked',
        },
        {
          subscriptionId: bankIds.subscription('s-2'),
          merchant: '云存储',
          merchantKey: 'cloud',
          cycle: 'weekly',
          amountCents: 500,
          monthlyCents: 2167,
          nextChargeAt: T,
          status: 'paused',
        },
      ],
      detected: [
        {
          merchantKey: 'music',
          displayName: '音乐会员',
          kind: 'subscription',
          cycle: 'monthly',
          amountCents: 1200,
          monthlyCents: 1200,
          confidence: 'high',
          nextChargeAt: T,
          count: 3,
          priceHike: { fromCents: 990, toCents: 1200, at: T },
          trialConverted: true,
          suspectedInstallment: true,
        },
        {
          merchantKey: 'water',
          displayName: '水费',
          kind: 'bill',
          cycle: 'quarterly',
          amountCents: 3000,
          monthlyCents: 1000,
          confidence: 'medium',
          nextChargeAt: T,
          count: 2,
        },
      ],
      spendSplit: {
        subscriptionCents: 1200,
        billCents: 3000,
        installmentCents: 0,
        subscriptionCount: 1,
        billCount: 1,
        installmentCount: 0,
      },
      cutoffFindings: [
        { kind: 'cancel', verdict: 'failed', merchantKey: 'music', hint: '取消后仍扣款', dueAt: T },
        {
          kind: 'authorization',
          verdict: 'breached',
          merchantKey: 'video',
          hint: '协议已关闭仍扣款',
          level: 'critical',
          dueAt: T,
        },
        { kind: 'cancel', verdict: 'effective', merchantKey: 'cloud', hint: '已生效', dueAt: T },
      ],
      detectedAt: T,
      basis: { from: T, to: T + 3 * DAY, txnCount: 2 },
      detectorVersion: 'recurring-v1',
    }
  }

  it('只把 failed / breached 进告警，保持原顺序并保留 critical 级别', () => {
    const data = subscriptionsCard(listResult()).data as Record<string, unknown>
    const alerts = data['alerts'] as readonly Record<string, unknown>[]
    expect(alerts.map((alert) => alert['merchantKey'])).toEqual(['music', 'video'])
    expect(alerts[0]?.['level']).toBe('warn')
    expect(alerts[1]?.['level']).toBe('critical')
    expect(alerts.some((alert) => alert['merchantKey'] === 'cloud')).toBe(false)
  })

  it('事实行的提醒 / 合约 / 授权状态只在有值时出现', () => {
    const data = subscriptionsCard(listResult()).data as Record<string, unknown>
    const confirmed = data['confirmed'] as readonly Record<string, unknown>[]
    expect(confirmed[0]).toMatchObject({
      amountText: '¥19.99',
      statusLabel: '生效中',
      cycleLabel: '每月',
      note: 'hesitating',
      reminderText: '提前 3 天提醒',
      contractText: '合约至 2026-11-21',
      authorizationStatus: 'revoked',
    })
    expect(Object.hasOwn(confirmed[1] as Record<string, unknown>, 'reminderText')).toBe(false)
    expect(Object.hasOwn(confirmed[1] as Record<string, unknown>, 'contractText')).toBe(false)
    expect(Object.hasOwn(confirmed[1] as Record<string, unknown>, 'authorizationStatus')).toBe(false)
  })

  it('推断行的涨价 / 试用转正 / 疑似分期只在有值时出现，并带置信度文案', () => {
    const data = subscriptionsCard(listResult()).data as Record<string, unknown>
    const detected = data['detected'] as readonly Record<string, unknown>[]
    expect(detected[0]).toMatchObject({
      kindLabel: '订阅',
      confidenceLabel: '已确认规律',
      priceHikeText: '¥9.90 → ¥12.00',
      trialConverted: true,
      suspectedInstallment: true,
    })
    expect(detected[1]).toMatchObject({ kindLabel: '账单', confidenceLabel: '疑似订阅，确认一下' })
    expect(Object.hasOwn(detected[1] as Record<string, unknown>, 'priceHikeText')).toBe(false)
    expect(Object.hasOwn(detected[1] as Record<string, unknown>, 'trialConverted')).toBe(false)
    expect(Object.hasOwn(detected[1] as Record<string, unknown>, 'suspectedInstallment')).toBe(false)
  })

  it('三分法与取证边界：金额按分换算、天数按 basis 计算、标注「推断」', () => {
    const data = subscriptionsCard(listResult()).data as Record<string, unknown>
    expect(data['split']).toMatchObject({
      subscriptionText: '订阅 1 项 · 月 ¥12.00',
      billText: '账单 1 项 · 月 ¥30.00',
      installmentText: '分期 0 项 · 月 ¥0.00',
    })
    expect(String(data['inferenceNote'])).toBe(
      '基于近 3 天 2 笔流水，生成于 2026-10-22 02:00（推断，非账本事实）',
    )
    expect(data['detectorVersion']).toBe('recurring-v1')
  })
})

describe('账单报告卡 / 计算卡：此前完全未覆盖', () => {
  it('报告卡是折叠长文本，口径与格式原样透传', () => {
    const report: BillReportResult = {
      period: 'year',
      format: 'detail',
      text: '年度账单报告正文',
      analysis: {} as BillReportResult['analysis'],
    }
    expect(billReportCard(report)).toMatchObject({
      kind: 'bank.bill-report',
      data: {
        periodLabel: '近十二个月',
        format: 'detail',
        text: '年度账单报告正文',
        collapsed: true,
      },
    })
  })

  it('计算卡把数值转成字符串，保留运算数与耗时', () => {
    const result: AnalysisResult = { code: '1+2.5', value: 3.5, operations: 2, elapsedMs: 7 }
    expect(analysisCard(result)).toMatchObject({
      kind: 'bank.analysis',
      data: { code: '1+2.5', valueText: '3.5', operations: 2, elapsedMs: 7 },
    })
  })
})

describe('余额卡 / 账单分析卡：剩余分支', () => {
  it('冻结金额非零 → 明确提示差额不可用；为零 → 显示无可冻结金额', () => {
    const base: BalanceResult = {
      accountId: bankIds.account('a-1'),
      tail: '1234',
      balanceCents: 1_234_567,
      availableCents: 1_000_000,
      frozenCents: 234_567,
      asOf: T,
      txnRef: 'balance:c-1',
    }
    expect(balanceCard(base).data).toMatchObject({
      frozenText: '¥2,345.67',
      frozenNote: '差额为理财冻结 / 锁定金额，不可直接使用',
    })
    expect(balanceCard({ ...base, frozenCents: 0 }).data).toMatchObject({
      frozenText: '¥0.00',
      frozenNote: '无可冻结金额',
    })
  })

  it('账单分析的收款人维度按分换算并带占比（此前 byPayee 整块未覆盖）', () => {
    const analysis: BillAnalysisResult = {
      period: 'month',
      months: ['2026-10'],
      totalInCents: 0,
      totalOutCents: 100_000,
      byCategory: [{ category: 'transfer', amountCents: 100_000, sharePct: 100 }],
      byPayee: [{ payee: '王建国', amountCents: 80_000, sharePct: 80 }],
      anomalies: [],
    }
    const data = billAnalysisCard(analysis).data as Record<string, unknown>
    expect(data['payees']).toEqual([{ payee: '王建国', amountText: '¥800.00', shareText: '80%' }])
    expect(data['totalOutText']).toBe('¥1,000.00')
    expect(data['momText']).toBe('无上期数据')
  })
})

describe('交易流水卡 / 转账预演卡：方向与收款人绑定', () => {
  it('出账带负号、入账带正号（符号反了就是账目谎报）', () => {
    const result: TxnQueryResult = {
      items: [
        {
          txnId: bankIds.txn('t-1'),
          at: T,
          amountCents: 1000,
          direction: 'out',
          counterpartyName: '王建国',
          category: 'transfer',
          channel: 'app',
          status: 'success',
        },
        {
          txnId: bankIds.txn('t-2'),
          at: T,
          amountCents: 2000,
          direction: 'in',
          counterpartyName: '工资',
          category: 'salary',
          channel: 'app',
          status: 'success',
        },
      ],
      page: 1,
      limit: 20,
      hasMore: false,
      from: T,
      to: T,
    }
    const items = (txnsCard(result).data as Record<string, unknown>)['items'] as readonly Record<
      string,
      unknown
    >[]
    expect(items.map((item) => item['amountText'])).toEqual(['-¥10.00', '+¥20.00'])
  })

  it('收款人绑定状态必须区分白名单与新人', () => {
    const preview: TransferPreviewResult = {
      amountCents: 80_000,
      feeCents: 0,
      payeeName: '王建国',
      payeeBinding: 'new',
      dailyUsedCents: 0,
      dailyLimitCents: 500_000,
      remainingCents: 500_000,
      risks: [],
      verdict: 'allow',
      effectiveTier: 'yellow',
      at: T,
    }
    expect(transferPreviewCard(preview).data).toMatchObject({ payeeBinding: '新收款人' })
    expect(transferPreviewCard({ ...preview, payeeBinding: 'whitelist' }).data).toMatchObject({
      payeeBinding: '已绑定收款人',
    })
  })
})

describe('理财卡片：产品映射（此前只测过空列表）', () => {
  const catalog = {
    customerRisk: 'R2',
    disclaimerId: 'wealth-risk-v1',
    products: [
      {
        productId: bankIds.product('w-1'),
        name: '稳盈 90 天',
        kind: 'fixed',
        termDays: 90,
        expectedYieldPct: 3.15,
        riskGrade: 'R3',
        minAmountCents: 100_000,
        eligible: false,
        suitabilityNote: '客户风险等级低于产品等级',
      },
      {
        productId: bankIds.product('w-2'),
        name: '活期宝',
        kind: 'deposit',
        termDays: 0,
        expectedYieldPct: 1.5,
        riskGrade: 'R1',
        minAmountCents: 1,
        eligible: true,
      },
    ],
  } as const

  it('list / compare 用不同 kind 与标题，但产品数据同源', () => {
    expect(wealthCard(catalog, 'list')).toMatchObject({
      kind: 'bank.wealth-list',
      data: { title: '理财产品', disclaimerId: 'wealth-risk-v1', customerRisk: 'R2' },
    })
    expect(wealthCard(catalog, 'compare')).toMatchObject({
      kind: 'bank.wealth-compare',
      data: { title: '产品对比' },
    })
  })

  it('不可购买的产品仍然展示并带说明；可购买的不带 suitabilityNote', () => {
    const products = (wealthCard(catalog, 'list').data as Record<string, unknown>)[
      'products'
    ] as readonly Record<string, unknown>[]
    expect(products[0]).toMatchObject({
      yieldText: '3.15%',
      minAmountText: '¥1,000.00',
      eligible: false,
      suitabilityNote: '客户风险等级低于产品等级',
    })
    expect(products[1]).toMatchObject({ yieldText: '1.5%', eligible: true })
    expect(Object.hasOwn(products[1] as Record<string, unknown>, 'suitabilityNote')).toBe(false)
  })
})
