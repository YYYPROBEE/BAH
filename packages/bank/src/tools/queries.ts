/**
 * P0 查询类工具。
 *
 * 这些工具只读：`account_list` / `account_balance` / `txn_query` / `bill_analyze` /
 * `bill_report` / `analysis_calc`。写操作一个都不在这里。
 *
 * 金额口径：模型参数是「元」，核心与事件是「分」；展示用 `formatYuan`。
 */

import { assertNever, BahError } from '@bah/util'

import type { ToolDefinition, ToolExecContext } from '@bah/core'

import type {
  Account,
  Card,
  CardRestriction,
  MerchantCategory,
  Transaction,
  TxnCategory,
} from '../core/index.ts'
import {
  bankIds,
  formatYuan,
  isMerchantCategory,
  MERCHANT_LABEL,
  merchantCategoryOf,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  toPct,
} from '../core/index.ts'
import { DAY_MS, monthKey, periodRange, previousMonth } from '../core/time.ts'
import { requireAccount, requireUserId, tailOf } from './accounts.ts'
import { readEnum, readOptionalObject, readOptionalPositiveInteger, readOptionalString, readString } from './args.ts'
import { defaultCompute } from './compute.ts'
import type {
  AccountsResult,
  AccountView,
  AnalysisResult,
  BalanceResult,
  BillAnalysisResult,
  BillCategoryLine,
  BillMerchantLine,
  BillPayeeLine,
  BillReportResult,
  CardView,
  TxnQueryResult,
  TxnView,
} from './dto.ts'
import { parseBillScope, type BillScope } from './inputs.ts'
import {
  analysisCard,
  accountsCard,
  balanceCard,
  billAnalysisCard,
  billReportCard,
  CARD_STATUS_LABEL,
  CARD_TYPE_LABEL,
  CATEGORY_LABEL,
  txnsCard,
} from './presenters.ts'
import { specOf } from './specs.ts'
import { formatInstant, parseInstant, shiftMonth } from './time.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** 交易分类全集（参数校验用）。 */
const TXN_CATEGORIES: readonly TxnCategory[] = [
  'transfer',
  'salary',
  'consumption',
  'subscription',
  'wealth',
  'fee',
  'refund',
]

/** `account_list`。 */
export function createAccountListTool(deps: BankToolDeps): ToolDefinition<unknown, AccountsResult> {
  const spec = specOf('account_list')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (_args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const [accounts, cards] = await Promise.all([
        deps.core.listAccounts(bankIds.user(userId)),
        deps.core.listCards(bankIds.user(userId)),
      ])
      const result: AccountsResult = {
        accounts: accounts.map(toAccountView),
        cards: cards.map(toCardView),
        availableTotalCents: accounts.reduce((total, account) => total + account.availableCents, 0),
      }
      deps.audit.append('read/accounts', { result })
      return result
    },
    projectContent: (result) => {
      const lines = result.accounts.map(
        (account) =>
          `尾号 ${account.tail}（${account.type}）：余额 ${formatYuan(account.balanceCents)}，可用 ${formatYuan(account.availableCents)}`,
      )
      const cardLines = result.cards.map((card) => {
        // 信用产品多一段"额度/已用/可用"（ADR-0015）：可用是派生值，只在文案里算，不落字段。
        const credit =
          card.kind === 'credit' && card.creditLimitCents !== undefined
            ? `，授信额度 ${formatYuan(card.creditLimitCents)}、已用 ${formatYuan(card.usedCreditCents ?? 0)}` +
              `、可用 ${formatYuan(Math.max(0, card.creditLimitCents - (card.usedCreditCents ?? 0)))}`
            : ''
        return (
          `${CARD_TYPE_LABEL[card.type]}${card.kind === 'credit' ? '信用' : ''}卡尾号 ${card.tail}（卡ID ${card.cardId}，${CARD_STATUS_LABEL[card.status]}，日限 ${formatYuan(card.dailyLimitCents)}` +
          credit +
          (card.restrictions === undefined || card.restrictions.length === 0
            ? '）'
            : `，限制：${card.restrictions.map((item) => restrictionLabel(item)).join('、')}）`)
        )
      })
      return [
        {
          type: 'text',
          text:
            `共 ${result.accounts.length} 个账户，可用合计 ${formatYuan(result.availableTotalCents)}。\n${lines.join('\n')}` +
            (cardLines.length === 0
              ? ''
              : `\n名下 ${result.cards.length} 张卡：\n${cardLines.join('\n')}`),
        },
      ]
    },
    presentResult: (_args, result) => accountsCard(result),
  } satisfies ToolDefinition<unknown, AccountsResult>
}

