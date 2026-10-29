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

import type { CardLostResult, CardStateChange, SubscriptionCancelled } from './provider.ts'
import type { ReversalResult } from './compensation.ts'

import type { BankDataset } from '../forge/index.ts'
import { checkTransferRisks, isNight } from '../forge/risk.ts'
import type {
  Account,
  AccountId,
  BankLimits,
  BillAnomaly,
  Card,
  CardId,
  Holding,
  Payee,
  Subscription,
  SubscriptionId,
  Transaction,
  TxnCategory,
  User,
  UserId,
  WealthProduct,
} from './model.ts'
import { accountDisplayName, bankIds, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, toPct } from './model.ts'
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
  /** 主体（只读；`getUser` 返回副本，账本不被外部改动）。 */
  private readonly users: ReadonlyMap<UserId, User>
  private accounts: Account[]
  private cards: Card[]
  private subscriptions: Subscription[]
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
  /** 原交易 `txnId` → 冲正结果（幂等：同 txnId 只生效一次）。 */
  private readonly reversals = new Map<string, ReversalResult>()
  private static readonly IDEMPOTENCY_TTL_MS = 10 * 60_000

  constructor(options: MockBankCoreOptions) {
    const { data } = options
    this.now = options.now ?? (() => data.now)
    this.limitsConfig = options.limits ?? data.limits
    this.tickets = options.tickets ?? new TicketStore()
    this.users = new Map(data.users.map((user) => [user.id, user]))
    this.accounts = data.accounts.map((item) => ({ ...item }))
    this.cards = [...data.cards]
    this.subscriptions = [...data.subscriptions]
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

  /**
   * 读用户（只读；不存在返回 `undefined`，不抛）。
   *
   * 返回**副本**：调用方（实体槽位适配器）改字段不能污染账本主体。
   */
  async getUser(userId: UserId): Promise<User | undefined> {
    const user = this.users.get(userId)
    return user === undefined ? undefined : { ...user }
  }

  /**
   * 列出用户名下全部卡片（只读）。
   *
   * 不认识的用户返回 `[]`（不抛错——"没有卡"是业务结果，同 `getUser` 的判定口径）；
   * 必须 `map` 复制（`this.cards` 是可变数组，调用方改字段不能污染账本）；
   * 顺序按账本原序（种子顺序 = 实体卡在前），不额外排序，保证跨端一致。
   */
  async listCards(userId: UserId): Promise<Card[]> {
    const accountIds = new Set(
      this.accounts.filter((item) => item.userId === userId).map((item) => item.id),
    )
    return this.cards
      .filter((item) => accountIds.has(item.accountId))
      .map((item) => ({ ...item }))
  }

  async reportCardLost(userId: UserId, cardId: CardId): Promise<CardLostResult> {
    const card = this.cards.find((item) => item.id === cardId)
    if (card === undefined) {
      throw new BahError('card-unknown', `bank: 未知银行卡：${cardId}`, { cardId })
    }
    const account = this.requireAccount(card.accountId)
    if (account.userId !== userId) {
      throw new BahError('card-not-owned', 'bank: 该卡不属于当前用户', { cardId })
    }
    if (card.status !== 'lost') {
      this.cards = this.cards.map((item) =>
        item.id === cardId ? { ...item, status: 'lost' as const } : item,
      )
    }
    return { cardId, tail: card.tail, status: 'lost' }
  }

  async freezeCard(userId: UserId, cardId: CardId): Promise<CardStateChange> {
    const card = this.cardOfUser(userId, cardId)
    if (card.status === 'lost') {
      throw new BahError('card-lost', 'bank: 该卡已挂失，只能补发新卡，不能冻结', { cardId })
    }
    if (card.status === 'frozen') return { cardId, tail: card.tail, status: 'frozen', changed: false }
    this.cards = this.cards.map((item) =>
      item.id === cardId ? { ...item, status: 'frozen' as const } : item,
    )
    return { cardId, tail: card.tail, status: 'frozen', changed: true }
  }

  async unfreezeCard(userId: UserId, cardId: CardId): Promise<CardStateChange> {
    const card = this.cardOfUser(userId, cardId)
    if (card.status === 'lost') {
      throw new BahError('card-lost', 'bank: 该卡已挂失，解挂请走补发流程，不能解冻', { cardId })
    }
    if (card.status === 'normal') return { cardId, tail: card.tail, status: 'normal', changed: false }
    this.cards = this.cards.map((item) =>
      item.id === cardId ? { ...item, status: 'normal' as const } : item,
    )
    return { cardId, tail: card.tail, status: 'normal', changed: true }
  }

  async cancelSubscription(
    userId: UserId,
    subscriptionId: SubscriptionId,
  ): Promise<SubscriptionCancelled> {
    const found = this.subscriptions.find((item) => item.id === subscriptionId)
    if (found === undefined) {
      throw new BahError('subscription-unknown', `bank: 未知订阅：${subscriptionId}`, {
        subscriptionId,
      })
    }
    if (found.userId !== userId) {
      throw new BahError('subscription-not-owned', 'bank: 该订阅不属于当前用户', { subscriptionId })
    }
    this.subscriptions = this.subscriptions.map((item) =>
      item.id === subscriptionId ? { ...item, status: 'cancelled' as const } : item,
    )
    return { subscriptionId, merchant: found.merchant }
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
    // 本人账户命中优先于收款人表：否则「锁定账户(9012)」会被当成新收款人升红
    const selfTarget = this.resolveSelfTransfer(account, req.payee)
    const payee = selfTarget === undefined ? this.findPayee(account.userId, req.payee) : undefined
    const viaCard =
      req.viaCardId === undefined ? undefined : this.requireCardOf(account.id, req.viaCardId)
    const dailyLimitCents = this.dailyLimitOf(account.id, req.viaCardId)
    const dailyUsedCents = this.dailyUsedCents(account.id, at)
    const risks = checkTransferRisks({
      amountCents: req.amountCents,
      availableCents: account.availableCents,
      dailyUsedCents,
      dailyLimitCents,
      payeeBinding: selfTarget !== undefined ? 'whitelist' : (payee?.binding ?? 'new'),
      recentOutCount: this.recentOutCount(account.id, at),
      duplicateRecent: this.hasRecentDuplicate(account.id, req.payee.name, req.amountCents, at),
      at,
      limits: this.limitsConfig,
      ...(viaCard === undefined ? {} : { cardStatus: viaCard.status, cardTail: viaCard.tail }),
    })
    return {
      amountCents: req.amountCents,
      feeCents: 0,
      payee:
        selfTarget === undefined
          ? payeeView(req.payee, payee)
          : { name: accountDisplayName(selfTarget), binding: 'whitelist' },
      dailyUsedCents,
      dailyLimitCents,
      remainingCents: Math.max(0, dailyLimitCents - dailyUsedCents),
      risks,
      verdict: risks.some((risk) => risk.severity === 'block')
        ? 'block'
        : risks.length > 0
          ? 'warn'
          : 'allow',
      ...(viaCard === undefined ? {} : { viaCard: { tail: viaCard.tail, status: viaCard.status } }),
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
    // 卡状态是第二条守卫：预检里的 block 可能被绕过（工具可被直接调用），
    // 核销之前必须再判一次，否则"冻结了却还能刷"就是结构性成立的。
    if (req.viaCardId !== undefined) {
      const card = this.requireCardOf(account.id, req.viaCardId)
      if (card.status !== 'normal') {
        throw new BahError(
          'card-unavailable',
          card.status === 'lost' ? 'bank: 该卡已挂失，不能用于支付' : 'bank: 该卡已冻结，请先解冻',
          { cardId: card.id, status: card.status },
        )
      }
    }
    if (req.payee.name.trim().length === 0) {
      throw new BahError('payee-invalid', 'bank: 收款人姓名不能为空', { accountId: account.id })
    }
    // 校验都在核销之前（与外部转账同一条纪律）：内部划转的方向/目标状态非法时，
    // 票据连核销都不该发生。方向错误先于余额错误报——"锁定账户不能转出"
    // 比"余额不足"更接近用户要问的问题。
    const selfTarget = this.resolveSelfTransfer(account, req.payee)
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

    if (selfTarget !== undefined) {
      const result = this.settleSelfTransfer(account, selfTarget, req, ticket, at)
      if (idemKey !== undefined) {
        this.idempotency.set(idemKey, { fingerprint, result, expiresAt: at + MockBankCore.IDEMPOTENCY_TTL_MS })
        this.pruneIdempotency(at)
      }
      return result
    }

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
    const dailyLimitCents = this.dailyLimitOf(account.id, req.viaCardId)
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

  /**
   * 冲正一笔转账（W12 补偿回读）。
   *
   * 三条硬约束：
   * 1. **两条流水**：原交易保留，新增一条 `in / refund / reversalOf` 的冲正流水——对账要看得出
   *    "发生过、又退回来了"，不能删原记录；
   * 2. **幂等键 = 原 `txnId`**：重复调用返回首次结果，不落第二条冲正、不重复回补余额；
   * 3. **只冲成功的转出转账**：其他形态（已退款 / 入账 / 理财）一律 fail-loud，宁可人工处理。
   *
   * 注意：这是 Mock 的账本冲正语义，不是银行核心的真实撤销接口；生产需接核心的冲正/退款能力。
   *
   * @throws `BahError('txn-unknown')` / `BahError('txn-not-reversible')`
   */
  async reverse(txnId: string): Promise<ReversalResult> {
    const existing = this.reversals.get(txnId)
    if (existing !== undefined) return existing

    const original = this.transactions.find((item) => item.id === txnId)
    if (original === undefined) {
      throw new BahError('txn-unknown', `bank: 未知交易：${txnId}`, { txnId })
    }
    if (
      original.direction !== 'out' ||
      original.category !== 'transfer' ||
      original.status !== 'success'
    ) {
      throw new BahError('txn-not-reversible', `bank: 交易不可冲正：${txnId}`, {
        txnId,
        direction: original.direction,
        category: original.category,
        status: original.status,
      })
    }

    const account = this.requireAccount(original.accountId)
    const at = this.now()
    const reversal: Transaction = {
      id: this.nextTxnId(),
      accountId: original.accountId,
      at,
      amountCents: original.amountCents,
      direction: 'in',
      counterparty: original.counterparty,
      category: 'refund',
      channel: original.channel,
      status: 'success',
      reversalOf: original.id,
    }
    this.transactions = [...this.transactions, reversal]
    const balanceCents = account.balanceCents + original.amountCents
    const availableCents = account.availableCents + original.amountCents
    this.replaceAccount(account.id, { balanceCents, availableCents })

    const dailyUsedCents = this.dailyUsedCents(account.id, at)
    const dailyLimitCents = this.dailyLimitOf(account.id)
    const result: ReversalResult = {
      txnId: original.id,
      reversalTxnId: reversal.id,
      amountCents: original.amountCents,
      balanceCents,
      availableCents,
      dailyUsedCents,
      dailyLimitCents,
      at,
    }
    this.reversals.set(original.id, result)
    return result
  }

  /** 查询冲正结果（探诊用；未冲正返回 `undefined`）。 */
  reversalOf(txnId: string): ReversalResult | undefined {
    return this.reversals.get(txnId)
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

  /**
   * 当日已累计转出（权威口径：账本里同账户、同 UTC 日、成功的 transfer **减去当日冲正**）。
   *
   * W12 裁决：额度回退（冲正 = 该笔业务未发生），但两条流水都在——对账要看得见
   * "发生过、又退回来了"。只减带 `reversalOf` 的 refund 流水，不误伤造数里的普通退款。
   */
  private dailyUsedCents(accountId: AccountId, at: number): number {
    const today = dayKey(at)
    let outCents = 0
    let reversedCents = 0
    for (const item of this.transactions) {
      if (item.accountId !== accountId || item.status !== 'success') continue
      if (dayKey(item.at) !== today) continue
      if (item.direction === 'out' && item.category === 'transfer') outCents += item.amountCents
      if (item.direction === 'in' && item.category === 'refund' && item.reversalOf !== undefined) {
        reversedCents += item.amountCents
      }
    }
    return Math.max(0, outCents - reversedCents)
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

  /**
   * 账户的日限额：取**卡片限额与全局阈值中更紧的那个**。
   *
   * 为什么不是"有卡就用卡的"：卡限额是产品维度（这张卡能转多少），
   * 全局阈值是风控维度（这家机构今天允许转多少）。两个都成立时，有效限额是交集。
   *
   * 曾经只取卡片值，导致一个真实的口径分裂：运营把 `bank:tools.dailyTransferLimit`
   * 从 5000 降到 1000 之后，判决层按 1000 升红，而预览层仍显示"今日还可转 5000"——
   * 客户看到的是 5000，转 1200 就被要求强验证。展示口径必须与判决口径同源。
   */
  private dailyLimitOf(accountId: AccountId, cardId?: CardId): number {
    const card =
      cardId === undefined
        ? this.cards.find((item) => item.accountId === accountId && item.status === 'normal')
        : this.cards.find((item) => item.id === cardId)
    const configured = this.limitsConfig.dailyTransferLimitCents
    return card === undefined ? configured : Math.min(card.dailyLimitCents, configured)
  }

  /**
   * 按账户 + 卡 ID 取卡（转账支付工具路径）。
   *
   * @throws `card-unknown` 卡不存在
   * @throws `card-not-owned` 卡不属于该账户（跨账户用卡是越权，不是参数错）
   */
  private requireCardOf(accountId: AccountId, cardId: CardId): Card {
    const card = this.cards.find((item) => item.id === cardId)
    if (card === undefined) {
      throw new BahError('card-unknown', `bank: 未知银行卡：${cardId}`, { cardId })
    }
    if (card.accountId !== accountId) {
      throw new BahError('card-not-owned', 'bank: 该卡不属于本账户', { cardId, accountId })
    }
    return card
  }

  /** 归属校验（与 `reportCardLost` 同一口径）。 */
  private cardOfUser(userId: UserId, cardId: CardId): Card {
    const card = this.cards.find((item) => item.id === cardId)
    if (card === undefined) {
      throw new BahError('card-unknown', `bank: 未知银行卡：${cardId}`, { cardId })
    }
    const account = this.requireAccount(card.accountId)
    if (account.userId !== userId) {
      throw new BahError('card-not-owned', 'bank: 该卡不属于当前用户', { cardId })
    }
    return card
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

  /**
   * 命中"本人账户"（内部划转）：`payee.name` 精确等于该用户某个本人账户的展示名。
   *
   * 只在收款人表未命中时才考虑（`payeeId` 显式给了就按收款人表走，不做内部转账）。
   * 命中后立即做方向/状态校验——非法组合在**核销之前**失败。
   *
   * @throws `BahError('payee-ambiguous')` 展示名命中多个本人账户
   * @throws `BahError('transfer-locked-source')` 锁定账户作转出方
   * @throws `BahError('transfer-internal-unsupported')` 非活期账户作转出方（v1 只支持 current → locked/fixed）
   * @throws `BahError('account-inactive')` 目标账户非 active
   */
  private resolveSelfTransfer(source: Account, target: TransferReq['payee']): Account | undefined {
    if (target.payeeId !== undefined) return undefined
    const name = target.name.trim()
    if (name.length === 0) return undefined
    const matches = this.accounts.filter(
      (item) => item.userId === source.userId && accountDisplayName(item) === name,
    )
    if (matches.length > 1) {
      throw new BahError('payee-ambiguous', `bank: 收款人「${name}」命中多个本人账户，无法确定目标`, {
        name,
        accountIds: matches.map((item) => item.id),
      })
    }
    const self = matches[0]
    if (self === undefined) return undefined
    if (source.type === 'locked') {
      throw new BahError('transfer-locked-source', 'bank: 锁定账户只进不出，不能作为转出账户', {
        accountId: source.id,
      })
    }
    if (self.id === source.id) {
      throw new BahError('payee-invalid', 'bank: 不能向同一个账户内部划转', { accountId: source.id })
    }
    if (source.type !== 'current' || self.type === 'current') {
      // v1 口径：只允许活期 → 锁定/定期（单向 earmark）。其余组合没有仿真语义，
      // 宁可 fail-loud 也不要做出一个"看起来转了"的假动作。
      throw new BahError(
        'transfer-internal-unsupported',
        `bank: 内部划转 v1 只支持活期 → 锁定/定期（本次 ${source.type} → ${self.type}）`,
        { from: source.type, to: self.type },
      )
    }
    if (self.status !== 'active') {
      throw new BahError('account-inactive', `bank: 目标账户状态 ${self.status}，不能转入`, {
        accountId: self.id,
        status: self.status,
      })
    }
    return self
  }

  /**
   * 内部划转的账本落定（票据已核销之后调用，只做不会抛错的变更）。
   *
   * 两条流水：源账户 `out`（counterparty=目标账户展示名）+ 目标账户 `in`
   * （counterparty=源账户展示名）——对账必须看得出钱去哪了。
   * 日累计只统计**源账户的 out**，目标账户的 `in` 不计入限额。
   */
  private settleSelfTransfer(
    source: Account,
    target: Account,
    req: TransferReq,
    ticket: TicketRef,
    at: number,
  ): TransferResult {
    const outTxn: Transaction = {
      id: this.nextTxnId(),
      accountId: source.id,
      at,
      amountCents: req.amountCents,
      direction: 'out',
      counterparty: {
        name: accountDisplayName(target),
        ...(req.payee.memo === undefined ? {} : { memo: req.payee.memo }),
      },
      category: 'transfer',
      channel: req.channel,
      status: 'success',
    }
    const inTxn: Transaction = {
      id: this.nextTxnId(),
      accountId: target.id,
      at,
      amountCents: req.amountCents,
      direction: 'in',
      counterparty: { name: accountDisplayName(source) },
      category: 'transfer',
      channel: req.channel,
      status: 'success',
    }
    this.transactions = [...this.transactions, outTxn, inTxn]
    this.replaceAccount(source.id, {
      balanceCents: source.balanceCents - req.amountCents,
      availableCents: source.availableCents - req.amountCents,
    })
    this.replaceAccount(target.id, {
      balanceCents: target.balanceCents + req.amountCents,
      availableCents: target.availableCents + req.amountCents,
    })

    const dailyUsedCents = this.dailyUsedCents(source.id, at)
    const dailyLimitCents = this.dailyLimitOf(source.id)
    return {
      txnId: outTxn.id,
      ticketId: ticket.ticketId,
      amountCents: req.amountCents,
      feeCents: 0,
      balanceCents: source.balanceCents - req.amountCents,
      availableCents: source.availableCents - req.amountCents,
      dailyUsedCents,
      dailyLimitCents,
      remainingCents: Math.max(0, dailyLimitCents - dailyUsedCents),
      at,
    }
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
