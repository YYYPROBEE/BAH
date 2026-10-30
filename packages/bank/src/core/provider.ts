/**
 * Provider seam（施工单 07 §2）：业务能力面与实现解耦。
 *
 * 真实对接只换 Provider——工具族（施工单 08）、审批（09）与渠道（13–15）都只依赖本接口。
 * mock 实现（`mock.ts`）不做任何 I/O：全部状态在内存，重启即回到造数初始态。
 */

import type {
  Account,
  AccountId,
  AuthorizationId,
  BankLimits,
  BillAnomaly,
  CancelRequest,
  Card,
  CardId,
  CardStatus,
  ChargeCycle,
  Holding,
  MerchantAuthorization,
  PayeeBinding,
  PayeeId,
  ProductId,
  ProductKind,
  RiskGrade,
  Subscription,
  SubscriptionId,
  Transaction,
  TxnCategory,
  TxnChannel,
  TxnDirection,
  User,
  UserId,
  WealthProduct,
} from './model.ts'
import type { TicketRef } from './ticket.ts'

/** 余额快照（权威口径来自账本，不是会话缓存）。 */
export interface Balance {
  readonly accountId: AccountId
  readonly balanceCents: number
  readonly availableCents: number
  /** 读取时刻（epoch ms）。 */
  readonly asOf: number
}

/** 分页结果（游标是不透明字符串；mock 用偏移量，真实对接可换). */
export interface Page<T> {
  readonly items: readonly T[]
  /** 还有下一页时给出；否则缺省。 */
  readonly nextCursor?: string
}

/** 交易查询条件（施工单 08 的 `query_transactions` 工具会映射到这里）。 */
export interface TxnQuery {
  readonly userId: UserId
  readonly accountId?: AccountId
  /** 起始时刻（含）。 */
  readonly from?: number
  /** 结束时刻（含）。 */
  readonly to?: number
  readonly category?: TxnCategory
  /** 收支方向（下推到核心查询，避免分页后过滤导致每页缩水）。 */
  readonly direction?: TxnDirection
  /** 每页条数（缺省 20，上限 100）。 */
  readonly limit?: number
  /** 游标（上一页返回的 `nextCursor`）。 */
  readonly cursor?: string
}

/** 账单查询条件。 */
export interface BillQuery {
  readonly userId: UserId
  readonly accountId?: AccountId
  /** 账期 `YYYY-MM`（UTC）；缺省 = 当前账期。 */
  readonly period?: string
}

/** 账单报告（施工单 08 的 `analyze_bill` 工具的结果面）。 */
export interface BillReport {
  readonly period: string
  readonly totalInCents: number
  readonly totalOutCents: number
  readonly byCategory: Readonly<Partial<Record<TxnCategory, number>>>
  readonly anomalies: readonly BillAnomaly[]
  /** 环比（百分数，正=增加）；没有上期数据时缺省。 */
  readonly momChangePct?: number
  /** 用于环比的上期账期。 */
  readonly comparedPeriod: string
}

/** 风控规则名（五条，施工单 07 §4.3）。 */
export type RiskRule =
  | 'insufficient-balance'
  | 'daily-limit'
  | 'payee'
  | 'night-amount'
  | 'velocity'
  | 'duplicate'
  | 'card-status'

/** 风险级别：`block` 会让预检判决为 block，`warn` 只提示（最终 ask/deny 由治理平面决定）。 */
export type RiskSeverity = 'warn' | 'block'

/** 一条风控发现（结构化理由码 + 可读说明）。 */
export interface RiskFinding {
  readonly rule: RiskRule
  readonly severity: RiskSeverity
  /** 返回码（kebab-case，渠道与审计按它分支）。 */
  readonly code: string
  readonly message: string
  readonly detail?: Readonly<Record<string, unknown>>
}

/** 预检总判决（不等于治理平面的最终 ask/deny）。 */
export type RiskVerdict = 'allow' | 'warn' | 'block'

/** 预检里看到的收款人视图（新收款人 `binding = 'new'`）。 */
export interface PayeeView {
  readonly payeeId?: PayeeId
  readonly name: string
  readonly phone?: string
  readonly binding: PayeeBinding
}