/** `account_balance`。 */
export function createAccountBalanceTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, BalanceResult> {
  const spec = specOf('account_balance')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const account = await requireAccount(
        deps,
        userId,
        readOptionalString(args, 'accountId', 'account_balance'),
      )
      return readBalance(deps, account, ctx.callId)
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          `账户尾号 ${result.tail}：余额 ${formatYuan(result.balanceCents)}，` +
          `可用 ${formatYuan(result.availableCents)}，冻结 ${formatYuan(result.frozenCents)}。` +
          `对账引用 ${result.txnRef}（转述金额必须以此为准）。`,
      },
    ],
    presentResult: (_args, result) => balanceCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, BalanceResult>
}

/** `txn_query`。 */
export function createTxnQueryTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, TxnQueryResult> {
  const spec = specOf('txn_query')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const account = await requireAccount(
        deps,
        userId,
        readOptionalString(args, 'accountId', 'txn_query'),
      )
      const now = clockOf(deps)()
      const range = readOptionalObject(args, 'range', 'txn_query')
      const from =
        range === undefined ? now - 30 * DAY_MS : parseInstant(range['from'], 'txn_query.range.from')
      const to =
        range === undefined
          ? now
          : parseInstant(range['to'], 'txn_query.range.to', true)
      if (from > to) {
        throw new BahError('tool-args-invalid', 'bank-tools: range.from 不能晚于 range.to', {
          from,
          to,
        })
      }

      const category = readEnum(args, 'category', 'txn_query', TXN_CATEGORIES)
      const direction = readEnum(args, 'direction', 'txn_query', ['in', 'out'] as const)
      const page = readOptionalPositiveInteger(args, 'page', 'txn_query') ?? 1
      const cursor = readOptionalString(args, 'cursor', 'txn_query')
      const limit = Math.min(
        PAGE_LIMIT_MAX,
        readOptionalPositiveInteger(args, 'limit', 'txn_query') ?? PAGE_LIMIT_DEFAULT,
      )
      // 游标直收（上一页 nextCursor）；给了游标就忽略 page，结果页按偏移换算
      const offset = cursor === undefined ? (page - 1) * limit : Number(cursor)
      const effectivePage =
        Number.isSafeInteger(offset) && offset >= 0 ? Math.floor(offset / limit) + 1 : page

      const queried = await deps.core.queryTransactions({
        userId: bankIds.user(userId),
        accountId: account.id,
        from,
        to,
        ...(category === undefined ? {} : { category }),
        ...(direction === undefined ? {} : { direction }),
        limit,
        ...(offset === 0 ? {} : { cursor: String(offset) }),
      })
      const items = queried.items.map(toTxnView)
      const result: TxnQueryResult = {
        items,
        page: effectivePage,
        limit,
        hasMore: queried.nextCursor !== undefined,
        ...(queried.nextCursor === undefined ? {} : { nextCursor: queried.nextCursor }),
        from,
        to,
      }
      deps.audit.append('read/txns', { result })
      return result
    },
    projectContent: (result) => {
      const lines = result.items.map(
        (item) =>
          `${formatInstant(item.at)} ${item.direction === 'out' ? '-' : '+'}${formatYuan(item.amountCents)} ` +
          `${item.counterpartyName}（${item.category}）`,
      )
      return [
        {
          type: 'text',
          text:
            `第 ${result.page} 页，共 ${result.items.length} 条${result.hasMore ? '，还有下一页' : ''}。\n` +
            (lines.length === 0 ? '（该区间没有交易）' : lines.join('\n')),
        },
      ]
    },
    presentResult: (_args, result) => txnsCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, TxnQueryResult>
}

