/**
 * mock 银行核心：全部状态在内存，不做任何 I/O。
 *
 * 权威口径只有账本：日累计、剩余额度、账单异常都从 `transactions` 实时推导，
 * Harness 侧的会话状态只是缓存。
 *
 * 写操作（转账 / 理财购买）必须先过 `TicketStore.redeem()`——**核销属主在 bank-core**；
 * 校验（账户、金额、余额、产品）全部在核销**之前**，核销之后只做不会抛错的账本变更，
 * 避免"票据已消费但业务没记账"的半截状态。
 */

import { BahError } from '@bah/util'

import type {
  AuthorizationRevoked,
  CardLostResult,
  CardStateChange,
  SubscriptionCancelled,
  SubscriptionWatch,
} from './provider.ts'
import type { ReversalResult } from './compensation.ts'

import type { BankDataset } from '../forge/index.ts'
import { checkTransferRisks, isNight } from '../forge/risk.ts'
import { normalizeMerchant } from '../detect/merchant.ts'
import type {
  AaGroup,
  AaGroupId,
  AaGroupStatus,
  Account,
  AccountId,
  AuthorizationId,
  BankLimits,
  BillAnomaly,
  CancelRequest,
  Card,
  CardId,
  CardKind,
  CardRestriction,
  CardType,
  Holding,
  HoldingId,
  MerchantAuthorization,
  Payee,
  ProductId,
  RiskGrade,
  Subscription,
  SubscriptionId,
  Transaction,
  TxnCategory,
  User,
  UserId,
  WealthProduct,
} from './model.ts'
import {
  AA_DEFAULT_EXPIRY_HOURS,
  AA_MAX_EXPIRY_HOURS,
  accountDisplayName,
  bankIds,
  formatYuan,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  toPct,
} from './model.ts'
import { isMerchantCategory, MERCHANT_LABEL } from './merchant.ts'
import type {
  AaCloseReq,
  AaCollectReq,
  AaCollectResult,
  AaCreateReq,
  AaParticipantActionReq,
  AaSettlementResult,
  Balance,
  BankCoreProvider,
  BillQuery,
  BillReport,
  CardApplyReq,
  CardIssued,
  CardLimitPatch,
  CardLimitsChanged,
  CardRestrictionChange,
  CardRestrictionInput,
  CardSpendReq,
  CardSpendResult,
  Page,
  PasswordChanged,
  PasswordHandoff,
  PasswordStatus,
  PurchaseReq,
  RedeemReq,
  RedeemResult,
  RiskAssessment,
  RiskFinding,
  TransferPreview,
  TransferReq,
  TransferResult,
  TxnQuery,
  UpcomingCharge,
  WealthFilter,
} from './provider.ts'
import { checkSuitability } from './suitability.ts'
import {
  assertNewTxnPassword,
  DEMO_TXN_PASSWORD,
  deriveTxnPasswordSalt,
  hashTxnPassword,
  PASSWORD_HANDOFF_PATH,
  remainingPasswordAttempts,
  TXN_PASSWORD_LOCK_MS,
  TXN_PASSWORD_MAX_ATTEMPTS,
} from './password.ts'
import type { RiskQuestionnaire } from './risk-questionnaire.ts'
import { RiskQuestionnaireBook } from './risk-questionnaire.ts'
import { TicketStore, type TicketRef } from './ticket.ts'
import { DAY_MS, dayKey, monthKey, periodRange, previousMonth } from './time.ts'

