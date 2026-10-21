/**
 * mock 银行核心（施工单 07 §2 / §4）：全部状态在内存，不做任何 I/O。
 *
 * 权威口径只有账本：日累计、剩余额度、账单异常都从 `transactions` 实时推导，
 * Harness 侧的会话状态只是缓存（施工单 07 §8 第 1 条）。
 *
 * 写操作（转账 / 理财购买）必须先过 `TicketStore.redeem()`——**核销属主在 bank-core**；
 * 校验（账户、金额、余额、产品）全部在核销**之前**，核销之后只做不会抛错的账本变更，
 * 避免"票据已消费但业务没记账"的半截状态。
 */

import { BahError } from '@bah/util'

import type { BankDataset } from '../forge/index.ts'
import { checkTransferRisks, isNight } from '../forge/risk.ts'
import type {
  Account,
  AccountId,
  BankLimits,
  BillAnomaly,
  Card,
  Holding,
  Payee,
  Transaction,
  TxnCategory,
  UserId,
  WealthProduct,
} from './model.ts'
import { bankIds, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, toPct } from './model.ts'
import type {
  Balance,
  BankCoreProvider,
  BillQuery,
  BillReport,
  Page,
  PurchaseReq,
  TransferPreview,
  TransferReq,
  TransferResult,
  TxnQuery,
  WealthFilter,
} from './provider.ts'
import { TicketStore, type TicketRef } from './ticket.ts'
import { dayKey, monthKey, periodRange, previousMonth } from './time.ts'

/** mock 核心的装配参数。 */
export interface MockBankCoreOptions {
  /** 造数产物（施工单 07 §4）。 */
  readonly data: BankDataset
  /** 时钟（缺省 = 造数的基准时刻；测试与回放注入固定钟）。 */
  readonly now?: () => number
  /** 风控阈值覆盖（缺省取数据集里的）。 */
  readonly limits?: BankLimits
  /** 票据库（缺省新建；测试可注入以观察状态）。 */
  readonly tickets?: TicketStore
}

/**
 * 内存版银行核心。
 *
 * 实现 `BankCoreProvider`；真实对接时换一个 Provider，工具族与渠道无感。
 */
export class MockBankCore implements BankCoreProvider {
  /** 票据库（状态机唯一属主）。 */
  readonly tickets: TicketStore

  private readonly now: () => number
  private readonly limitsConfig: BankLimits
  private accounts: Account[]
  private cards: Card[]
  private transactions: Transaction[]
  private payees: Payee[]
  private holdings: Holding[]
  private readonly products: WealthProduct[]
  private txnSeq: number
  private payeeSeq: number
  private holdingSeq: number
  /** 幂等键 → 首笔结果（10 分钟窗口；只防"同参数重复提交"，不替代票据）。 */
  private readonly idempotency = new Map<
    string,
    { readonly fingerprint: string; readonly result: TransferResult; readonly expiresAt: number }
  >()
  private static readonly IDEMPOTENCY_TTL_MS = 10 * 60_000

  constructor(options: MockBankCoreOptions) {
    const { data } = options
    this.now = options.now ?? (() => data.now)
    this.limitsConfig = options.limits ?? data.limits
    this.tickets = options.tickets ?? new TicketStore()
    this.accounts = data.accounts.map((item) => ({ ...item }))
    this.cards = [...data.cards]
    this.transactions = data.transactions.map((item) => ({ ...item }))
    this.payees = data.payees.map((item) => ({ ...item }))
    this.holdings = data.holdings.map((item) => ({ ...item }))
    this.products = [...data.wealthProducts]
    this.txnSeq = this.transactions.length
    this.payeeSeq = this.payees.length
    this.holdingSeq = this.holdings.length
  }

  /* ── 读操作 ─────────────────────────────────────────────────────────────── */

  limits(): BankLimits {
    return this.limitsConfig
  }