/** `bill_analyze`。 */
export function createBillAnalyzeTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, BillAnalysisResult> {
  const spec = specOf('bill_analyze')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const account = await requireAccount(deps, userId)
      const scope = parseBillScope(args)
      const groupBy =
        readEnum(args, 'groupBy', 'bill_analyze', ['category', 'payee', 'merchant'] as const) ??
        'category'
      const result = await buildBillAnalysis(deps, userId, account, scope, groupBy)
      deps.audit.append('read/bill-analyzed', { result })
      return result
    },
    projectContent: (result) => [{ type: 'text', text: summarizeBill(result) }],
    presentResult: (_args, result) => billAnalysisCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, BillAnalysisResult>
}

/** `bill_report`。 */
export function createBillReportTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, BillReportResult> {
  const spec = specOf('bill_report')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const account = await requireAccount(deps, userId)
      const scope = parseBillScope(args)
      const format = readEnum(args, 'format', 'bill_report', ['summary', 'detail'] as const) ?? 'summary'
      // `format` 只决定"报不报收款人明细"（`composeReport` 那一侧），
      // `groupBy` 只决定"算哪个维度"；两者拆开，避免"要商户维度就必须出详细报告"。
      const analysis = await buildBillAnalysis(deps, userId, account, scope, 'payee')
      const result: BillReportResult = {
        period: scope.period,
        format,
        text: composeReport(analysis, format),
        analysis,
      }
      deps.audit.append('read/bill-report', { result })
      return result
    },
    projectContent: (result) => [{ type: 'text', text: result.text }],
    presentResult: (_args, result) => billReportCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, BillReportResult>
}

/** `analysis_calc`。 */
export function createAnalysisTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, AnalysisResult> {
  const spec = specOf('analysis_calc')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const code = readString(args, 'code', 'analysis_calc')
      const data = readOptionalObject(args, 'data', 'analysis_calc')
      const result = await runBoundedCompute(deps, ctx, code, data)
      deps.audit.append('read/analysis', { result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text: `${result.code} = ${String(result.value)}（${result.operations} 次运算，${result.elapsedMs} ms）`,
      },
    ],
    presentResult: (_args, result) => analysisCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, AnalysisResult>
}

/* ────────────────────────────────────────────────────────────────────────────
 * 共享实现
 * ──────────────────────────────────────────────────────────────────────────── */

/** 读余额 + 落账（`account_balance` 的工具体；测试可直接复用）。 */
export async function readBalance(
  deps: BankToolDeps,
  account: Account,
  callId: string,
): Promise<BalanceResult> {
  const balance = await deps.core.balance(account.id)
  const result: BalanceResult = {
    accountId: balance.accountId,
    tail: tailOf(account.number),
    balanceCents: balance.balanceCents,
    availableCents: balance.availableCents,
    frozenCents: Math.max(0, balance.balanceCents - balance.availableCents),
    asOf: balance.asOf,
    txnRef: `balance:${callId}`,
  }
  deps.audit.append('read/balance', { result })
  return result
}

/** 账单口径。 */
export type BillPeriod = 'month' | 'quarter' | 'year'

/** 账单维度：`category` 账务分类 / `payee` 收款人 / `merchant` 商户品类。 */
export type BillGroupBy = 'category' | 'payee' | 'merchant'