/** mock 核心的装配参数。 */
export interface MockBankCoreOptions {
  /** 造数产物。 */
  readonly data: BankDataset
  /** 时钟（缺省 = 造数的基准时刻；测试与回放注入固定钟）。 */
  readonly now?: () => number
  /** 风控阈值覆盖（缺省取数据集里的）。 */
  readonly limits?: BankLimits
  /** 票据库（缺省新建；测试可注入以观察状态）。 */
  readonly tickets?: TicketStore
  /**
   * 风险测评重测冷却（毫秒）。缺省 0 = 不启用。
   *
   * 部署面的保守缺省在 `bank:tools.riskCooldownDays`（1 天），由 host 插件传入；
   * 核心库自己不设隐式冷却，避免所有直接构造的测试被一天的冷却互相挡住。
   */
  readonly riskCooldownMs?: number
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
  private readonly users: Map<UserId, User>
  private accounts: Account[]
  private cards: Card[]
  private subscriptions: Subscription[]
  private authorizations: MerchantAuthorization[]
  private cancelRequests: CancelRequest[]
  private transactions: Transaction[]
  private payees: Payee[]
  private holdings: Holding[]
  private aaGroups: AaGroup[]
  private readonly products: WealthProduct[]
  private txnSeq: number
  private payeeSeq: number
  private holdingSeq: number
  private cardSeq: number
  private aaSeq: number
  private authorizationSeq: number
  private cancelRequestSeq: number
  /** 幂等键 → 首笔结果（10 分钟窗口；只防"同参数重复提交"，不替代票据）。 */
  private readonly idempotency = new Map<
    string,
    { readonly fingerprint: string; readonly result: TransferResult; readonly expiresAt: number }
  >()
  /**
   * 卡消费幂等表（与转账分开：结果形状不同，混存会逼调用方按 `txnId` 猜类型）。
   *
   * 卡消费没有票据入参——它由已审批的宿主工具（`merchant_order`）在核销之后调用，
   * 所以这里只做"同键同参数不重复扣款"。
   */
  private readonly cardSpendIdempotency = new Map<
    string,
    { readonly fingerprint: string; readonly result: CardSpendResult; readonly expiresAt: number }
  >()
  /** 原交易 `txnId` → 冲正结果（幂等：同 txnId 只生效一次）。 */
  private readonly reversals = new Map<string, ReversalResult>()
  /**
   * 风险问卷实例库（题目/分值的常量表在 `risk-questionnaire.ts`，本类只持实例）。
   *
   * 单独一个状态机而不是散在 mock 里：它与票据库同一定位——"谁在什么时候领了什么凭证"，
   * 核销语义（一次性）也一致。
   */
  private readonly riskBook: RiskQuestionnaireBook
  /**
   * 交易密码摘要（ADR-0014）：`userId → { salt, hash }`，哈希是 `sha256(salt:password)`。
   *
   * **只在内存**：进程退出即消失，不落盘、不落事件、不进日志。明文从不进这个类——
   * 调用方在栈帧里交出一次明文，这里立刻换成摘要。
   */
  private readonly txnPasswords = new Map<string, { readonly salt: string; readonly hash: string }>()
  /**
   * 改密交接票据（一次性）：`ticketId → { userId, expiresAt, usedAt? }`。
   *
   * 票据是"Agent 已发起、用户还没在安全页提交"这段窗口的凭证；明文只在安全页提交，
   * 所以这里只存归属与时效，**不存密码**。
   */
  private readonly passwordHandoffs = new Map<
    string,
    { readonly userId: string; readonly expiresAt: number; usedAt?: number }
  >()
  /** 交易密码连续失败计数（**只数旧密码不匹配**；格式错不计数，见 `core/password.ts`）。 */
  private readonly passwordFailures = new Map<string, number>()
  /** 交易密码锁定截止时刻（`undefined` = 未锁定）。 */
  private readonly passwordLockedUntil = new Map<string, number>()
  /** 最后一次改密时刻（`undefined` = 从未改过）。 */
  private readonly passwordChangedAt = new Map<string, number>()
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
    this.authorizations = [...(data.authorizations ?? [])]
    this.cancelRequests = [...(data.cancelRequests ?? [])]
    this.transactions = data.transactions.map((item) => ({ ...item }))
    this.payees = data.payees.map((item) => ({ ...item }))
    this.holdings = data.holdings.map((item) => ({ ...item }))
    this.aaGroups = []
    this.products = [...data.wealthProducts]
    // 新流水号不把**历史背景流水**（`th-*`，账单场景 T-05）算进起点：
    // 它们只用于账单聚合，不该把演示新流水从 `t-new-9` 推到 `t-new-69`
    // （数据变了 ≠ 行为变了，但快照里的流水号会因此漂移）。
    this.txnSeq = this.transactions.filter((item) => !String(item.id).startsWith('th-')).length
    this.payeeSeq = this.payees.length
    this.holdingSeq = this.holdings.length
    this.cardSeq = this.cards.length
    this.aaSeq = 0
    this.authorizationSeq = this.authorizations.length
    this.cancelRequestSeq = this.cancelRequests.length
    // 问卷库读写主体等级走同一张 `users` 表：等级的唯一权威仍是本体，
    // 问卷库不另存一份 "riskGrade" 缓存（两份必然漂移）。
    this.riskBook = new RiskQuestionnaireBook({
      now: () => this.now(),
      readRiskGrade: (userId) => this.users.get(userId)?.riskGrade,
      writeRiskGrade: (userId, grade) => {
        const user = this.users.get(userId)
        if (user !== undefined) this.users.set(userId, { ...user, riskGrade: grade })
      },
      ...(options.riskCooldownMs === undefined ? {} : { cooldownMs: options.riskCooldownMs }),
    })
    // 交易密码（ADR-0014）：造数里的每个用户都给同一个**演示**初始口令，
    // 盐按用户派生（同口令不同用户 → 不同摘要）。这里刻意不用 CSPRNG：
    // 盐从不离开进程，确定性派生让单测与回放不依赖熵（见 `deriveTxnPasswordSalt`）。
    for (const user of data.users) {
      const salt = deriveTxnPasswordSalt(String(user.id))
      this.txnPasswords.set(String(user.id), {
        salt,
        hash: hashTxnPassword(salt, DEMO_TXN_PASSWORD),
      })
    }
  }

  /* ── 交易密码（ADR-0014） ───────────────────────────────────────────────── */

  /**
   * 签发一次性改密交接票据（写）。
   *
   * 审批票据**先核销**：一次改密请求只能来自一次已批准的调用（红档），
   * 核销失败直接抛 `ticket-*`，连票据都不签——避免"审批没批也给了一张可用的交办票"。
   */
  async requestPasswordChange(
    userId: UserId,
    req: { readonly ticketId: string; readonly ttlMs: number },
    approval: TicketRef,
  ): Promise<PasswordHandoff> {
    this.tickets.redeem(approval, this.now())
    if (!this.users.has(userId)) {
      throw new BahError('user-unknown', `bank: 用户不存在：${String(userId)}`, { userId })
    }
    if (!Number.isSafeInteger(req.ttlMs) || req.ttlMs <= 0) {
      throw new BahError('password-ticket-invalid', 'bank: 交接票据 TTL 必须是正整数毫秒', {
        ttlMs: req.ttlMs,
      })
    }
    const at = this.now()
    this.prunePasswordHandoffs(at)
    const expiresAt = at + req.ttlMs
    this.passwordHandoffs.set(req.ticketId, { userId: String(userId), expiresAt })
    return {
      ticketId: req.ticketId,
      handoffPath: PASSWORD_HANDOFF_PATH,
      expiresAt,
      at,
    }
  }

  /** 校验交接票据（只读，不核销）：四种失败各有独立理由码。 */
  async checkPasswordHandoff(ticketId: string, userId: UserId): Promise<PasswordHandoff> {
    const record = this.requirePasswordHandoff(ticketId)
    if (record.userId !== String(userId)) {
      // 顺序：先判"已用/过期"再判归属——重放自己的过期票与猜别人的票，审计上要能分开
      throw new BahError('password-ticket-foreign', 'bank: 该改密票据不属于当前用户', { ticketId })
    }
    return {
      ticketId,
      handoffPath: PASSWORD_HANDOFF_PATH,
      expiresAt: record.expiresAt,
      at: this.now(),
    }
  }

  /** 核销交接票据（一次性；改密成功后才调用）。 */
  async consumePasswordHandoff(ticketId: string): Promise<void> {
    const record = this.requirePasswordHandoff(ticketId)
    this.passwordHandoffs.set(ticketId, { ...record, usedAt: this.now() })
  }

  /**
   * 修改交易密码（写）。校验顺序固定（先便宜后贵，见 `core/password.ts`）。
   *
   * 失败计数只在"旧密码不匹配"这一步累加：格式错说明申请还没成形，
   * 拿它计数会让用户打错一次格式就把自己逼近锁定。
   */
  async changeTxnPassword(
    userId: UserId,
    oldPassword: string,
    newPassword: string,
  ): Promise<PasswordChanged> {
    const key = String(userId)
    const stored = this.txnPasswords.get(key)
    if (stored === undefined) {
      throw new BahError('user-unknown', `bank: 该用户没有交易密码：${key}`, { userId })
    }
    const at = this.now()
    this.assertPasswordNotLocked(key, at)
    // ① 长度 ② 字符类别 ③ 新 ≠ 旧（都不读账本，先做）
    assertNewTxnPassword(newPassword, oldPassword)
    // ④ 旧密码比对（最贵：要算一次哈希）
    if (typeof oldPassword !== 'string' || hashTxnPassword(stored.salt, oldPassword) !== stored.hash) {
      const remaining = this.notePasswordMismatch(key, at)
      throw new BahError('password-mismatch', '旧交易密码不正确', {
        userId: key,
        remainingAttempts: remaining,
      })
    }
    // 成功：换盐（同盐继续用会让"旧摘要"在日志/内存快照里仍然可复用）、清计数、记时刻
    const salt = deriveTxnPasswordSalt(`${key}|${String(at)}`)
    this.txnPasswords.set(key, { salt, hash: hashTxnPassword(salt, newPassword) })
    this.passwordFailures.delete(key)
    this.passwordLockedUntil.delete(key)
    this.passwordChangedAt.set(key, at)
    return { changedAt: at }
  }

  /** 校验交易密码（只读：不累加失败计数、不锁定）。 */
  async checkTxnPassword(userId: UserId, password: string): Promise<boolean> {
    const stored = this.txnPasswords.get(String(userId))
    if (stored === undefined || typeof password !== 'string') return false
    return hashTxnPassword(stored.salt, password) === stored.hash
  }

  /** 交易密码状态（只读；顺手清掉已过窗口的锁，两次调用结果相同）。 */
  async passwordStatus(userId: UserId): Promise<PasswordStatus> {
    const key = String(userId)
    const at = this.now()
    const until = this.passwordLockedUntil.get(key)
    const locked = until !== undefined && until > at
    if (until !== undefined && !locked) {
      // 窗口已过：清锁并归零，`remainingAttempts` 才能回到 3
      this.passwordLockedUntil.delete(key)
      this.passwordFailures.delete(key)
    }
    return {
      lastChangedAt: this.passwordChangedAt.get(key) ?? null,
      remainingAttempts: remainingPasswordAttempts(this.passwordFailures.get(key) ?? 0, locked),
    }
  }

  /** 取有效票据；不存在/已用/过期分别抛码（归属由调用方判）。 */
  private requirePasswordHandoff(ticketId: string): {
    readonly userId: string
    readonly expiresAt: number
    usedAt?: number
  } {
    const record = this.passwordHandoffs.get(ticketId)
    if (record === undefined) {
      throw new BahError('password-ticket-unknown', `bank: 未知改密票据：${ticketId}`, { ticketId })
    }
    if (record.usedAt !== undefined) {
      throw new BahError('password-ticket-used', 'bank: 改密票据是一次性的，该票据已使用', {
        ticketId,
        usedAt: record.usedAt,
      })
    }
    if (record.expiresAt <= this.now()) {
      this.passwordHandoffs.delete(ticketId)
      throw new BahError('password-ticket-expired', 'bank: 改密票据已过期，请重新发起', {
        ticketId,
        expiresAt: record.expiresAt,
      })
    }
    return record
  }

  /** 锁定中直接拒；窗口已过则清锁归零。 */
  private assertPasswordNotLocked(userId: string, at: number): void {
    const until = this.passwordLockedUntil.get(userId)
    if (until === undefined) return
    if (until > at) {
      throw new BahError('password-locked', '交易密码连续错误次数过多，请稍后再试', {
        userId,
        until,
      })
    }
    this.passwordLockedUntil.delete(userId)
    this.passwordFailures.delete(userId)
  }

  /**
   * 记一次旧密码不匹配。
   *
   * @returns 剩余可尝试次数（1 或 2）
   * @throws `BahError('password-locked')` 达到阈值时（第 3 次）
   */
  private notePasswordMismatch(userId: string, at: number): number {
    const failures = (this.passwordFailures.get(userId) ?? 0) + 1
    this.passwordFailures.set(userId, failures)
    if (failures >= TXN_PASSWORD_MAX_ATTEMPTS) {
      const until = at + TXN_PASSWORD_LOCK_MS
      this.passwordLockedUntil.set(userId, until)
      throw new BahError('password-locked', '交易密码连续错误次数过多，请稍后再试', {
        userId,
        until,
      })
    }
    return TXN_PASSWORD_MAX_ATTEMPTS - failures
  }

  /** 票据表软上限：超过后清掉过期/已用的（有效票据永不丢弃）。 */
  private prunePasswordHandoffs(at: number): void {
    if (this.passwordHandoffs.size < 256) return
    for (const [ticketId, record] of this.passwordHandoffs) {
      if (record.usedAt !== undefined || record.expiresAt <= at) {
        this.passwordHandoffs.delete(ticketId)
      }
    }
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
      .map((item) => ({
        ...item,
        ...(item.restrictions === undefined
          ? {}
          : { restrictions: item.restrictions.map((restriction) => ({ ...restriction })) }),
      }))
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

  async applyCard(req: CardApplyReq): Promise<CardIssued> {
    const account =
      req.accountId === undefined
        ? this.accounts.find((item) => item.userId === req.userId && item.type === 'current')
        : this.requireAccount(req.accountId)
    if (account === undefined) {
      throw new BahError('account-unknown', 'bank: 当前用户没有可挂卡的活期账户', {
        userId: req.userId,
      })
    }
    if (account.userId !== req.userId) {
      throw new BahError('account-forbidden', 'bank: 账户不属于该用户', {
        accountId: account.id,
        userId: req.userId,
      })
    }
    if (account.status !== 'active') {
      throw new BahError('account-inactive', `bank: 账户状态 ${account.status}，不能申请卡片`, {
        accountId: account.id,
        status: account.status,
      })
    }
    const type: CardType = req.type ?? 'virtual'
    // 卡产品与介质正交（ADR-0015）：信用产品必须给授信额度，借记卡给了就是参数错。
    const kind: CardKind = req.kind ?? 'debit'
    if (kind === 'credit') {
      if (req.creditLimitCents === undefined) {
        throw new BahError('credit-limit-required', 'bank: 信用卡必须在申请时给授信额度', {
          userId: req.userId,
          kind,
        })
      }
      this.assertCreditLimit(req.creditLimitCents)
    } else if (req.creditLimitCents !== undefined) {
      throw new BahError('credit-not-applicable', 'bank: 借记卡没有授信额度（请用 kind=credit 申请信用卡）', {
        userId: req.userId,
        kind,
        creditLimitCents: req.creditLimitCents,
      })
    }
    /**
     * 信用产品的日/月限额缺省 = 授信额度：总额度已经封顶，
     * 再套一个更小的日/月限额只会让"额度内可用却刷不出去"（ADR-0015 §2.3）。
     */
    const creditLimitCents = kind === 'credit' ? req.creditLimitCents : undefined
    const defaultDaily = type === 'virtual' ? 200_000 : 100_000
    const defaultMonthly = type === 'virtual' ? 800_000 : 2_000_000
    const dailyLimitCents = req.dailyLimitCents ?? creditLimitCents ?? defaultDaily
    const monthlyLimitCents = req.monthlyLimitCents ?? creditLimitCents ?? defaultMonthly
    this.assertCardLimits(dailyLimitCents, monthlyLimitCents)
    this.cardSeq += 1
    let tail = String(1000 + this.cardSeq).slice(-4)
    while (this.cards.some((item) => item.tail === tail)) {
      this.cardSeq += 1
      tail = String(1000 + this.cardSeq).slice(-4)
    }
    const card: Card = {
      id: bankIds.card(`c-new-${this.cardSeq}`),
      accountId: account.id,
      tail,
      type,
      status: 'normal',
      dailyLimitCents,
      monthlyLimitCents,
      ...(kind === 'credit' ? { kind, creditLimitCents, usedCreditCents: 0 } : {}),
    }
    this.cards = [...this.cards, card]
    return {
      cardId: card.id,
      accountId: account.id,
      tail: card.tail,
      type: card.type,
      status: 'normal',
      dailyLimitCents: card.dailyLimitCents,
      monthlyLimitCents: card.monthlyLimitCents,
      ...(card.kind === undefined
        ? {}
        : {
            kind: card.kind,
            creditLimitCents: card.creditLimitCents,
            usedCreditCents: card.usedCreditCents,
          }),
    }
  }

  async setCardLimits(
    userId: UserId,
    cardId: CardId,
    patch: CardLimitPatch,
  ): Promise<CardLimitsChanged> {
    const card = this.cardOfUser(userId, cardId)
    if (card.status === 'lost') {
      throw new BahError('card-lost', 'bank: 该卡已挂失，不能调整额度', { cardId })
    }
    if (
      patch.dailyLimitCents === undefined &&
      patch.monthlyLimitCents === undefined &&
      patch.creditLimitCents === undefined
    ) {
      throw new BahError('card-limit-invalid', 'bank: 至少给一项额度（日/月/授信）', { cardId })
    }
    /**
     * 授信额度（ADR-0015）：只有信用产品有；**降额不得低于已用**——
     * 允许降到已用之下等于让账本当场自相矛盾（已用 > 额度）。
     */
    let creditLimitCents = card.creditLimitCents
    if (patch.creditLimitCents !== undefined) {
      if (card.kind !== 'credit') {
        throw new BahError(
          'credit-not-applicable',
          'bank: 该卡是借记卡，没有授信额度（信用卡请先用 card_apply 申请）',
          { cardId, tail: card.tail },
        )
      }
      this.assertCreditLimit(patch.creditLimitCents)
      const used = card.usedCreditCents ?? 0
      if (patch.creditLimitCents < used) {
        throw new BahError(
          'credit-in-use',
          `bank: 尾号 ${card.tail} 的卡已用 ${formatYuan(used)}，` +
            `授信额度不能降到 ${formatYuan(patch.creditLimitCents)}（最低可降到已用的 ${formatYuan(used)}）`,
          {
            cardId,
            creditLimitCents: patch.creditLimitCents,
            usedCreditCents: used,
            minimumCents: used,
          },
        )
      }
      creditLimitCents = patch.creditLimitCents
    }
    const dailyLimitCents = patch.dailyLimitCents ?? card.dailyLimitCents
    const monthlyLimitCents = patch.monthlyLimitCents ?? card.monthlyLimitCents
    this.assertCardLimits(dailyLimitCents, monthlyLimitCents)
    const changed =
      dailyLimitCents !== card.dailyLimitCents ||
      monthlyLimitCents !== card.monthlyLimitCents ||
      creditLimitCents !== card.creditLimitCents
    if (changed) {
      this.cards = this.cards.map((item) =>
        item.id === cardId
          ? {
              ...item,
              dailyLimitCents,
              monthlyLimitCents,
              ...(creditLimitCents === undefined ? {} : { creditLimitCents }),
            }
          : item,
      )
    }
    return {
      cardId,
      tail: card.tail,
      dailyLimitCents,
      monthlyLimitCents,
      changed,
      ...(card.kind === 'credit' && creditLimitCents !== undefined
        ? {
            kind: card.kind,
            creditLimitCents,
            usedCreditCents: card.usedCreditCents ?? 0,
          }
        : {}),
    }
  }

  async setCardRestriction(
    userId: UserId,
    cardId: CardId,
    input: CardRestrictionInput,
  ): Promise<CardRestrictionChange> {
    const card = this.cardOfUser(userId, cardId)
    if (card.status === 'lost') {
      throw new BahError('card-lost', 'bank: 该卡已挂失，不能调整交易限制', { cardId })
    }
    const current = card.restrictions ?? []
    let next: readonly CardRestriction[]
    if (input.mode === 'clear') {
      if (input.kind === undefined) {
        next = []
      } else {
        next = current.filter(
          (item) =>
            item.kind !== input.kind ||
            (input.value !== undefined && item.value !== input.value),
        )
      }
    } else {
      if (input.kind === undefined) {
        throw new BahError('card-restriction-invalid', 'bank: 设置交易限制必须给 kind', { cardId })
      }
      if (input.kind === 'category' && (input.value === undefined || input.value.length === 0)) {
        throw new BahError('card-restriction-invalid', 'bank: category 限制必须给 value', {
          cardId,
        })
      }
      // 品类是封闭集合：写入面就拒绝自由文本，否则"限制"永远匹配不上任何消费
      if (input.kind === 'category' && !isMerchantCategory(input.value ?? '')) {
        throw new BahError('card-restriction-invalid', 'bank: category 限制的 value 必须是已知品类', {
          cardId,
          value: input.value,
        })
      }
      const restriction: CardRestriction = {
        kind: input.kind,
        ...(input.kind === 'category' ? { value: input.value } : {}),
        ...(input.note === undefined ? {} : { note: input.note }),
        at: this.now(),
      }
      next = [
        ...current.filter(
          (item) =>
            item.kind !== restriction.kind ||
            (restriction.value !== undefined && item.value !== restriction.value),
        ),
        restriction,
      ]
    }
    const changed = JSON.stringify(next) !== JSON.stringify(current)
    if (changed) {
      this.cards = this.cards.map((item) =>
        item.id === cardId ? { ...item, restrictions: next } : item,
      )
    }
    return { cardId, tail: card.tail, restrictions: next, changed }
  }

  /**
   * 以卡消费（mock 收单通道，B-03 的品类拦截落点）。
   *
   * **校验顺序固定**（与 `docs/bank-tools.md` 的卡消费小节逐条对齐，不许换）：
   * 1) 卡存在且属于该用户 → 2) 状态 `normal` → 3) `online` 限制 → 4) `category` 限制 →
   * 5) **授信额度（仅 `kind='credit'`；ADR-0015）** → 6) 日/月限额 → 7) 账户可用余额 → 8) 记账。
   *
   * 前七步任一失败都在记账之前抛出：账本不变，卡额度不被"半笔消费"占用。
   * 授信额度排在日/月限额之前是刻意的：额度是信用产品的**主约束**，先判它，
   * 拒绝理由才对得上事实（借记卡不进这段，判定顺序逐字不变）。
   */
  async spendOnCard(req: CardSpendReq): Promise<CardSpendResult> {
    this.assertAmount(req.amountCents)
    const card = this.cardOfUser(req.userId, req.cardId)
    if (card.status !== 'normal') {
      throw new BahError(
        'card-unavailable',
        card.status === 'lost' ? 'bank: 该卡已挂失，不能用于支付' : 'bank: 该卡已冻结，请先解冻',
        { cardId: card.id, status: card.status },
      )
    }
    const restrictions = card.restrictions ?? []
    if (restrictions.some((item) => item.kind === 'online')) {
      throw new BahError('card-restricted', `bank: 尾号 ${card.tail} 的卡已限制线上交易`, {
        cardId: card.id,
        kind: 'online',
      })
    }
    const categoryHit = restrictions.find(
      (item) => item.kind === 'category' && item.value === req.merchantCategory,
    )
    if (categoryHit !== undefined) {
      throw new BahError(
        'card-restricted',
        `bank: 尾号 ${card.tail} 的卡已限制${MERCHANT_LABEL[req.merchantCategory]}类消费`,
        { cardId: card.id, kind: 'category', value: req.merchantCategory },
      )
    }

    /**
     * 授信额度（ADR-0015）：信用产品的**主约束**，刻意排在日/月限额之前。
     *
     * 为什么不是排在最后：额度是天花板，日/月限额是叠加在它上面的"防单日大额"。
     * 若先判日/月限额，"用了 1200、额度 5000、日限 5000、再刷 4000"会被报成
     * "超日限额"——而真正的原因只有一个：超额度。**先判主约束，理由才对得上事实。**
     * 借记卡（`kind` 缺省）整段跳过，判定顺序逐字不变。
     */
    if (card.kind === 'credit') {
      const creditLimitCents = card.creditLimitCents ?? 0
      const usedCreditCents = card.usedCreditCents ?? 0
      if (usedCreditCents + req.amountCents > creditLimitCents) {
        throw new BahError(
          'credit-limit-exceeded',
          `bank: 尾号 ${card.tail} 的信用卡已用 ${formatYuan(usedCreditCents)}，` +
            `本笔 ${formatYuan(req.amountCents)} 超过授信额度 ${formatYuan(creditLimitCents)}` +
            `（可用 ${formatYuan(Math.max(0, creditLimitCents - usedCreditCents))}）`,
          { cardId: card.id, creditLimitCents, usedCreditCents, neededCents: req.amountCents },
        )
      }
    }

    const at = this.now()
    const rawKey = req.idempotencyKey?.trim()
    const idemKey =
      rawKey === undefined || rawKey.length === 0
        ? undefined
        : `${req.userId}:${card.id}:${rawKey}`
    const fingerprint = `${req.merchantCategory}|${req.amountCents}|${req.memo ?? ''}`
    if (idemKey !== undefined) {
      const cached = this.cardSpendIdempotency.get(idemKey)
      if (cached !== undefined && cached.expiresAt > at) {
        if (cached.fingerprint !== fingerprint) {
          throw new BahError('idempotency-conflict', 'bank: 幂等键已用于不同的消费参数', {
            idempotencyKey: idemKey,
          })
        }
        return cached.result
      }
      if (cached !== undefined) this.cardSpendIdempotency.delete(idemKey)
    }

    const limits = this.cardLimitOf(card.accountId, card.id, at)
    if (limits.dailyUsedCents + req.amountCents > limits.dailyLimitCents) {
      throw new BahError(
        'card-daily-limit-exceeded',
        `bank: 尾号 ${card.tail} 的卡今日已用 ${formatYuan(limits.dailyUsedCents)}，` +
          `本笔 ${formatYuan(req.amountCents)} 超过日限额 ${formatYuan(limits.dailyLimitCents)}`,
        {
          cardId: card.id,
          dailyUsedCents: limits.dailyUsedCents,
          dailyLimitCents: limits.dailyLimitCents,
          amountCents: req.amountCents,
        },
      )
    }
    if (limits.monthlyUsedCents + req.amountCents > limits.monthlyLimitCents) {
      throw new BahError(
        'card-monthly-limit-exceeded',
        `bank: 尾号 ${card.tail} 的卡近 30 天已用 ${formatYuan(limits.monthlyUsedCents)}，` +
          `本笔 ${formatYuan(req.amountCents)} 超过月限额 ${formatYuan(limits.monthlyLimitCents)}`,
        {
          cardId: card.id,
          monthlyUsedCents: limits.monthlyUsedCents,
          monthlyLimitCents: limits.monthlyLimitCents,
          amountCents: req.amountCents,
        },
      )
    }

    const account = this.requireAccount(card.accountId)
    if (account.availableCents < req.amountCents) {
      throw new BahError(
        'insufficient-balance',
        `bank: 余额不足（可用 ${formatYuan(account.availableCents)}，需要 ${formatYuan(req.amountCents)}）`,
        {
          accountId: account.id,
          availableCents: account.availableCents,
          neededCents: req.amountCents,
        },
      )
    }

    const transaction: Transaction = {
      id: this.nextTxnId(),
      accountId: card.accountId,
      at,
      amountCents: req.amountCents,
      direction: 'out',
      counterparty: { name: req.memo ?? MERCHANT_LABEL[req.merchantCategory] },
      category: 'consumption',
      channel: 'app',
      status: 'success',
      viaCardId: card.id,
    }
    this.transactions = [...this.transactions, transaction]
    const balanceCents = account.balanceCents - req.amountCents
    const availableCents = account.availableCents - req.amountCents
    this.replaceAccount(account.id, { balanceCents, availableCents })

    /**
     * 额度占用（ADR-0015）：放在记账之后，等于"只有真的成交才占用"。
     * 记账前任何一步抛出都已经 return/throw，`usedCreditCents` 一分不动——
     * 不做"先占后回滚"，回滚路径就是第二份真相。
     */
    if (card.kind === 'credit') {
      const usedCreditCents = (card.usedCreditCents ?? 0) + req.amountCents
      this.cards = this.cards.map((item) =>
        item.id === card.id ? { ...item, usedCreditCents } : item,
      )
    }

    const dailyUsedCents = this.cardDailyUsedCents(card.id, at)
    const monthlyUsedCents = this.monthlyUsedCents(card.accountId, card.id, at)
    const result: CardSpendResult = {
      cardId: card.id,
      tail: card.tail,
      txnId: transaction.id,
      merchantCategory: req.merchantCategory,
      amountCents: req.amountCents,
      ...(req.memo === undefined ? {} : { memo: req.memo }),
      dailyUsedCents,
      dailyLimitCents: card.dailyLimitCents,
      monthlyUsedCents,
      monthlyLimitCents: card.monthlyLimitCents,
      balanceCents,
      availableCents,
      at,
    }
    if (idemKey !== undefined) {
      this.cardSpendIdempotency.set(idemKey, {
        fingerprint,
        result,
        expiresAt: at + MockBankCore.IDEMPOTENCY_TTL_MS,
      })
    }
    return result
  }

  private assertCardLimits(dailyLimitCents: number, monthlyLimitCents: number): void {
    if (!Number.isSafeInteger(dailyLimitCents) || dailyLimitCents <= 0) {
      throw new BahError('card-limit-invalid', 'bank: 日限额必须是正整数分', { dailyLimitCents })
    }
    if (!Number.isSafeInteger(monthlyLimitCents) || monthlyLimitCents <= 0) {
      throw new BahError('card-limit-invalid', 'bank: 月限额必须是正整数分', { monthlyLimitCents })
    }
    if (dailyLimitCents > monthlyLimitCents) {
      throw new BahError('card-limit-invalid', 'bank: 日限额不能高于月限额', {
        dailyLimitCents,
        monthlyLimitCents,
      })
    }
  }

  /** 授信额度的形状校验（ADR-0015）：正整数分，且不接受 0（0 额度等于不可用卡，不是"没额度"）。 */
  private assertCreditLimit(creditLimitCents: number): void {
    if (!Number.isSafeInteger(creditLimitCents) || creditLimitCents <= 0) {
      throw new BahError('credit-limit-invalid', 'bank: 授信额度必须是正整数分', {
        creditLimitCents,
      })
    }
  }

  async cancelSubscription(
    userId: UserId,
    subscriptionId: SubscriptionId,
    mode: 'now' | 'at-next-cycle' = 'now',
  ): Promise<SubscriptionCancelled> {
    const found = this.requireSubscription(userId, subscriptionId)
    // 已取消是终态：`at-next-cycle` 不得把 cancelled 复活成 paused
    if (found.status === 'cancelled') return { subscriptionId, merchant: found.merchant }
    if (mode === 'at-next-cycle') {
      // 到期即断：先暂停，`pauseUntil` 到期后由检测发现「仍在扣款」再升级取消流程（无定时器）
      const pauseUntil = found.nextChargeAt
      this.subscriptions = this.subscriptions.map((item) =>
        item.id === subscriptionId ? { ...item, status: 'paused' as const, pauseUntil } : item,
      )
      return { subscriptionId, merchant: found.merchant, pausedUntil: pauseUntil }
    }
    this.subscriptions = this.subscriptions.map((item) =>
      item.id === subscriptionId ? { ...item, status: 'cancelled' as const } : item,
    )
    return { subscriptionId, merchant: found.merchant }
  }

  async listSubscriptions(userId: UserId): Promise<Subscription[]> {
    return this.subscriptions
      .filter((item) => item.userId === userId)
      .map((item) => ({ ...item }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  async listAuthorizations(userId: UserId): Promise<MerchantAuthorization[]> {
    return this.authorizations
      .filter((item) => item.userId === userId)
      .map((item) => ({ ...item }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  async revokeAuthorization(
    userId: UserId,
    authorizationId: AuthorizationId,
  ): Promise<AuthorizationRevoked> {
    const found = this.authorizations.find((item) => item.id === authorizationId)
    if (found === undefined) {
      throw new BahError('authorization-unknown', `bank: 未知代扣协议：${authorizationId}`, {
        authorizationId,
      })
    }
    if (found.userId !== userId) {
      throw new BahError('authorization-not-owned', 'bank: 该代扣协议不属于当前用户', {
        authorizationId,
      })
    }
    const at = this.now()
    if (found.status === 'revoked') {
      // 幂等：已关的协议不重复记时刻，也不重复影响订阅
      return {
        authorizationId: found.id,
        merchant: found.merchant,
        revokedAt: found.revokedAt ?? at,
        affectedSubscriptions: [],
      }
    }
    this.authorizations = this.authorizations.map((item) =>
      item.id === authorizationId
        ? { ...item, status: 'revoked' as const, revokedAt: at }
        : item,
    )
    const authorizationKey = normalizeMerchant(found.merchantKey)
    const affected = this.subscriptions.filter(
      (item) =>
        item.userId === userId &&
        item.status === 'active' &&
        subscriptionKey(item) === authorizationKey,
    )
    this.subscriptions = this.subscriptions.map((item) =>
      affected.some((candidate) => candidate.id === item.id)
        ? { ...item, status: 'paused' as const, pauseUntil: item.nextChargeAt }
        : item,
    )
    return {
      authorizationId: found.id,
      merchant: found.merchant,
      revokedAt: at,
      affectedSubscriptions: affected.map((item) => item.id),
    }
  }

  async setSubscriptionWatch(
    userId: UserId,
    subscriptionId: SubscriptionId,
    input: SubscriptionWatch,
  ): Promise<Subscription> {
    const found = this.requireSubscription(userId, subscriptionId)
    if (found.status === 'cancelled') {
      throw new BahError('subscription-cancelled', 'bank: 已取消的订阅不能再设置提醒/标注', {
        subscriptionId,
      })
    }
    if (input.watch !== 'remind' && input.aheadDays !== undefined) {
      throw new BahError('reminder-ahead-invalid', 'bank: 只有 remind 才接受提前量', {
        watch: input.watch,
        aheadDays: input.aheadDays,
      })
    }
    if (input.aheadDays !== undefined && (!Number.isSafeInteger(input.aheadDays) || input.aheadDays < 1 || input.aheadDays > 7)) {
      throw new BahError('reminder-ahead-invalid', 'bank: 提醒提前量必须是 1..7 的整数天', {
        aheadDays: input.aheadDays,
      })
    }
    let updated: Subscription
    if (input.watch === 'idle') {
      updated = { ...stripWatchFields(found), note: 'idle' }
    } else if (input.watch === 'remind') {
      updated = { ...stripWatchFields(found), reminderAheadDays: input.aheadDays ?? 3 }
    } else {
      updated = stripWatchFields(found)
    }
    this.subscriptions = this.subscriptions.map((item) =>
      item.id === subscriptionId ? updated : item,
    )
    return { ...updated }
  }

  async recordCancelRequest(request: Omit<CancelRequest, 'id'>): Promise<CancelRequest> {
    this.requireSubscription(request.userId, request.subscriptionId)
    if (
      !Number.isFinite(request.requestedAt) ||
      !Number.isFinite(request.expectedEffectiveAt) ||
      !Number.isFinite(request.verifyBy)
    ) {
      throw new BahError('cancel-request-invalid', 'bank: 取消请求的时间戳非法', { request })
    }
    if (request.expectedEffectiveAt < request.requestedAt || request.verifyBy < request.expectedEffectiveAt) {
      throw new BahError('cancel-request-invalid', 'bank: 取消请求的生效/核验时间顺序非法', {
        requestedAt: request.requestedAt,
        expectedEffectiveAt: request.expectedEffectiveAt,
        verifyBy: request.verifyBy,
      })
    }
    this.cancelRequestSeq += 1
    const record: CancelRequest = {
      ...request,
      id: bankIds.cancelRequest(`cr-new-${this.cancelRequestSeq}`),
    }
    this.cancelRequests = [...this.cancelRequests, record]
    return { ...record }
  }

  async listCancelRequests(userId: UserId): Promise<CancelRequest[]> {
    return this.cancelRequests
      .filter((item) => item.userId === userId)
      .map((item) => ({ ...item }))
      .sort((left, right) => left.requestedAt - right.requestedAt)
  }

  async upcomingCharges(userId: UserId, withinDays: number): Promise<UpcomingCharge[]> {
    const at = this.now()
    const until = at + Math.max(0, withinDays) * DAY_MS
    return this.subscriptions
      .filter(
        (item) =>
          item.userId === userId &&
          item.status === 'active' &&
          item.nextChargeAt >= at &&
          item.nextChargeAt <= until,
      )
      .map((item) => ({
        subscriptionId: item.id,
        merchant: item.merchant,
        amountCents: item.amountCents,
        dueAt: item.nextChargeAt,
        cycle: item.cycle,
        ...(item.reminderAheadDays === undefined
          ? {}
          : { reminderAheadDays: item.reminderAheadDays }),
      }))
      .sort((left, right) => {
        const byDue = left.dueAt - right.dueAt
        if (byDue !== 0) return byDue
        // 同一到期日按 ID 稳定排序（布尔差，不产生额外分支）
        return Number(left.subscriptionId > right.subscriptionId) - Number(left.subscriptionId < right.subscriptionId)
      })
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
    // 与 createTransfer 同一守卫：预览也不许给出"锁定账户能对外转出"的假结论。
    if (account.type === 'locked' && selfTarget === undefined) {
      throw new BahError(
        'transfer-locked-source',
        'bank: 锁定账户只能回到本人活期，不能对外转出',
        { accountId: account.id },
      )
    }
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
    const restrictionRisk = viaCard === undefined ? undefined : cardRestrictionRisk(viaCard)
    // 月限额是**硬阻断**（与日限额不同：日限额可由人工审批放行，月限额是卡面合同额度）。
    // 只在显式以卡支付时判定：没有卡就没有"按卡归集"的对象，不拿账户流水臆造卡月累计。
    const monthlyRisk =
      viaCard === undefined
        ? undefined
        : this.cardMonthlyLimitRisk(account.id, viaCard, req.amountCents, at)
    const allRisks = [
      ...risks,
      ...(restrictionRisk === undefined ? [] : [restrictionRisk]),
      ...(monthlyRisk === undefined ? [] : [monthlyRisk]),
    ]
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
      risks: allRisks,
      verdict: allRisks.some((risk) => risk.severity === 'block')
        ? 'block'
        : allRisks.length > 0
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
      const restriction = cardRestrictionRisk(card)
      if (restriction !== undefined) {
        throw new BahError('card-restricted', `bank: ${restriction.message}`, {
          cardId: card.id,
          kinds: card.restrictions?.map((item) => item.kind),
        })
      }
      const monthly = this.cardMonthlyLimitRisk(account.id, card, req.amountCents, this.now())
      if (monthly !== undefined) {
        throw new BahError(monthly.code, `bank: ${monthly.message}`, {
          cardId: card.id,
          ...(monthly.detail ?? {}),
        })
      }
    }
    if (req.payee.name.trim().length === 0) {
      throw new BahError('payee-invalid', 'bank: 收款人姓名不能为空', { accountId: account.id })
    }
    // 校验都在核销之前（与外部转账同一条纪律）：内部划转的方向/目标状态非法时，
    // 票据连核销都不该发生。方向错误先于余额错误报——"锁定账户不能转出"
    // 比"余额不足"更接近用户要问的问题。
    const selfTarget = this.resolveSelfTransfer(account, req.payee)
    /**
     * 锁定账户的**对外**转出必须在这一层拦住（2026-11-01）。
     *
     * `resolveSelfTransfer` 只在"收款人命中本人账户"时有话说；收款人是外人时它返回
     * `undefined`，随后就走成了普通对外转账——earmark 会被当成可用余额花掉。
     * 这里以"source 是 locked 且不是内部划转"为闭集拒绝，与释放方向互补。
     */
    if (account.type === 'locked' && selfTarget === undefined) {
      throw new BahError(
        'transfer-locked-source',
        'bank: 锁定账户只能回到本人活期，不能对外转出',
        { accountId: account.id },
      )
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
      ...(req.viaCardId === undefined ? {} : { viaCardId: req.viaCardId }),
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
      // 冲正继承原交易的卡归属：月/日累计的减法按 `viaCardId` 归集，丢了就减不掉
      ...(original.viaCardId === undefined ? {} : { viaCardId: original.viaCardId }),
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
    // 第二道适当性闸门：直接调 `execute`（测试 / CLI / 未来适配器）绕过治理面时，
    // 这里的拒绝才是真的拦。两层调同一个纯函数，不会出现两套阈值。
    const customer = this.users.get(req.userId)
    if (customer === undefined) {
      throw new BahError('user-unknown', `bank: 用户不存在：${req.userId}`, { userId: req.userId })
    }
    const verdict = checkSuitability({
      customerRisk: customer.riskGrade,
      productRisk: product.riskGrade,
    })
    if (!verdict.allow) {
      throw new BahError(verdict.code, `bank: ${verdict.reason}`, {
        productId: product.id,
        customerRisk: customer.riskGrade,
        productRisk: product.riskGrade,
      })
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
      accountId: req.accountId,
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

  async listHoldings(userId: UserId): Promise<Holding[]> {
    return this.holdings.filter((item) => item.userId === userId).map((item) => ({ ...item }))
  }

  async redeemWealth(req: RedeemReq, ticket: TicketRef): Promise<RedeemResult> {
    const holding =
      req.holdingId === undefined
        ? this.holdings.find(
            (item) => item.userId === req.userId && item.productId === req.productId,
          )
        : this.holdings.find(
            (item) => item.userId === req.userId && item.id === req.holdingId,
          )
    if (holding === undefined) {
      throw new BahError('holding-unknown', 'bank: 找不到可赎回的持仓', {
        ...(req.holdingId === undefined ? {} : { holdingId: req.holdingId }),
        ...(req.productId === undefined ? {} : { productId: req.productId }),
      })
    }
    const product = this.products.find((item) => item.id === holding.productId)
    if (product === undefined) {
      throw new BahError('product-unknown', `bank: 未知理财产品：${holding.productId}`, {
        productId: holding.productId,
      })
    }
    const amountCents = req.amountCents ?? holding.marketValueCents
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new BahError('holding-amount-invalid', 'bank: 赎回金额必须是正整数分', {
        amountCents,
      })
    }
    if (amountCents > holding.marketValueCents) {
      throw new BahError('holding-amount-invalid', 'bank: 赎回金额超过持仓市值', {
        amountCents,
        marketValueCents: holding.marketValueCents,
      })
    }
    const account =
      holding.accountId === undefined
        ? this.accounts.find((item) => item.userId === req.userId && item.type === 'current')
        : this.requireAccount(holding.accountId)
    // 构造不可达：`purchaseWealth` 要求 accountId 并当场 `requireAccount`，所以持仓的 `accountId` 永不为空；演示数据集也没有"删账户"的动作。留这道守卫是给未来"从外部导入持仓"用的，不能让赎回静默回款到任意活期。
    /* v8 ignore next 5 */
    if (account === undefined) {
      throw new BahError('account-unknown', 'bank: 当前用户没有可回款的活期账户', {
        userId: req.userId,
      })
    }
    if (account.userId !== req.userId) {
      throw new BahError('account-forbidden', 'bank: 账户不属于该用户', {
        accountId: account.id,
        userId: req.userId,
      })
    }
    if (account.status !== 'active') {
      throw new BahError('account-inactive', `bank: 账户状态 ${account.status}，不能接收赎回款`, {
        accountId: account.id,
        status: account.status,
      })
    }

    const at = this.now()
    this.tickets.redeem(ticket, at)
    this.replaceAccount(account.id, {
      balanceCents: account.balanceCents + amountCents,
      availableCents: account.availableCents + amountCents,
    })
    const txn: Transaction = {
      id: this.nextTxnId(),
      accountId: account.id,
      at,
      amountCents,
      direction: 'in',
      counterparty: { name: product.name, memo: '理财赎回' },
      category: 'wealth',
      channel: 'app',
      status: 'success',
    }
    this.transactions = [...this.transactions, txn]

    const remaining = holding.marketValueCents - amountCents
    if (remaining === 0) {
      this.holdings = this.holdings.filter((item) => item.id !== holding.id)
    } else {
      const ratio = amountCents / holding.marketValueCents
      const remainingCost = Math.round(holding.costCents * (1 - ratio))
      this.holdings = this.holdings.map((item) =>
        item.id === holding.id
          ? {
              ...item,
              shares: Math.round(item.shares * (1 - ratio) * 100) / 100,
              costCents: remainingCost,
              marketValueCents: remaining,
              profitCents: remaining - remainingCost,
            }
          : item,
      )
    }
    const updated = this.accounts.find((item) => item.id === account.id)
    return {
      holdingId: holding.id,
      productId: product.id,
      productName: product.name,
      amountCents,
      shares: amountCents / 100,
      txnId: txn.id,
      balanceCents: updated?.balanceCents ?? account.balanceCents + amountCents,
      availableCents: updated?.availableCents ?? account.availableCents + amountCents,
      at,
    }
  }

  /**
   * 下发风险问卷（不写库、不改等级）。
   *
   * 返回的是**副本**：渠道改字段（比如给选项排版加符号）不能污染常量表。
   */
  async issueRiskQuestions(userId: UserId): Promise<RiskQuestionnaire> {
    return this.riskBook.issue(userId)
  }

  /** 按 ID 取问卷（只读副本；不存在返回 `undefined`，不抛——"没这张卷"是业务结果）。 */
  async getRiskQuestionnaire(questionnaireId: string): Promise<RiskQuestionnaire | undefined> {
    return this.riskBook.get(questionnaireId)
  }

  /**
   * 风险测评落档（写：更新客户风险等级）。
   *
   * 五道校验与一次性核销全在 `RiskQuestionnaireBook.assess`：本方法只做转接，
   * **不在这里另写一遍阈值或校验**——两份校验必然漂移，而这里漂移的后果是等级错了还落账。
   */
  async assessRisk(req: {
    readonly userId: UserId
    readonly questionnaireId: string
    readonly answers: readonly { readonly index: number; readonly key: string }[]
  }): Promise<RiskAssessment> {
    return this.riskBook.assess(req)
  }

  async createAa(req: AaCreateReq): Promise<AaGroup> {
    if (this.users.get(req.userId) === undefined) {
      throw new BahError('user-unknown', `bank: 用户不存在：${req.userId}`, { userId: req.userId })
    }
    if (!Number.isSafeInteger(req.totalCents) || req.totalCents <= 0) {
      throw new BahError('aa-invalid', 'bank: AA 总额必须是正整数分', {
        totalCents: req.totalCents,
      })
    }
    if (req.participants.length < 2 || req.participants.length > 20) {
      throw new BahError('aa-invalid', 'bank: AA 参与人必须是 2–20 人', {
        count: req.participants.length,
      })
    }
    let sum = 0
    for (const [index, participant] of req.participants.entries()) {
      if (participant.name.trim().length === 0) {
        throw new BahError('aa-invalid', 'bank: AA 参与人姓名不能为空', { index })
      }
      if (!Number.isSafeInteger(participant.shareCents) || participant.shareCents <= 0) {
        throw new BahError('aa-invalid', 'bank: AA 份额必须是正整数分', {
          index,
          shareCents: participant.shareCents,
        })
      }
      sum += participant.shareCents
    }
    if (sum !== req.totalCents) {
      throw new BahError('aa-invalid', 'bank: AA 份额之和必须等于总额', {
        totalCents: req.totalCents,
        sumCents: sum,
      })
    }
    const expiresInHours = req.expiresInHours ?? AA_DEFAULT_EXPIRY_HOURS
    if (
      !Number.isInteger(expiresInHours) ||
      expiresInHours < 1 ||
      expiresInHours > AA_MAX_EXPIRY_HOURS
    ) {
      throw new BahError(
        'aa-invalid',
        `bank: AA 收款窗口必须是 1–${String(AA_MAX_EXPIRY_HOURS)} 小时`,
        { expiresInHours },
      )
    }
    this.aaSeq += 1
    const createdAt = this.now()
    const group: AaGroup = {
      id: bankIds.aa(`aa-new-${this.aaSeq}`),
      userId: req.userId,
      title: req.title,
      totalCents: req.totalCents,
      participants: req.participants.map((participant) => ({
        name: participant.name.trim(),
        ...(participant.phone === undefined ? {} : { phone: participant.phone }),
        shareCents: participant.shareCents,
        status: 'pending',
      })),
      status: 'collecting',
      createdAt,
      expiresAt: createdAt + expiresInHours * 3_600_000,
    }
    this.aaGroups = [...this.aaGroups, group]
    return {
      ...group,
      participants: group.participants.map((participant) => ({ ...participant })),
    }
  }

  async getAa(userId: UserId, groupId: AaGroupId): Promise<AaGroup | undefined> {
    const group = this.aaGroups.find((item) => item.id === groupId && item.userId === userId)
    return group === undefined
      ? undefined
      : {
          ...group,
          participants: group.participants.map((participant) => ({ ...participant })),
        }
  }

  /**
   * 模拟代收（demo 口径，ADR-0011）。
   *
   * 固定顺序（顺序即安全边界）：
   * 1. 组归属（不存在/非本人 → `aa-unknown`，与 `getAa` 同码，不泄露他人组的存在性）；
   * 2. 组状态必须是 `collecting`（`completed` / `cancelled` → `aa-group-closed`）；
   *    `completed` 组对**已付参与人**的重复 collect 例外：与 collecting 分支同口径，
   *    返回 `aa-participant-paid`（两次重复代收不该有两种理由码）；
   * 3. 未过收款截止时间（`expiresAt < now` → `aa-group-closed`；与到期 job 同一严格口径）。
   *    到期 job 还没跑不等于还能收钱：窗口是事实，job 只是收口动作；
   * 4. 参与人必须存在（姓名或序号；同名多位 → `aa-participant-ambiguous`）；
   * 5. 参与人必须 `pending`：
   *    - 已付 → `aa-participant-paid`（幂等错误，不重复入账）；
   *    - 已拒绝 / 已过期 → `aa-participant-closed`（状态不改）；
   * 6. 记账：主账户 +share，写一条 `in / transfer` 流水（memo「AA 代收：<标题>」）。
   *
   * 任一步失败都在记账之前抛：账本与组状态都不变。
   * **不接收手机号**：定位只用姓名/序号，手机号不进这个入口。
   */
  async collectAa(req: AaCollectReq): Promise<AaCollectResult> {
    const group = this.aaGroups.find((item) => item.id === req.groupId && item.userId === req.userId)
    if (group === undefined) {
      throw new BahError('aa-unknown', `bank: 找不到 AA 组 ${req.groupId}`, {
        groupId: req.groupId,
      })
    }
    const at = this.now()
    if (group.status !== 'collecting') {
      if (group.status === 'completed') {
        const paidIndex = this.participantIndexOf(group.participants, req.participant)
        if (group.participants[paidIndex]!.status === 'paid') {
          throw new BahError(
            'aa-participant-paid',
            `bank: ${group.participants[paidIndex]!.name} 的份额已经收过`,
            { groupId: group.id, index: paidIndex },
          )
        }
      }
      throw new BahError('aa-group-closed', `bank: AA 组状态为 ${group.status}，不能再代收`, {
        groupId: group.id,
        status: group.status,
      })
    }
    if (group.expiresAt !== undefined && group.expiresAt < at) {
      throw new BahError('aa-group-closed', 'bank: AA 组已过收款截止时间，不能再代收', {
        groupId: group.id,
        expiresAt: group.expiresAt,
      })
    }
    const index = this.participantIndexOf(group.participants, req.participant)
    const participant = group.participants[index]!
    if (participant.status === 'paid') {
      throw new BahError('aa-participant-paid', `bank: ${participant.name} 的份额已经收过`, {
        groupId: group.id,
        index,
      })
    }
    if (participant.status === 'declined' || participant.status === 'expired') {
      throw new BahError(
        'aa-participant-closed',
        `bank: ${participant.name} 已${participant.status === 'declined' ? '拒绝' : '过期'}，不能再代收`,
        { groupId: group.id, index, status: participant.status },
      )
    }

    const primary = this.primaryAccountOf(req.userId)
    const transaction: Transaction = {
      id: this.nextTxnId(),
      accountId: primary.id,
      at,
      amountCents: participant.shareCents,
      direction: 'in',
      // 姓名是展示字段（组里本来就是参与者列表），不做额外 PII 落账
      counterparty: { name: participant.name, memo: `AA 代收：${group.title}` },
      category: 'transfer',
      channel: 'app',
      status: 'success',
    }
    this.transactions = [...this.transactions, transaction]
    this.replaceAccount(primary.id, {
      balanceCents: primary.balanceCents + participant.shareCents,
      availableCents: primary.availableCents + participant.shareCents,
    })

    const participants = group.participants.map((item, position) =>
      position === index ? { ...item, status: 'paid' as const, paidAt: at } : { ...item },
    )
    const updated = this.replaceAaGroup(this.settleAaGroup({ ...group, participants }))
    return {
      group: this.copyAaGroup(updated),
      participantIndex: index,
      collectedCents: participant.shareCents,
      txnId: transaction.id,
    }
  }

  /**
   * 参与人拒绝：`pending → declined`。
   *
   * 组状态仍走 `settleAaGroup`：拒绝一个人不等于散组（其余人还在等），
   * 但若他是最后一个未表态的人，组就在这一刻收口（有 paid → completed，否则 cancelled）。
   */
  async declineAa(req: AaParticipantActionReq): Promise<AaSettlementResult> {
    const group = this.mustCollectingAa(req.userId, req.groupId, '拒绝')
    const index = this.participantIndexOf(group.participants, req.participant)
    const participant = group.participants[index]!
    if (participant.status === 'paid') {
      throw new BahError('aa-participant-paid', `bank: ${participant.name} 的份额已经收过，不能改拒绝`, {
        groupId: group.id,
        index,
      })
    }
    if (participant.status === 'expired') {
      throw new BahError('aa-participant-closed', `bank: ${participant.name} 的份额已经过期`, {
        groupId: group.id,
        index,
        status: participant.status,
      })
    }
    const at = this.now()
    // 重复拒绝是幂等操作：不改状态，也不重复落事件
    if (participant.status === 'declined') {
      return { group: this.copyAaGroup(group), affected: [], at }
    }
    const participants = group.participants.map((item, position) =>
      position === index ? { ...item, status: 'declined' as const } : { ...item },
    )
    const updated = this.replaceAaGroup(this.settleAaGroup({ ...group, participants }))
    return { group: this.copyAaGroup(updated), affected: [index], at }
  }

  /** 组织者提前结束：剩余 `pending` 全部转 `expired`，再按同一收口规则定组状态。 */
  async closeAa(req: AaCloseReq): Promise<AaSettlementResult> {
    const group = this.mustCollectingAa(req.userId, req.groupId, '结束')
    const at = this.now()
    const affected: number[] = []
    const participants = group.participants.map((participant, index) => {
      if (participant.status !== 'pending') return { ...participant }
      affected.push(index)
      return { ...participant, status: 'expired' as const }
    })
    const updated = this.replaceAaGroup(this.settleAaGroup({ ...group, participants }))
    return { group: this.copyAaGroup(updated), affected, at }
  }

  /**
   * 到期扫描：只处理 `collecting && expiresAt < at` 的组。
   *
   * 收口后组状态不再是 `collecting`，下一次扫描自然跳过——幂等来自状态机本身，
   * 不依赖 job 里的进程级账本。没有 `expiresAt` 的历史组不处理。
   */
  async expireAaGroups(at: number): Promise<readonly AaSettlementResult[]> {
    const due = this.aaGroups.filter(
      (group) =>
        group.status === 'collecting' &&
        group.expiresAt !== undefined &&
        group.expiresAt < at,
    )
    const results: AaSettlementResult[] = []
    for (const group of due) {
      const affected: number[] = []
      const participants = group.participants.map((participant, index) => {
        if (participant.status !== 'pending') return { ...participant }
        affected.push(index)
        return { ...participant, status: 'expired' as const }
      })
      const updated = this.replaceAaGroup(this.settleAaGroup({ ...group, participants }))
      results.push({ group: this.copyAaGroup(updated), affected, at })
    }
    return results
  }

  /** 组归属 + 组状态校验（decline/close 共用的前两道闸）。 */
  private mustCollectingAa(
    userId: UserId,
    groupId: AaGroupId,
    verb: string,
  ): AaGroup {
    const group = this.aaGroups.find((item) => item.id === groupId && item.userId === userId)
    if (group === undefined) {
      throw new BahError('aa-unknown', `bank: 找不到 AA 组 ${groupId}`, { groupId })
    }
    if (group.status !== 'collecting') {
      throw new BahError('aa-group-closed', `bank: AA 组状态为 ${group.status}，不能再${verb}`, {
        groupId: group.id,
        status: group.status,
      })
    }
    return group
  }

  /**
   * 收口判定（**唯一一份**）：close / 到期 / 全员 paid / 最后一人拒绝都走这里。
   *
   * 规则：
   * - 还有 `pending` → 继续 `collecting`（一个人拒绝不散组，其他人还在等）；
   * - 没有 `pending` 且有 `paid` → `completed`；
   * - 没有 `pending` 也没有 `paid` → `cancelled`（全员拒绝/全员过期）。
   *
   * 三处各写一份判定，必然出现"close 说 completed、到期说 cancelled"的对账事故。
   */
  private settleAaGroup(group: AaGroup): AaGroup {
    if (group.participants.some((participant) => participant.status === 'pending')) {
      return group.status === 'collecting' ? group : { ...group, status: 'collecting' }
    }
    const paid = group.participants.some((participant) => participant.status === 'paid')
    const status: AaGroupStatus = paid ? 'completed' : 'cancelled'
    return { ...group, status }
  }

  private replaceAaGroup(group: AaGroup): AaGroup {
    this.aaGroups = this.aaGroups.map((item) => (item.id === group.id ? group : item))
    return group
  }

  /** 出参一律给副本：调用方改数组不能污染账本。 */
  private copyAaGroup(group: AaGroup): AaGroup {
    return {
      ...group,
      participants: group.participants.map((participant) => ({ ...participant })),
    }
  }

  /** 参与人定位：序号（0 起）或姓名精确匹配；同名多位必须用序号（不猜）。 */
  private participantIndexOf(
    participants: AaGroup['participants'],
    selector: number | string,
  ): number {
    if (typeof selector === 'number') {
      if (!Number.isInteger(selector) || selector < 0 || selector >= participants.length) {
        throw new BahError('aa-participant-unknown', `bank: AA 参与人序号越界：${String(selector)}`, {
          selector,
          count: participants.length,
        })
      }
      return selector
    }
    const name = selector.trim()
    if (name.length === 0) {
      throw new BahError('aa-participant-unknown', 'bank: AA 参与人不能为空', {})
    }
    const matches = participants
      .map((participant, index) => ({ participant, index }))
      .filter((item) => item.participant.name === name)
    if (matches.length === 0) {
      throw new BahError('aa-participant-unknown', `bank: AA 组里没有参与人「${name}」`, { name })
    }
    if (matches.length > 1) {
      throw new BahError(
        'aa-participant-ambiguous',
        `bank: AA 组里有 ${String(matches.length)} 位「${name}」，请改用序号`,
        { name, count: matches.length },
      )
    }
    return matches[0]!.index
  }

  /** 组织者主账户：按账户 ID 排序后的第一张（与 `listAccounts` 同口径，不另建"主账户"字段）。 */
  private primaryAccountOf(userId: UserId): Account {
    const accounts = this.accounts
      .filter((item) => item.userId === userId)
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    const primary = accounts[0]
    // 构造不可达：`createAa` 先校验用户在册，而造数器给每个在册用户都配了 至少一张账户；"有用户但零账户"只能来自外部导入。留这道守卫是不让 AA 静默落到别人的户上。
    /* v8 ignore next 4 */
    if (primary === undefined) {
      throw new BahError('account-unknown', `bank: 用户 ${userId} 没有可入账账户`, { userId })
    }
    return primary
  }

  /* ── 内部推导 ───────────────────────────────────────────────────────────── */

  private collectAnomalies(
    item: Transaction,
    anomalies: BillAnomaly[],
    subscriptionSeen: Map<string, Transaction['id']>,
  ): void {
    if (item.amountCents >= this.limitsConfig.billLargeCents) {
      anomalies.push({ kind: 'large', txnId: item.id, note: `大额支出 ${formatYuan(item.amountCents)}` })
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

  /** 近 30 天（UTC 滚动窗口，含当日）该卡成功转出/消费 - 对应冲正（不含本笔）。 */
  private monthlyUsedCents(accountId: AccountId, cardId: CardId, at: number): number {
    const from = at - 30 * DAY_MS
    let outCents = 0
    let reversedCents = 0
    for (const item of this.transactions) {
      if (item.accountId !== accountId || item.viaCardId !== cardId) continue
      if (item.status !== 'success') continue
      if (item.at < from || item.at > at) continue
      if (item.direction === 'out' && (item.category === 'transfer' || item.category === 'consumption')) {
        outCents += item.amountCents
      }
      if (item.direction === 'in' && item.category === 'refund' && item.reversalOf !== undefined) {
        reversedCents += item.amountCents
      }
    }
    return Math.max(0, outCents - reversedCents)
  }

  /** 同卡、同 UTC 日的转出 + 消费（减当日冲正）；卡消费日限额与转账日限额分账。 */
  private cardDailyUsedCents(cardId: CardId, at: number): number {
    const today = dayKey(at)
    let outCents = 0
    let reversedCents = 0
    for (const item of this.transactions) {
      if (item.viaCardId !== cardId || item.status !== 'success') continue
      if (dayKey(item.at) !== today) continue
      if (item.direction === 'out' && (item.category === 'transfer' || item.category === 'consumption')) {
        outCents += item.amountCents
      }
      if (item.direction === 'in' && item.category === 'refund' && item.reversalOf !== undefined) {
        reversedCents += item.amountCents
      }
    }
    return Math.max(0, outCents - reversedCents)
  }

  /**
   * 卡面额度 + 卡口径已用（**不与 Config 日限额取 min**：那是转账口径，不是卡消费口径）。
   *
   * `cardId` 缺省时沿用 `dailyLimitOf` 的"第一张正常卡"口径——同一账户只按一张卡归集，
   * 不把多张卡的流水混在一起。
   */
  private cardLimitOf(
    accountId: AccountId,
    cardId: CardId | undefined,
    at: number,
  ): {
    readonly dailyLimitCents: number
    readonly monthlyLimitCents: number
    readonly dailyUsedCents: number
    readonly monthlyUsedCents: number
  } {
    const card =
      cardId === undefined
        ? this.cards.find((item) => item.accountId === accountId && item.status === 'normal')
        : this.cards.find((item) => item.id === cardId)
    if (card === undefined) {
      return { dailyLimitCents: 0, monthlyLimitCents: 0, dailyUsedCents: 0, monthlyUsedCents: 0 }
    }
    return {
      dailyLimitCents: card.dailyLimitCents,
      monthlyLimitCents: card.monthlyLimitCents,
      dailyUsedCents: this.cardDailyUsedCents(card.id, at),
      monthlyUsedCents: this.monthlyUsedCents(accountId, card.id, at),
    }
  }

  /** 月限额风控条目（preview 用；create 同源函数再判一次并在核销前抛错）。 */
  private cardMonthlyLimitRisk(
    accountId: AccountId,
    card: Card,
    amountCents: number,
    at: number,
  ): RiskFinding | undefined {
    const used = this.monthlyUsedCents(accountId, card.id, at)
    if (used + amountCents <= card.monthlyLimitCents) return undefined
    return {
      rule: 'card-monthly-limit',
      severity: 'block',
      code: 'card-monthly-limit-exceeded',
      message:
        `尾号 ${card.tail} 的卡近 30 天已用 ${formatYuan(used)}，` +
        `本笔 ${formatYuan(amountCents)} 超过月限额 ${formatYuan(card.monthlyLimitCents)}`,
      detail: {
        cardId: card.id,
        monthlyUsedCents: used,
        monthlyLimitCents: card.monthlyLimitCents,
        amountCents,
      },
    }
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

  private requireSubscription(userId: UserId, subscriptionId: SubscriptionId): Subscription {
    const found = this.subscriptions.find((item) => item.id === subscriptionId)
    if (found === undefined) {
      throw new BahError('subscription-unknown', `bank: 未知订阅：${subscriptionId}`, {
        subscriptionId,
      })
    }
    if (found.userId !== userId) {
      throw new BahError('subscription-not-owned', 'bank: 该订阅不属于当前用户', { subscriptionId })
    }
    return found
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
    if (self.id === source.id) {
      throw new BahError('payee-invalid', 'bank: 不能向同一个账户内部划转', { accountId: source.id })
    }
    /**
     * 释放方向（2026-11-01）：锁定账户 → 本人活期。
     *
     * 「只进不出」的原意是**不能对外支付**；把钱回收成可用余额不是对外转移。
     * 目标账户在本分支内仍然校验 active，且只能回到同一 userId 的活期。
     * 其余以锁定账户为转出方的组合继续拒绝（对外转账不能拿 earmark 当余额）。
     */
    if (source.type === 'locked' && self.type === 'current') {
      if (self.status !== 'active') {
        throw new BahError('account-inactive', `bank: 目标账户状态 ${self.status}，不能转入`, {
          accountId: self.id,
          status: self.status,
        })
      }
      return self
    }
    if (source.type === 'locked') {
      throw new BahError(
        'transfer-locked-source',
        'bank: 锁定账户只能回到本人活期，不能对外转出',
        { accountId: source.id },
      )
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
      ...(req.viaCardId === undefined ? {} : { viaCardId: req.viaCardId }),
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
    const name = target.name.trim()
    // 赛题 §二「按手机号转账」：name 位置可能就是 11 位手机号。
    // 先按姓名精确匹配；未命中时再按手机号匹配（手机号是联系人库里的强标识）。
    const phone = target.phone ?? (/^1\d{10}$/.test(name) ? name : undefined)
    return this.payees.find(
      (item) =>
        item.userId === userId &&
        (item.name === name || (phone !== undefined && item.phone === phone)) &&
        (target.phone === undefined || item.phone === target.phone),
    )
  }

  /** 转账成功后把收款人落到 Payee 表（新收款人 → `binding = 'new'`）。 */
  private ensurePayee(userId: UserId, target: TransferReq['payee'], at: number): Payee {
    const existing = this.findPayee(userId, target)
    if (existing !== undefined) return existing
    const name = target.name.trim()
    const phone = target.phone ?? (/^1\d{10}$/.test(name) ? name : undefined)
    this.payeeSeq += 1
    const payee: Payee = {
      id: bankIds.payee(`p-new-${this.payeeSeq}`),
      userId,
      name,
      ...(phone === undefined ? {} : { phone }),
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

/** 订阅的关联键：`merchantKey` 优先，缺省按展示名现算（与检测共用同一套归一化）。 */
function subscriptionKey(subscription: Subscription): string {
  return normalizeMerchant(subscription.merchantKey ?? subscription.merchant)
}

/**
 * 交易限制 → **转账**预检风控。
 *
 * 转账路径没有品类语义：只有 `online` / `overseas` 是硬阻断。
 * `category` 在 `spendOnCard`（mock 卡消费通道）上单独判定——这里不假装它拦住了转账。
 */
function cardRestrictionRisk(card: Card): RiskFinding | undefined {
  const restricted = (card.restrictions ?? []).filter(
    (item) => item.kind === 'online' || item.kind === 'overseas',
  )
  if (restricted.length === 0) return undefined
  const labels = restricted.map((item) => (item.kind === 'online' ? '线上交易' : '境外交易'))
  return {
    rule: 'card-restriction',
    severity: 'block',
    code: 'card-restricted',
    message: `尾号 ${card.tail} 的卡已限制${labels.join('、')}`,
    detail: { cardId: card.id, kinds: restricted.map((item) => item.kind) },
  }
}

/** 清掉提醒/标注两个字段（`none` 与切换标注时共用）。 */
function stripWatchFields(subscription: Subscription): Subscription {
  const copy: Record<string, unknown> = { ...subscription }
  delete copy['note']
  delete copy['reminderAheadDays']
  return copy as unknown as Subscription
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