/** 转账请求（金额一律分）。 */
export interface TransferReq {
  readonly fromAccountId: AccountId
  readonly payee: {
    readonly name: string
    readonly phone?: string
    readonly memo?: string
    /** 已绑定收款人时带上（白名单判定用）。 */
    readonly payeeId?: PayeeId
  }
  readonly amountCents: number
  readonly channel: TxnChannel
  /** 可选幂等键（同键 + 同参数在 TTL 窗口内只扣款一次；重复调用返回首笔结果）。 */
  readonly idempotencyKey?: string
  /**
   * 以哪张卡作为支付工具（可选）。
   *
   * Mock 没有独立的卡消费通道；给了就必须属于 `fromAccountId` 且状态为 `normal`。
   * 不传 = 账户转账（原语义逐字不变）。
   */
  readonly viaCardId?: CardId
}

/** 试算 + 风控预检结果（施工单 07 §0 第 4 条：当日已累计与剩余额度是权威口径）。 */
export interface TransferPreview {
  readonly amountCents: number
  readonly feeCents: number
  readonly payee: PayeeView
  /** 当日已累计转出（分）。 */
  readonly dailyUsedCents: number
  readonly dailyLimitCents: number
  /** 当日剩余额度（分）：`max(0, limit - used)`，**不含**本笔。 */
  readonly remainingCents: number
  readonly risks: readonly RiskFinding[]
  readonly verdict: RiskVerdict
  /** 本笔使用的卡（未指定 `viaCardId` 时不出现）。 */
  readonly viaCard?: { readonly tail: string; readonly status: CardStatus }
}

/** 转账执行结果。 */
export interface TransferResult {
  readonly txnId: Transaction['id']
  readonly ticketId: TicketRef['ticketId']
  readonly amountCents: number
  readonly feeCents: number
  readonly balanceCents: number
  readonly availableCents: number
  readonly dailyUsedCents: number
  readonly dailyLimitCents: number
  readonly remainingCents: number
  readonly at: number
}

/** 理财产品筛选。 */
export interface WealthFilter {
  readonly riskGrade?: RiskGrade
  readonly kind?: ProductKind
  readonly maxTermDays?: number
}

/** 购买理财请求。 */
export interface PurchaseReq {
  readonly userId: UserId
  readonly accountId: AccountId
  readonly productId: ProductId
  readonly amountCents: number
}

/**
 * 业务能力面（施工单 07 §2）。
 *
 * 读操作不需要票据；**写操作全部强制 `TicketRef`**（授权进领域边界）。
 * card：list / reportLost 已接；申请/提额/限额未加。subscription：只有 cancel。
 */
/** 挂失银行卡的结果（ADR-0003）。 */
export interface CardLostResult {
  readonly cardId: CardId
  readonly tail: string
  readonly status: 'lost'
}

/** 冻结/解冻的结果（ADR-0006）。 */
export interface CardStateChange {
  readonly cardId: CardId
  readonly tail: string
  readonly status: 'frozen' | 'normal'
  /** 是否真的发生了迁移（幂等调用为 false）。 */
  readonly changed: boolean
}

/** 取消订阅的结果（ADR-0003）。 */
export interface SubscriptionCancelled {
  readonly subscriptionId: SubscriptionId
  readonly merchant: string
  /** `mode = 'at-next-cycle'` 时的「到期即断」截止时刻。 */
  readonly pausedUntil?: number
}

/** 关闭代扣协议的结果（ADR-0007；硬断供）。 */
export interface AuthorizationRevoked {
  readonly authorizationId: AuthorizationId
  readonly merchant: string
  readonly revokedAt: number
  /** 因协议关闭而暂停的订阅（同一 `merchantKey` 下的全部 active 订阅）。 */
  readonly affectedSubscriptions: readonly SubscriptionId[]
}

/** 订阅提醒/标注的写入面（`remind` 写 remind 标记，`none` 清空）。 */
export interface SubscriptionWatch {
  readonly watch: 'remind' | 'idle' | 'none'
  readonly aheadDays?: number
}

/** 即将扣款的一条（只读；实体槽位「即将扣款」块的数据源）。 */
export interface UpcomingCharge {
  readonly subscriptionId: SubscriptionId
  readonly merchant: string
  readonly amountCents: number
  readonly dueAt: number
  readonly cycle: ChargeCycle
  /** 用户设置的提醒提前量（1..7）；缺省 = 槽位默认窗口。 */
  readonly reminderAheadDays?: number
}