/** 账单分析（`bill_analyze` 与 `bill_report` 共用）。 */
export async function buildBillAnalysis(
  deps: BankToolDeps,
  userId: string,
  account: Account,
  scope: BillScope,
  groupBy: BillGroupBy,
): Promise<BillAnalysisResult> {
  const now = clockOf(deps)()
  const period = scope.period
  const current = resolveBillAnchor(scope, now) ?? monthKey(now)
  const months = billMonths(current, period)

  let totalInCents = 0
  let totalOutCents = 0
  let coveredMonths = 0
  const byCategory = new Map<TxnCategory, number>()
  const anomalies: BillAnalysisResult['anomalies'][number][] = []
  for (const month of months) {
    const report = await deps.core.analyzeBill({
      userId: bankIds.user(userId),
      accountId: account.id,
      period: month,
    })
    totalInCents += report.totalInCents
    totalOutCents += report.totalOutCents
    for (const [category, amount] of Object.entries(report.byCategory) as [TxnCategory, number][]) {
      byCategory.set(category, (byCategory.get(category) ?? 0) + amount)
    }
    // "有流水"= 该账期有收入或支出；只有空账期才不计入覆盖数
    if (report.totalInCents + report.totalOutCents > 0) coveredMonths += 1
    anomalies.push(...report.anomalies)
  }

  const baselineMonths = baselineFor(current, period)
  let previousOut = 0
  for (const month of baselineMonths) {
    const report = await deps.core.analyzeBill({
      userId: bankIds.user(userId),
      accountId: account.id,
      period: month,
    })
    previousOut += report.totalOutCents
  }
  const momChangePct =
    previousOut > 0 ? toPct(totalOutCents - previousOut, previousOut) : undefined

  const comparedPeriod = baselineMonths[0]
  const result: BillAnalysisResult = {
    period,
    months,
    totalInCents,
    totalOutCents,
    byCategory: toCategoryLines(byCategory, totalOutCents),
    anomalies,
    ...(momChangePct === undefined ? {} : { momChangePct }),
    ...(comparedPeriod === undefined ? {} : { comparedPeriod }),
    ...(period === 'year' ? { coveredMonths } : {}),
    ...(groupBy === 'payee'
      ? { byPayee: await collectPayees(deps, userId, account, months, totalOutCents) }
      : {}),
    ...(groupBy === 'merchant'
      ? {
          byMerchantCategory: await collectMerchantCategories(
            deps,
            userId,
            account,
            months,
            totalOutCents,
          ),
        }
      : {}),
  }
  return result
}

/**
 * 把口径锚点解析成具体账期（`YYYY-MM`）。
 *
 * 纯函数、只读入参 `now`：相对口径（上个月 / 只有月份）必须靠**注入钟**换算，
 * 否则回放与测试会随机器真实时间漂移。
 */
function resolveBillAnchor(scope: BillScope, now: number): string | undefined {
  if (scope.month !== undefined) return scope.month
  if (scope.year !== undefined) return `${scope.year}-12`
  const current = monthKey(now)
  if (scope.monthOffset !== undefined) return shiftMonth(current, scope.monthOffset)
  if (scope.monthOfYear !== undefined) {
    const year = Number(current.slice(0, 4))
    const currentMonth = Number(current.slice(5, 7))
    // 「9 月账单」在 11 月问 = 今年 9 月；在 3 月问 = 去年 9 月（绝不指向未来）
    const targetYear = scope.monthOfYear > currentMonth ? year - 1 : year
    return `${String(targetYear)}-${String(scope.monthOfYear).padStart(2, '0')}`
  }
  return undefined
}

/** 口径 → 账期（升序；年度 = 近 12 个自然账期，含本月）。 */
function billMonths(current: string, period: BillPeriod): string[] {
  switch (period) {
    case 'month':
      return [current]
    case 'quarter':
      return [shiftMonth(current, -2), shiftMonth(current, -1), current]
    case 'year':
      return Array.from({ length: 12 }, (_, index) => shiftMonth(current, index - 11))
    default:
      return assertNever(period, 'bill-period')
  }
}