  async listAccounts(userId: UserId): Promise<Account[]> {
    return this.accounts
      .filter((item) => item.userId === userId)
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  async balance(accountId: AccountId): Promise<Balance> {
    const account = this.requireAccount(accountId)
    return {
      accountId: account.id,
      balanceCents: account.balanceCents,
      availableCents: account.availableCents,
      asOf: this.now(),
    }
  }

  async queryTransactions(query: TxnQuery): Promise<Page<Transaction>> {
    const accountIds = new Set(
      this.accounts.filter((item) => item.userId === query.userId).map((item) => item.id),
    )
    const matched = this.transactions
      .filter((item) => accountIds.has(item.accountId))
      .filter((item) => query.accountId === undefined || item.accountId === query.accountId)
      .filter((item) => query.from === undefined || item.at >= query.from)
      .filter((item) => query.to === undefined || item.at <= query.to)
      .filter((item) => query.category === undefined || item.category === query.category)
      .filter((item) => query.direction === undefined || item.direction === query.direction)
      .sort((left, right) => right.at - left.at || (left.id < right.id ? 1 : -1))

    const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, query.limit ?? PAGE_LIMIT_DEFAULT))
    const offset = parseCursor(query.cursor)
    const items = matched.slice(offset, offset + limit)
    const next = offset + limit < matched.length ? String(offset + limit) : undefined
    return next === undefined ? { items } : { items, nextCursor: next }
  }

  async analyzeBill(query: BillQuery): Promise<BillReport> {
    const period = query.period ?? monthKey(this.now())
    const { start, end } = periodRange(period)
    const accountIds = new Set(
      this.accounts.filter((item) => item.userId === query.userId).map((item) => item.id),
    )
    const matched = this.transactions
      .filter((item) => accountIds.has(item.accountId))
      .filter((item) => query.accountId === undefined || item.accountId === query.accountId)
      .filter((item) => item.status === 'success' && item.at >= start && item.at < end)
      .sort((left, right) => left.at - right.at)

    const byCategory: Partial<Record<TxnCategory, number>> = {}
    const anomalies: BillAnomaly[] = []
    const subscriptionSeen = new Map<string, Transaction['id']>()
    let totalInCents = 0
    let totalOutCents = 0

    for (const item of matched) {
      if (item.direction === 'in') {
        totalInCents += item.amountCents
        continue
      }
      totalOutCents += item.amountCents
      byCategory[item.category] = (byCategory[item.category] ?? 0) + item.amountCents
      this.collectAnomalies(item, anomalies, subscriptionSeen)
    }

    const comparedPeriod = previousMonth(period)
    const previous = this.outflowOf(query, comparedPeriod)
    const momChangePct = previous > 0 ? toPct(totalOutCents - previous, previous) : undefined
    return {
      period,
      totalInCents,
      totalOutCents,
      byCategory,
      anomalies,
      comparedPeriod,
      ...(momChangePct === undefined ? {} : { momChangePct }),
    }
  }

  async listWealthProducts(filter: WealthFilter = {}): Promise<WealthProduct[]> {
    return this.products
      .filter((item) => filter.riskGrade === undefined || item.riskGrade === filter.riskGrade)
      .filter((item) => filter.kind === undefined || item.kind === filter.kind)
      .filter((item) => filter.maxTermDays === undefined || item.termDays <= filter.maxTermDays)
  }

  /* ── 试算 + 风控预检（只读） ────────────────────────────────────────────── */

  async previewTransfer(req: TransferReq): Promise<TransferPreview> {
    const account = this.requireAccount(req.fromAccountId)
    this.assertAmount(req.amountCents)
    const at = this.now()
    const payee = this.findPayee(account.userId, req.payee)
    const dailyLimitCents = this.dailyLimitOf(account.id)
    const dailyUsedCents = this.dailyUsedCents(account.id, at)
    const risks = checkTransferRisks({
      amountCents: req.amountCents,
      availableCents: account.availableCents,
      dailyUsedCents,
      dailyLimitCents,
      payeeBinding: payee?.binding ?? 'new',
      recentOutCount: this.recentOutCount(account.id, at),
      duplicateRecent: this.hasRecentDuplicate(account.id, req.payee.name, req.amountCents, at),
      at,
      limits: this.limitsConfig,
    })
    return {
      amountCents: req.amountCents,
      feeCents: 0,
      payee: payeeView(req.payee, payee),
      dailyUsedCents,
      dailyLimitCents,
      remainingCents: Math.max(0, dailyLimitCents - dailyUsedCents),
      risks,
      verdict: risks.some((risk) => risk.severity === 'block')
        ? 'block'
        : risks.length > 0
          ? 'warn'
          : 'allow',
    }
  }

  /* ── 写操作（票据门禁） ─────────────────────────────────────────────────── */

  async createTransfer(req: TransferReq, ticket: TicketRef): Promise<TransferResult> {
    const account = this.requireAccount(req.fromAccountId)
    this.assertAmount(req.amountCents)
    if (account.status !== 'active') {
      throw new BahError('account-inactive', `bank: 账户状态 ${account.status}，不能转账`, {
        accountId: account.id,
        status: account.status,
      })
    }
    if (req.payee.name.trim().length === 0) {
      throw new BahError('payee-invalid', 'bank: 收款人姓名不能为空', { accountId: account.id })
    }
    const feeCents = 0
    if (account.availableCents < req.amountCents + feeCents) {
      throw new BahError(
        'insufficient-balance',
        `bank: 余额不足（可用 ${account.availableCents} 分，需要 ${req.amountCents + feeCents} 分）`,
        { accountId: account.id, availableCents: account.availableCents, neededCents: req.amountCents },
      )
    }

    const at = this.now()
    const rawKey = req.idempotencyKey?.trim()
    // 幂等表是 core 实例级的（一进程一 core，见 host/boot/plugins/bank-tools.ts），
    // 而键由客户端提供。不加 actor 前缀时，A 与 B 用同一个键会互相命中：
    // B 拿到 A 的 txnId 且自己的账户一分没扣——两个用户都以为转账成功。
    // 前缀带 account.id 而不只是 userId：同一用户的两个账户各转一笔是两笔独立交易。
    const idemKey =
      rawKey === undefined || rawKey.length === 0
        ? undefined
        : `${account.userId}:${account.id}:${rawKey}`
    const fingerprint = `${req.payee.name}|${req.payee.phone ?? ''}|${req.amountCents}`
    if (idemKey !== undefined) {
      const cached = this.idempotency.get(idemKey)
      if (cached !== undefined && cached.expiresAt > at) {
        if (cached.fingerprint !== fingerprint) {
          throw new BahError('idempotency-conflict', 'bank: 幂等键已用于不同的转账参数', {
            idempotencyKey: idemKey,
          })
        }
        // 重试的票据仍要核销（否则账本出现 approved 悬挂），但不再扣款
        this.tickets.redeem(ticket, at)
        return { ...cached.result, ticketId: ticket.ticketId }
      }
      if (cached !== undefined) this.idempotency.delete(idemKey)
    }
    // 核销（可能抛）：必须在任何账本变更之前
    this.tickets.redeem(ticket, at)

    const payee = this.ensurePayee(account.userId, req.payee, at)
    const transaction: Transaction = {
      id: this.nextTxnId(),
      accountId: account.id,
      at,
      amountCents: req.amountCents,
      direction: 'out',
      counterparty: {
        name: payee.name,
        ...(payee.phone === undefined ? {} : { phone: payee.phone }),
        ...(req.payee.memo === undefined ? {} : { memo: req.payee.memo }),
      },
      category: 'transfer',
      channel: req.channel,
      status: 'success',
    }
    this.transactions = [...this.transactions, transaction]
    this.replaceAccount(account.id, {
      balanceCents: account.balanceCents - req.amountCents - feeCents,
      availableCents: account.availableCents - req.amountCents - feeCents,
    })

    const dailyUsedCents = this.dailyUsedCents(account.id, at)
    const dailyLimitCents = this.dailyLimitOf(account.id)
    const result: TransferResult = {
      txnId: transaction.id,
      ticketId: ticket.ticketId,
      amountCents: req.amountCents,
      feeCents,
      balanceCents: account.balanceCents - req.amountCents - feeCents,
      availableCents: account.availableCents - req.amountCents - feeCents,
      dailyUsedCents,
      dailyLimitCents,
      remainingCents: Math.max(0, dailyLimitCents - dailyUsedCents),
      at,
    }
    if (idemKey !== undefined) {
      this.idempotency.set(idemKey, {
        fingerprint,
        result,
        expiresAt: at + MockBankCore.IDEMPOTENCY_TTL_MS,
      })
      this.pruneIdempotency(at)
    }
    return result
  }

  private pruneIdempotency(now: number): void {
    if (this.idempotency.size < 1024) return
    for (const [key, entry] of this.idempotency) {
      if (entry.expiresAt <= now) this.idempotency.delete(key)
    }
  }

  async purchaseWealth(req: PurchaseReq, ticket: TicketRef): Promise<Holding> {
    const account = this.requireAccount(req.accountId)
    if (account.userId !== req.userId) {
      throw new BahError('account-forbidden', 'bank: 账户不属于该用户', {
        accountId: req.accountId,
        userId: req.userId,
      })
    }
    // 与 createTransfer 同一校验顺序：账户状态在金额 / 产品之前，且必须在核销前
    if (account.status !== 'active') {
      throw new BahError('account-inactive', `bank: 账户状态 ${account.status}，不能购买理财`, {
        accountId: account.id,
        status: account.status,
      })
    }
    this.assertAmount(req.amountCents)
    const product = this.products.find((item) => item.id === req.productId)
    if (product === undefined) {
      throw new BahError('product-unknown', `bank: 未知理财产品：${req.productId}`, {
        productId: req.productId,
      })
    }
    if (req.amountCents < product.minAmountCents) {
      throw new BahError(
        'below-minimum',
        `bank: 低于起投额（${product.minAmountCents} 分）：${req.amountCents} 分`,
        { productId: product.id, minAmountCents: product.minAmountCents },
      )
    }
    if (account.availableCents < req.amountCents) {
      throw new BahError('insufficient-balance', 'bank: 余额不足', {
        accountId: account.id,
        availableCents: account.availableCents,
        neededCents: req.amountCents,
      })
    }

    const at = this.now()
    this.tickets.redeem(ticket, at)

    this.replaceAccount(account.id, {
      balanceCents: account.balanceCents - req.amountCents,
      availableCents: account.availableCents - req.amountCents,
    })
    const holding: Holding = {
      id: bankIds.holding(`h-new-${this.holdingSeq + 1}`),
      userId: req.userId,
      productId: product.id,
      // 演示口径：1 元/份（分 → 份）
      shares: req.amountCents / 100,
      costCents: req.amountCents,
      marketValueCents: req.amountCents,
      profitCents: 0,
    }
    this.holdingSeq += 1
    this.holdings = [...this.holdings, holding]
    return holding
  }

  /* ── 内部推导 ───────────────────────────────────────────────────────────── */

  private collectAnomalies(
    item: Transaction,
    anomalies: BillAnomaly[],
    subscriptionSeen: Map<string, Transaction['id']>,
  ): void {
    if (item.amountCents >= this.limitsConfig.billLargeCents) {
      anomalies.push({ kind: 'large', txnId: item.id, note: `大额支出 ${item.amountCents} 分` })
    }
    if (isNight(item.at, this.limitsConfig) && item.amountCents >= this.limitsConfig.nightLargeCents) {
      anomalies.push({ kind: 'late-night', txnId: item.id, note: '夜间大额支出' })
    }
    if (item.category !== 'subscription') return
    const key = `${item.counterparty.name}|${item.amountCents}|${dayKey(item.at)}`
    const first = subscriptionSeen.get(key)
    if (first === undefined) {
      subscriptionSeen.set(key, item.id)
      return
    }
    anomalies.push({ kind: 'duplicate', txnId: item.id, note: `与 ${first} 同额同日扣费` })
  }

  /** 某账期的转出总额（环比基线）。 */
  private outflowOf(query: BillQuery, period: string): number {
    const { start, end } = periodRange(period)
    const accountIds = new Set(
      this.accounts.filter((item) => item.userId === query.userId).map((item) => item.id),
    )
    return this.transactions
      .filter((item) => accountIds.has(item.accountId))
      .filter((item) => query.accountId === undefined || item.accountId === query.accountId)
      .filter((item) => item.status === 'success' && item.direction === 'out')
      .filter((item) => item.at >= start && item.at < end)
      .reduce((sum, item) => sum + item.amountCents, 0)
  }

  /** 当日已累计转出（权威口径：账本里同账户、同 UTC 日、成功的 transfer）。 */
  private dailyUsedCents(accountId: AccountId, at: number): number {
    const today = dayKey(at)
    return this.transactions
      .filter((item) => item.accountId === accountId)
      .filter((item) => item.direction === 'out' && item.category === 'transfer' && item.status === 'success')
      .filter((item) => dayKey(item.at) === today)
      .reduce((sum, item) => sum + item.amountCents, 0)
  }

  /** 短时窗口内已成功的转出笔数（不含本笔）。 */
  private recentOutCount(accountId: AccountId, at: number): number {
    const from = at - this.limitsConfig.velocityWindowMs
    return this.transactions
      .filter((item) => item.accountId === accountId)
      .filter((item) => item.direction === 'out' && item.status === 'success')
      .filter((item) => item.at > from && item.at <= at)
      .length
  }

  /** 2 分钟内同账户、同收款人、同金额的成功转出（疑似重复提交）。 */
  private hasRecentDuplicate(
    accountId: AccountId,
    payeeName: string,
    amountCents: number,
    at: number,
  ): boolean {
    const name = payeeName.trim()
    if (name.length === 0) return false
    const from = at - 120_000
    return this.transactions.some(
      (item) =>
        item.accountId === accountId &&
        item.direction === 'out' &&
        item.status === 'success' &&
        item.amountCents === amountCents &&
        item.counterparty.name === name &&
        item.at > from &&
        item.at <= at,
    )
  }

  /** 账户的日限额：第一张正常卡片的日限额，否则用全局兜底阈值。 */
  private dailyLimitOf(accountId: AccountId): number {
    const card = this.cards.find((item) => item.accountId === accountId && item.status === 'normal')
    return card?.dailyLimitCents ?? this.limitsConfig.dailyTransferLimitCents
  }

  private requireAccount(accountId: AccountId): Account {
    const account = this.accounts.find((item) => item.id === accountId)
    if (account === undefined) {
      throw new BahError('account-unknown', `bank: 未知账户：${accountId}`, { accountId })
    }
    return account
  }

  private replaceAccount(accountId: AccountId, patch: Pick<Account, 'balanceCents' | 'availableCents'>): void {
    this.accounts = this.accounts.map((item) => (item.id === accountId ? { ...item, ...patch } : item))
  }

  private findPayee(userId: UserId, target: TransferReq['payee']): Payee | undefined {
    if (target.payeeId !== undefined) {
      return this.payees.find((item) => item.id === target.payeeId && item.userId === userId)
    }
    return this.payees.find(
      (item) =>
        item.userId === userId &&
        item.name === target.name &&
        (target.phone === undefined || item.phone === target.phone),
    )
  }

  /** 转账成功后把收款人落到 Payee 表（新收款人 → `binding = 'new'`）。 */
  private ensurePayee(userId: UserId, target: TransferReq['payee'], at: number): Payee {
    const existing = this.findPayee(userId, target)
    if (existing !== undefined) return existing
    this.payeeSeq += 1
    const payee: Payee = {
      id: bankIds.payee(`p-new-${this.payeeSeq}`),
      userId,
      name: target.name,
      ...(target.phone === undefined ? {} : { phone: target.phone }),
      binding: 'new',
      firstSeenAt: at,
    }
    this.payees = [...this.payees, payee]
    return payee
  }

  private nextTxnId(): Transaction['id'] {
    this.txnSeq += 1
    return bankIds.txn(`t-new-${this.txnSeq}`)
  }

  private assertAmount(amountCents: number): void {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new BahError('amount-invalid', `bank: 金额必须是正整数分（收到 ${String(amountCents)}）`, {
        amountCents,
      })
    }
  }
}

/** 预检里的收款人视图（未登记过 → `binding = 'new'`）。 */
function payeeView(target: TransferReq['payee'], payee: Payee | undefined): TransferPreview['payee'] {
  if (payee !== undefined) {
    return {
      payeeId: payee.id,
      name: payee.name,
      ...(payee.phone === undefined ? {} : { phone: payee.phone }),
      binding: payee.binding,
    }
  }
  return {
    ...(target.payeeId === undefined ? {} : { payeeId: target.payeeId }),
    name: target.name,
    ...(target.phone === undefined ? {} : { phone: target.phone }),
    binding: 'new',
  }
}

/** 游标解析：mock 用偏移量（不透明字符串）；非法即 fail-loud。 */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const value = Number(cursor)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BahError('cursor-invalid', `bank: 非法游标 ${cursor}`, { cursor })
  }
  return value
}