export interface BankCoreProvider {
  /**
   * 读用户（只读）。
   *
   * 实体槽位用它取**权威姓名**与"主体是否存在"：绑定的 `userId` 核心不认识时，
   * 槽位必须明确降级，不能拿静态画像顶替。不存在返回 `undefined`（不是抛错：
   * "查无此人"是业务结果，不是故障）；实现必须返回副本，调用方改字段不能污染账本。
   */
  getUser(userId: UserId): Promise<User | undefined>
  listAccounts(userId: UserId): Promise<Account[]>
  balance(accountId: AccountId): Promise<Balance>
  queryTransactions(query: TxnQuery): Promise<Page<Transaction>>
  analyzeBill(query: BillQuery): Promise<BillReport>
  listWealthProducts(filter?: WealthFilter): Promise<WealthProduct[]>

  /** 试算 + 风控预检（只读）。 */
  previewTransfer(req: TransferReq): Promise<TransferPreview>
  /** 转账（写；票据核销唯一属主在 bank-core）。 */
  createTransfer(req: TransferReq, ticket: TicketRef): Promise<TransferResult>
  /** 购买理财（写；票据门禁同上）。 */
  purchaseWealth(req: PurchaseReq, ticket: TicketRef): Promise<Holding>

  /**
   * 列出用户名下全部卡片（只读）。
   *
   * 归属判定走账户：`Card` 没有 `userId`，卡的属主是它挂的账户（`core/model.ts:160-169`）。
   * 不认识的用户返回 `[]`（"没有卡"是业务结果，不是故障）；实现必须返回副本，
   * 调用方改字段不能污染账本。
   */
  listCards(userId: UserId): Promise<Card[]>

  /** 挂失银行卡（写；红档，票据门禁同上）。 */
  reportCardLost(userId: UserId, cardId: CardId): Promise<CardLostResult>
  /**
   * 冻结银行卡（写；黄档）。
   *
   * `normal → frozen`；已冻结返回 `changed: false`（幂等）；已挂失抛 `card-lost`。
   */
  freezeCard(userId: UserId, cardId: CardId): Promise<CardStateChange>
  /**
   * 解冻银行卡（写；红档）。
   *
   * `frozen → normal`；已正常返回 `changed: false`；已挂失抛 `card-lost`。
   */
  unfreezeCard(userId: UserId, cardId: CardId): Promise<CardStateChange>
  /** 取消自动扣款订阅（写；黄档，票据门禁同上）。`at-next-cycle` = 到期即断。 */
  cancelSubscription(
    userId: UserId,
    subscriptionId: SubscriptionId,
    mode?: 'now' | 'at-next-cycle',
  ): Promise<SubscriptionCancelled>

  /** 列订阅（只读；事实账本，不含检测推断）。 */
  listSubscriptions(userId: UserId): Promise<Subscription[]>
  /** 列代扣协议（只读）。 */
  listAuthorizations(userId: UserId): Promise<MerchantAuthorization[]>
  /** 关闭代扣协议（写；黄档；**只关不开**）。 */
  revokeAuthorization(userId: UserId, authorizationId: AuthorizationId): Promise<AuthorizationRevoked>
  /** 写订阅提醒/标注（写；黄档）。 */
  setSubscriptionWatch(
    userId: UserId,
    subscriptionId: SubscriptionId,
    input: SubscriptionWatch,
  ): Promise<Subscription>
  /** 记录「用户提交过取消」（写；事实，不是核验结论）。 */
  recordCancelRequest(req: Omit<CancelRequest, 'id'>): Promise<CancelRequest>
  /** 列取消请求（只读）。 */
  listCancelRequests(userId: UserId): Promise<CancelRequest[]>
  /** 即将扣款（只读；只含 active 订阅、`[now, now + withinDays]` 内）。 */
  upcomingCharges(userId: UserId, withinDays: number): Promise<UpcomingCharge[]>

  /** 风控阈值（只读视图，供工具层展示/解释用）。 */
  limits(): BankLimits
}