/**
 * 环比基线账期。
 *
 * 年度**不做同比**：需要去年同 12 个月的数据（本设计只有 12 个月），
 * 返回空数组让 `momChangePct` 缺省——宁可少一个指标，不编一个数字。
 */
function baselineFor(current: string, period: BillPeriod): string[] {
  switch (period) {
    case 'month':
      return [previousMonth(current)]
    case 'quarter':
      return [shiftMonth(current, -5), shiftMonth(current, -4), shiftMonth(current, -3)]
    case 'year':
      return []
    default:
      return assertNever(period, 'bill-period')
  }
}

/** 按分类汇总成降序行（同额按分类名升序，输出稳定）。 */
function toCategoryLines(
  byCategory: ReadonlyMap<TxnCategory, number>,
  totalOutCents: number,
): BillCategoryLine[] {
  return [...byCategory.entries()]
    .map(([category, amountCents]) => ({
      category,
      amountCents,
      sharePct: toPct(amountCents, totalOutCents),
    }))
    .sort((left, right) =>
      right.amountCents === left.amountCents
        ? left.category.localeCompare(right.category)
        : right.amountCents - left.amountCents,
    )
}

/**
 * 遍历区间内**成功的支出流水**（分页读全，最多 50 页；避免模型触发无界循环）。
 *
 * 收款人汇总与商户品类汇总共用这一份遍历：复制第二个分页循环迟早会不同步
 * （一处改了过滤条件、另一处没改，两份账单就会对不上）。
 */
async function eachOutTxn(
  deps: BankToolDeps,
  userId: string,
  account: Account,
  months: readonly string[],
  visit: (txn: Transaction) => void,
): Promise<void> {
  const first = months[0]
  const last = months[months.length - 1]
  if (first === undefined || last === undefined) {
    throw new BahError('period-invalid', 'bank-tools: 账单月份为空（内部错误）', { months })
  }
  const range = { start: periodRange(first).start, end: periodRange(last).end }
  let cursor: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const queried = await deps.core.queryTransactions({
      userId: bankIds.user(userId),
      accountId: account.id,
      from: range.start,
      to: range.end,
      limit: PAGE_LIMIT_MAX,
      ...(cursor === undefined ? {} : { cursor }),
    })
    for (const txn of queried.items) {
      if (txn.direction !== 'out' || txn.status !== 'success') continue
      visit(txn)
    }
    cursor = queried.nextCursor
    if (cursor === undefined) break
  }
}

/** 从流水汇总收款人（降序）。 */
async function collectPayees(
  deps: BankToolDeps,
  userId: string,
  account: Account,
  months: readonly string[],
  totalOutCents: number,
): Promise<BillPayeeLine[]> {
  const byPayee = new Map<string, number>()
  await eachOutTxn(deps, userId, account, months, (txn) => {
    byPayee.set(txn.counterparty.name, (byPayee.get(txn.counterparty.name) ?? 0) + txn.amountCents)
  })
  return [...byPayee.entries()]
    .map(([payee, amountCents]) => ({
      payee,
      amountCents,
      sharePct: toPct(amountCents, totalOutCents),
    }))
    .sort((left, right) =>
      right.amountCents === left.amountCents
        ? left.payee.localeCompare(right.payee)
        : right.amountCents - left.amountCents,
    )
}

/**
 * 商户 → 品类：账务分类优先（转账/工资），其余才看名字。
 *
 * 不写这条覆盖规则，"王建国 800 元"会被归进 `other`——用户问"我转给谁最多"
 * 会得到"其他"；这是功能正确性的一部分，不是优化。
 */
function merchantCategoryOfTxn(txn: Transaction): MerchantCategory {
  if (txn.category === 'transfer') return 'transfer'
  if (txn.category === 'salary') return 'salary'
  return merchantCategoryOf(txn.counterparty.name)
}

