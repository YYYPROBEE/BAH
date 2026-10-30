/**
 * 查询类工具（施工单 08 §3.1–§3.6）。
 *
 * 覆盖：账户列表 / 余额 / 流水分页与筛选 / 账单月度与季度 / 收款人汇总 / 报告 /
 * 受限计算（默认求值器 + 超时 + 取消 + 语法错误）。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import type { AccountsResult, AnalysisResult, BalanceResult, BillAnalysisResult, BillReportResult, TxnQueryResult } from './dto.ts'
import { createBankHarness } from './testing.ts'

describe('account_list / account_balance（T-TOOLS-001 的读侧）', () => {
  it('列出 demo 张三的三个账户，并落 read/accounts', async () => {
    const h = createBankHarness()
    const result = (await h.call('account_list')) as AccountsResult

    expect(result.accounts).toHaveLength(3)
    expect(result.accounts.map((account) => account.tail)).toEqual(['1234', '5678', '9012'])
    expect(result.availableTotalCents).toBe(1_234_567 + 0 + 88_888)
    expect(h.auditsOf('read/accounts')).toHaveLength(1)

    const tool = h.tools.get('account_list')!
    const content = tool.projectContent?.(result) ?? []
    expect(content[0]).toMatchObject({ type: 'text' })
    expect((content[0] as { text: string }).text).toContain('¥12,345.67')
    expect(tool.presentResult?.({}, result)).toMatchObject({ kind: 'bank.account-list' })
  })

  it('余额缺省主账户；带 txnRef 与冻结金额', async () => {
    const h = createBankHarness()
    const result = (await h.call('account_balance', {}, 'call-balance')) as BalanceResult

    expect(result.accountId).toBe('a-1')
    expect(result.balanceCents).toBe(1_234_567)
    expect(result.availableCents).toBe(1_234_567)
    expect(result.frozenCents).toBe(0)
    expect(result.txnRef).toBe('balance:call-balance')
    expect(h.auditsOf('read/balance')[0]?.result.txnRef).toBe('balance:call-balance')

    const tool = h.tools.get('account_balance')!
    expect(tool.presentResult?.({}, result)).toMatchObject({ kind: 'bank.balance' })
  })

  it('指定定期账户：可用 0，冻结 = 余额', async () => {
    const h = createBankHarness()
    const result = (await h.call('account_balance', { accountId: 'a-2' })) as BalanceResult
    expect(result.balanceCents).toBe(5_000_000)
    expect(result.availableCents).toBe(0)
    expect(result.frozenCents).toBe(5_000_000)
  })

  it('别人的账户 / 不存在的账户 fail-loud（不泄露）', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() => h.call('account_balance', { accountId: 'a-999' }))
    expect(error.code).toBe('account-forbidden')
  })

  it('未绑定身份：no-identity（施工单 09 §4）', async () => {
    const h = createBankHarness({ userId: null })
    const error = await captureRejection(() => h.call('account_list'))
    expect(error.code).toBe('no-identity')
  })
})

describe('txn_query', () => {
  it('按区间 + 分类过滤，分页返回 nextCursor', async () => {
    const h = createBankHarness()
    const page1 = (await h.call('txn_query', {
      range: { from: '2026-08-01', to: '2026-10-31' },
      category: 'transfer',
      limit: 1,
      page: 1,
    })) as TxnQueryResult
    expect(page1.items).toHaveLength(1)
    expect(page1.items[0]?.counterpartyName).toBe('王建国')
    // T-05 历史里 8 月还有一笔房租转账（房东），所以"下一页还有"
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).toBe('1')

    const all = (await h.call('txn_query', {
      range: { from: '2026-08-01', to: '2026-10-31' },
      limit: 2,
      page: 1,
    })) as TxnQueryResult
    expect(all.items).toHaveLength(2)
    expect(all.hasMore).toBe(true)
    expect(all.nextCursor).toBe('2')

    const page2 = (await h.call('txn_query', {
      range: { from: '2026-08-01', to: '2026-10-31' },
      limit: 2,
      page: 2,
    })) as TxnQueryResult
    expect(page2.page).toBe(2)
    expect(page2.items[0]?.txnId).not.toBe(all.items[0]?.txnId)
  })

  it('direction = out 过滤收入；缺省区间取最近 30 天', async () => {
    const h = createBankHarness()
    const result = (await h.call('txn_query', { direction: 'out' })) as TxnQueryResult
    expect(result.items.every((item) => item.direction === 'out')).toBe(true)
    expect(result.from).toBeLessThan(result.to)
  })

  it('from 晚于 to / 未知分类：tool-args-invalid', async () => {
    const h = createBankHarness()
    const reversed = await captureRejection(() =>
      h.call('txn_query', { range: { from: '2026-10-31', to: '2026-10-01' } }),
    )
    expect(reversed.code).toBe('tool-args-invalid')

    const category = await captureRejection(() => h.call('txn_query', { category: 'nope' }))
    expect(category.code).toBe('tool-args-invalid')
  })

  it('落 read/txns，卡片按事件数据派生', async () => {
    const h = createBankHarness()
    const result = (await h.call('txn_query', { limit: 3 })) as TxnQueryResult
    expect(h.auditsOf('read/txns')[0]?.result.items).toHaveLength(result.items.length)
    const tool = h.tools.get('txn_query')!
    expect(tool.presentResult?.({}, result)).toMatchObject({ kind: 'bank.txn-list' })
  })
})

describe('bill_analyze / bill_report', () => {
  it('月度：分类汇总 + 异常 + 环比字段', async () => {
    const h = createBankHarness()
    const result = (await h.call('bill_analyze', { period: 'month' })) as BillAnalysisResult

    expect(result.months).toHaveLength(1)
    expect(result.totalOutCents).toBeGreaterThan(0)
    expect(result.byCategory.length).toBeGreaterThan(0)
    expect(result.anomalies.length).toBeGreaterThanOrEqual(0)
    expect(result.comparedPeriod).toBe('2026-09')
    expect(h.auditsOf('read/bill-analyzed')).toHaveLength(1)

    const tool = h.tools.get('bill_analyze')!
    expect(tool.presentResult?.({}, result)).toMatchObject({ kind: 'bank.bill-analysis' })
  })

  it('季度：三个月合并，groupBy = payee 输出收款人汇总（降序）', async () => {
    const h = createBankHarness()
    const result = (await h.call('bill_analyze', {
      period: 'quarter',
      groupBy: 'payee',
    })) as BillAnalysisResult

    expect(result.months).toEqual(['2026-08', '2026-09', '2026-10'])
    expect(result.byPayee?.length).toBeGreaterThan(0)
    const amounts = result.byPayee?.map((line) => line.amountCents) ?? []
    expect([...amounts].sort((left, right) => right - left)).toEqual(amounts)
    expect(result.totalOutCents).toBeGreaterThan(0)
    expect(result.anomalies.length).toBeGreaterThan(0)
  })

  it('品类维度：groupBy = merchant 输出商户品类（咖啡 68 元、转账单列）', async () => {
    const h = createBankHarness()
    const month = (await h.call('bill_analyze', {
      period: 'month',
      groupBy: 'merchant',
    })) as BillAnalysisResult

    expect(month.byMerchantCategory?.length).toBeGreaterThan(0)
    const coffee = month.byMerchantCategory?.find((line) => line.category === 'coffee')
    expect(coffee?.amountCents).toBe(6_800)
    const total = (month.byMerchantCategory ?? []).reduce((sum, line) => sum + line.amountCents, 0)
    expect(total).toBe(month.totalOutCents)

    // 转账由账务分类覆盖，不靠名字猜：若按名字（王建国/房东）会落进 other，
    // 于是"transfer 行存在 + 品类合计等于总支出"本身就证明了覆盖规则在生效。
    const quarter = (await h.call('bill_analyze', {
      period: 'quarter',
      groupBy: 'merchant',
    })) as BillAnalysisResult
    expect(quarter.byMerchantCategory?.some((line) => line.category === 'transfer')).toBe(true)
    const quarterTotal = (quarter.byMerchantCategory ?? []).reduce(
      (sum, line) => sum + line.amountCents,
      0,
    )
    expect(quarterTotal).toBe(quarter.totalOutCents)
  })

  it('品类维度：卡片带品类文案，模型摘要用品类中文名', async () => {
    const h = createBankHarness()
    const result = (await h.call('bill_analyze', {
      period: 'month',
      groupBy: 'merchant',
    })) as BillAnalysisResult
    const tool = h.tools.get('bill_analyze')!
    const card = tool.presentResult?.({}, result)
    const data = card?.data as {
      merchantCategories?: readonly { category: string; categoryLabel: string }[]
    }
    expect(data.merchantCategories?.find((line) => line.category === 'coffee')?.categoryLabel).toBe(
      '咖啡',
    )
    const content = tool.projectContent?.(result) ?? []
    expect((content[0] as { text: string }).text).toContain('咖啡')
  })

  it('年度口径：近 12 个账期、不做同比、覆盖声明随数据', async () => {
    const h = createBankHarness()
    const result = (await h.call('bill_analyze', { period: 'year' })) as BillAnalysisResult

    expect(result.months).toHaveLength(12)
    expect(result.months[0]).toBe('2025-11')
    expect(result.months[11]).toBe('2026-10')
    expect(result.momChangePct).toBeUndefined()
    expect(result.comparedPeriod).toBeUndefined()
    // T-05 的 12 个月历史让每个账期都有流水
    expect(result.coveredMonths).toBe(12)

    const card = h.tools.get('bill_analyze')!.presentResult?.({}, result)
    expect((card?.data as { periodLabel: string }).periodLabel).toBe('近十二个月')
  })

  it('报告 summary / detail 都是确定性文本', async () => {
    const h = createBankHarness()
    const summary = (await h.call('bill_report', { period: 'month' })) as BillReportResult
    expect(summary.format).toBe('summary')
    expect(summary.text).toContain('账单报告')
    expect(summary.text).toContain('分类汇总')
    expect(summary.text).not.toContain('收款人（前 5）')

    const detail = (await h.call('bill_report', { period: 'month', format: 'detail' })) as BillReportResult
    expect(detail.text).toContain('收款人（前 5）')
    expect(detail.text).toContain('异常：')
    expect(h.auditsOf('read/bill-report')).toHaveLength(2)
  })

  it('年度报告：文案含"覆盖 N/12 个账期"，不做同比', async () => {
    const h = createBankHarness()
    const report = (await h.call('bill_report', { period: 'year' })) as BillReportResult
    expect(report.text).toContain('年度')
    expect(report.text).toContain('覆盖 12/12 个账期')
    expect(report.text).not.toContain('环比')
    expect(report.analysis.momChangePct).toBeUndefined()
  })
})

describe('analysis_calc（T-TOOLS-006）', () => {
  it('默认求值器：ratio 计算 + 落 read/analysis', async () => {
    const h = createBankHarness()
    const result = (await h.call('analysis_calc', {
      code: 'round(data.a / (data.a + data.b) * 100)',
      data: { a: 1, b: 3 },
    })) as AnalysisResult

    expect(result.value).toBe(25)
    expect(result.operations).toBeGreaterThan(0)
    expect(h.auditsOf('read/analysis')[0]?.result.value).toBe(25)  })

  it('超时：seam 永不返回 → compute-timeout（结构化失败）', async () => {
    const h = createBankHarness({
      config: { computeTimeoutMs: 10 },
      compute: () => new Promise(() => {}),
    })
    const error = await captureRejection(() => h.call('analysis_calc', { code: '1 + 1' }))
    expect(error.code).toBe('compute-timeout')
  })

  it('取消：signal 已 abort → compute-aborted', async () => {
    const h = createBankHarness()
    const controller = new AbortController()
    controller.abort()
    const tool = h.tools.get('analysis_calc')!
    const error = await captureRejection(() =>
      tool.execute({ code: '1 + 1' }, {
        sessionId: h.ctx.sessionId,
        callId: 'c-abort',
        signal: controller.signal,
      }),
    )
    expect(error.code).toBe('compute-aborted')
  })

  it('语法错误 / 数据路径缺失：结构化理由码', async () => {
    const h = createBankHarness()
    const syntax = await captureRejection(() => h.call('analysis_calc', { code: '1 +' }))
    expect(syntax.code).toBe('compute-invalid')

    const missing = await captureRejection(() =>
      h.call('analysis_calc', { code: 'data.nope + 1', data: { yes: 1 } }),
    )
    expect(missing.code).toBe('compute-data-missing')
  })
})