/** 从流水汇总商户品类（降序；同额按品类名升序，输出稳定）。 */
async function collectMerchantCategories(
  deps: BankToolDeps,
  userId: string,
  account: Account,
  months: readonly string[],
  totalOutCents: number,
): Promise<BillMerchantLine[]> {
  const byCategory = new Map<MerchantCategory, number>()
  await eachOutTxn(deps, userId, account, months, (txn) => {
    const category = merchantCategoryOfTxn(txn)
    byCategory.set(category, (byCategory.get(category) ?? 0) + txn.amountCents)
  })
  return [...byCategory.entries()]
    .map(([category, amountCents]) => ({
      category,
      amountCents,
      sharePct: toPct(amountCents, totalOutCents),
    }))
    .sort((left, right) =>
      right.amountCents === left.amountCents
        ? left.category.localeCompare(right.category)
        : right.amountCents - left.amountCents,
    )
}

/** 模型可见的账单摘要（短文本）。 */
function summarizeBill(result: BillAnalysisResult): string {
  const lines =
    result.byMerchantCategory === undefined
      ? result.byCategory
          .slice(0, 5)
          .map((line) => `${CATEGORY_LABEL[line.category]} ${formatYuan(line.amountCents)}（${line.sharePct}%）`)
      : result.byMerchantCategory
          .slice(0, 5)
          .map(
            (line) => `${MERCHANT_LABEL[line.category]} ${formatYuan(line.amountCents)}（${line.sharePct}%）`,
          )
  return (
    `${result.months.join(' / ')}：收入 ${formatYuan(result.totalInCents)}，支出 ${formatYuan(result.totalOutCents)}` +
    `${result.momChangePct === undefined ? '' : `，环比 ${result.momChangePct}%`}。` +
    `\n分类：${lines.join('；') || '无支出'}。` +
    `\n异常 ${result.anomalies.length} 条。`
  )
}

/** 报告口径文案。 */
const REPORT_PERIOD_LABEL: Readonly<Record<BillPeriod, string>> = {
  month: '月度',
  quarter: '季度',
  year: '年度',
}

/**
 * 报告正文（确定性；`format` 只决定详略，不参与任何计算）。
 *
 * 年度报告必须显式写"覆盖 N/12 个账期"：数据是仿真的，只有 N 个账期有流水时，
 * 不写覆盖声明就会被当成 bug；写了它就是一句可主动交代的话。
 */
function composeReport(analysis: BillAnalysisResult, format: 'summary' | 'detail'): string {
  const coverage =
    analysis.period === 'year' && analysis.coveredMonths !== undefined
      ? `，覆盖 ${String(analysis.coveredMonths)}/12 个账期`
      : ''
  const header =
    `账单报告（${analysis.months.join(' / ')}，${REPORT_PERIOD_LABEL[analysis.period]}${coverage}）\n` +
    `收入 ${formatYuan(analysis.totalInCents)}；支出 ${formatYuan(analysis.totalOutCents)}` +
    (analysis.momChangePct === undefined ? '' : `；环比 ${analysis.momChangePct}%`)
  const categories = reportCategoryLines(analysis)
  if (format === 'summary') {
    return `${header}\n分类汇总：\n${categories}\n异常：${analysis.anomalies.length} 条`
  }
  const anomalies = analysis.anomalies.length
    ? analysis.anomalies.map((item) => `- ${item.note}`).join('\n')
    : '- 无'
  const payees = analysis.byPayee?.length
    ? analysis.byPayee
        .slice(0, 5)
        .map((line) => `- ${line.payee}：${formatYuan(line.amountCents)}（${line.sharePct}%）`)
        .join('\n')
    : '- 无'
  return `${header}\n分类汇总：\n${categories}\n收款人（前 5）：\n${payees}\n异常：\n${anomalies}`
}

/**
 * 报告里的分类行（中文分类文案）。
 *
 * `bill_report` 本轮**没有** `groupBy` 参数：报告固定按账务分类，明细才附收款人。
 * 品类维度的模型可见文案走 `bill_analyze` 的 `summarizeBill`——不为一个未承诺的
 * "品类报告"预留不可达分支。
 *
 * 分类必须走 `CATEGORY_LABEL`：这份正文同时是模型看到的工具结果和工具卡的正文，
 * 写 `transfer` 就等于让客户界面出现英文键、模型照着念给客户。
 */
function reportCategoryLines(analysis: BillAnalysisResult): string {
  const lines = analysis.byCategory.map(
    (line) => `- ${CATEGORY_LABEL[line.category]}：${formatYuan(line.amountCents)}（${line.sharePct}%）`,
  )
  return lines.length > 0 ? lines.join('\n') : '- 无支出'
}

/** 受限执行：超时 / 取消 / seam 抛错都保持结构化理由码。 */
async function runBoundedCompute(
  deps: BankToolDeps,
  ctx: ToolExecContext,
  code: string,
  data: Readonly<Record<string, unknown>> | undefined,
): Promise<AnalysisResult> {
  if (ctx.signal.aborted) {
    throw new BahError('compute-aborted', 'bank-tools: 计算已取消')
  }
  const now = clockOf(deps)
  const started = now()
  const compute = deps.compute ?? defaultCompute
  const timeoutMs = deps.config.computeTimeoutMs

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new BahError('compute-timeout', `bank-tools: 受限计算超过 ${timeoutMs} ms`, { timeoutMs }))
    }, timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })

  const onAbort = (): void => {
    rejectAbort()
  }
  let rejectAbort = (): void => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new BahError('compute-aborted', 'bank-tools: 计算已取消'))
    if (ctx.signal.aborted) rejectAbort()
    else ctx.signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    const computed = await Promise.race([
      compute({
        code,
        ...(data === undefined ? {} : { data }),
        limits: { timeoutMs, maxOperations: 10_000 },
      }),
      timeout,
      aborted,
    ])
    return {
      code,
      value: computed.value,
      operations: computed.operations,
      elapsedMs: now() - started,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onAbort)
  }
}

/** 账户 → 视图。 */
function toAccountView(account: Account): AccountView {
  return {
    accountId: account.id,
    tail: tailOf(account.number),
    type: account.type,
    status: account.status,
    balanceCents: account.balanceCents,
    availableCents: account.availableCents,
  }
}

/** 卡片 → 视图。 */
function toCardView(card: Card): CardView {
  return {
    cardId: card.id,
    accountId: card.accountId,
    tail: card.tail,
    type: card.type,
    status: card.status,
    dailyLimitCents: card.dailyLimitCents,
    monthlyLimitCents: card.monthlyLimitCents,
    // 信用产品三件套（ADR-0015）：借记卡不带，视图形状逐字不变。
    ...(card.kind === 'credit' && card.creditLimitCents !== undefined
      ? {
          kind: card.kind,
          creditLimitCents: card.creditLimitCents,
          usedCreditCents: card.usedCreditCents ?? 0,
        }
      : {}),
    ...(card.restrictions === undefined || card.restrictions.length === 0
      ? {}
      : { restrictions: card.restrictions.map((item) => ({ ...item })) }),
  }
}

/** 交易限制的模型可见文案（account_list 回读用）。 */
function restrictionLabel(restriction: CardRestriction): string {
  if (restriction.kind === 'online') return '线上交易'
  if (restriction.kind === 'overseas') return '境外交易'
  const value = restriction.value
  const label = value !== undefined && isMerchantCategory(value) ? MERCHANT_LABEL[value] : value
  return label === undefined ? '指定品类' : `品类(${label})`
}

/** 交易 → 视图。 */
function toTxnView(txn: Transaction): TxnView {
  return {
    txnId: txn.id,
    at: txn.at,
    amountCents: txn.amountCents,
    direction: txn.direction,
    counterpartyName: txn.counterparty.name,
    category: txn.category,
    channel: txn.channel,
    status: txn.status,
  }
}
