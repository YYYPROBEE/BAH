/**
 * Provider seam：业务能力面与实现解耦。
 *
 * 真实对接只换 Provider——工具族、审批（09）与渠道（13–15）都只依赖本接口。
 * mock 实现（`mock.ts`）不做任何 I/O：全部状态在内存，重启即回到造数初始态。
 */

import type {
  AaGroup,
  AaGroupId,
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
  CardRestrictionKind,
  CardStatus,
  CardType,
  ChargeCycle,
  Holding,
  HoldingId,
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
  TxnId,
  User,
  UserId,
  WealthProduct,
} from './model.ts'
import type { RiskAnswer, RiskQuestionnaire } from './risk-questionnaire.ts'
import type { MerchantCategory } from './merchant.ts'
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

/** 交易查询条件。 */
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

/** 账单报告。 */
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

/** 风控规则名。 */
export type RiskRule =
  | 'insufficient-balance'
  | 'daily-limit'
  | 'payee'
  | 'night-amount'
  | 'velocity'
  | 'duplicate'
  | 'card-status'
  | 'card-restriction'
  | 'card-monthly-limit'

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
   * 给了就必须属于 `fromAccountId` 且状态为 `normal`；同时参与卡状态、online/overseas 限制与
   * **同卡近 30 天月限额**判定。不传 = 账户转账（原语义逐字不变，也不吃卡月限额）。
   */
  readonly viaCardId?: CardId
}

/** 试算 + 风控预检结果（当日已累计与剩余额度是权威口径）。 */
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

/** 赎回请求：`holdingId` 与 `productId` 二选一；`amountCents` 缺省 = 全部赎回。 */
export interface RedeemReq {
  readonly userId: UserId
  readonly holdingId?: HoldingId
  readonly productId?: ProductId
  readonly amountCents?: number
}

/** 赎回结果。 */
export interface RedeemResult {
  readonly holdingId: HoldingId
  readonly productId: ProductId
  readonly productName: string
  readonly amountCents: number
  readonly shares: number
  readonly txnId: Transaction['id']
  readonly balanceCents: number
  readonly availableCents: number
  readonly at: number
}

/**
 * 风险测评结果（客户等级是核心主数据；测评会改变后续申购的适当性判定）。
 *
 * `questionnaireId / version / answers` 是 C-03 的修复面：结果必须能追回**哪张卷、
 * 哪一版题、用户选了哪三项**，否则「风险等级由客户本人填写的问卷决定」这句话
 * 在审计上无法证实。`answers` 是键而不是分值——分值只在服务端常量表里。
 */
export interface RiskAssessment {
  /** 本次落档依据的问卷实例（一次性凭证，落档即核销）。 */
  readonly questionnaireId: string
  /** 题目版本（题干/分值一改就变）。 */
  readonly version: string
  /** 用户逐题所选的**选项键**（不是分值：分值由服务端常量表决定）。 */
  readonly answers: readonly RiskAnswer[]
  readonly score: number
  readonly from: RiskGrade
  readonly to: RiskGrade
  readonly at: number
}

/** AA 收款创建入参（参与者的份额已按分算好）。 */
export interface AaCreateReq {
  readonly userId: UserId
  readonly title: string
  readonly totalCents: number
  readonly participants: readonly {
    readonly name: string
    readonly phone?: string
    readonly shareCents: number
  }[]
  /** 收款窗口（小时，1–168）；缺省 72。 */
  readonly expiresInHours?: number
}

/**
 * AA 模拟代收请求（demo 口径）。
 *
 * **不是真实到账**：本进程替参与人把那一份"记进"组织者主账户，并写一条
 * `in / transfer` 流水。跨人真实收款需要行内清算接口，本仓没有。
 *
 * `participant` 只接受**姓名或序号**，不收手机号：手机号既是 PII，又会在
 * 同组同名/改号时变成第二真相源（同一份额被两个键指向）。
 */
export interface AaCollectReq {
  readonly userId: UserId
  readonly groupId: AaGroupId
  /** 姓名（精确匹配）或序号（0 起；任务层把 `"0"` 这类数字串解析成序号）。 */
  readonly participant: number | string
}

/** 代收结果：组的最新态 + 本次入账金额与流水 + 命中的参与人序号（事件要记它）。 */
export interface AaCollectResult {
  readonly group: AaGroup
  readonly participantIndex: number
  readonly collectedCents: number
  readonly txnId: TxnId
}

/** 参与人表态请求（`decline`）：定位规则与 `collect` 完全一致（姓名或 0 基序号）。 */
export interface AaParticipantActionReq {
  readonly userId: UserId
  readonly groupId: AaGroupId
  readonly participant: number | string
}

/** 组织者提前结束请求。 */
export interface AaCloseReq {
  readonly userId: UserId
  readonly groupId: AaGroupId
}

/**
 * 收口结果（`decline` / `close` / 到期共用）。
 *
 * `affected` 是本次真正发生 `pending → declined/expired` 的参与人序号：
 * 重复拒绝或组内已无 pending 时为空数组（幂等，不重复落事件）。
 */
export interface AaSettlementResult {
  readonly group: AaGroup
  readonly affected: readonly number[]
  /** 收口时刻（注入钟）。 */
  readonly at: number
}

/**
 * 业务能力面。
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

/** 申请卡片的入参（`accountId` 缺省 = 主活期账户）。 */
export interface CardApplyReq {
  readonly userId: UserId
  readonly accountId?: AccountId
  readonly type?: CardType
  readonly dailyLimitCents?: number
  readonly monthlyLimitCents?: number
  /** 卡产品（缺省 = 借记；ADR-0015）。 */
  readonly kind?: CardKind
  /** 授信额度（分）：`kind='credit'` 时必填，借记卡给它是参数错（`credit-not-applicable`）。 */
  readonly creditLimitCents?: number
}

/** 新卡回执（信用产品才带 `kind` / 授信三件套；借记卡形状与改动前逐字一致）。 */
export interface CardIssued {
  readonly cardId: CardId
  readonly accountId: AccountId
  readonly tail: string
  readonly type: CardType
  readonly status: 'normal'
  readonly dailyLimitCents: number
  readonly monthlyLimitCents: number
  readonly kind?: CardKind
  readonly creditLimitCents?: number
  readonly usedCreditCents?: number
}

/** 额度调整补丁（至少一项：日限 / 月限 / 授信额度）。 */
export interface CardLimitPatch {
  readonly dailyLimitCents?: number
  readonly monthlyLimitCents?: number
  /** 授信额度（分）：仅 `kind='credit'` 的卡接受；不得低于已用（ADR-0015）。 */
  readonly creditLimitCents?: number
}

/** 额度调整回执。 */
export interface CardLimitsChanged {
  readonly cardId: CardId
  readonly tail: string
  readonly dailyLimitCents: number
  readonly monthlyLimitCents: number
  readonly changed: boolean
  readonly kind?: CardKind
  /** 变更后的授信额度（仅信用产品）。 */
  readonly creditLimitCents?: number
  /** 变更时的已用额度（仅信用产品；降额不得低于它）。 */
  readonly usedCreditCents?: number
}

/** 交易限制写入面（set 增加/替换，clear 按 kind/value 删除）。 */
export interface CardRestrictionInput {
  readonly mode: 'set' | 'clear'
  readonly kind?: CardRestrictionKind
  readonly value?: string
  readonly note?: string
}

/** 交易限制回执。 */
export interface CardRestrictionChange {
  readonly cardId: CardId
  readonly tail: string
  readonly restrictions: readonly CardRestriction[]
  readonly changed: boolean
}

/**
 * 卡消费请求（`spendOnCard`；B-03 的品类拦截落点）。
 *
 * 金额是**商户报价**（分），不是模型给的上限；`merchantCategory` 来自商户目录，
 * 不是模型自由文本。`idempotencyKey` 由调用方给，同键同参数只扣一次。
 */
export interface CardSpendReq {
  readonly userId: UserId
  readonly cardId: CardId
  readonly merchantCategory: MerchantCategory
  readonly amountCents: number
  /** 账本对手方展示名（mock 口径；真实收单会有商户号）。 */
  readonly memo?: string
  readonly idempotencyKey?: string
}

/** 卡消费回执（含当日/近 30 天卡口径的已用与限额）。 */
export interface CardSpendResult {
  readonly cardId: CardId
  readonly tail: string
  readonly txnId: Transaction['id']
  readonly merchantCategory: MerchantCategory
  readonly amountCents: number
  readonly memo?: string
  /** 同卡、同 UTC 日的转出 + 消费（减冲正）。 */
  readonly dailyUsedCents: number
  readonly dailyLimitCents: number
  /** 同卡、近 30 天滚动窗口的转出 + 消费（减冲正）。 */
  readonly monthlyUsedCents: number
  readonly monthlyLimitCents: number
  readonly balanceCents: number
  readonly availableCents: number
  readonly at: number
}

/**
 * 交易密码交接票据（ADR-0014）。
 *
 * 为什么"交办"而不是"代改"：工具入参会被 `tool/call.args` **全量**写进 `session.jsonl`，
 * 把密码放进入参等于把用户密码写进审计日志。所以 Agent 只发起改密、拿一张一次性票据，
 * 明文只在**渠道安全页的表单**里提交一次（端点见 §2 of ADR-0014）。
 */
export interface PasswordHandoff {
  /** 一次性票据 ID（`pwd:<callId>`）。 */
  readonly ticketId: string
  /** 安全页路径（明文只在这里提交）。 */
  readonly handoffPath: string
  /** 票据过期时刻（epoch ms）。 */
  readonly expiresAt: number
  /** 签发时刻（注入钟）。 */
  readonly at: number
}

/** 交易密码状态（`read/password-status` 的数据源；**不含任何密码材料**）。 */
export interface PasswordStatus {
  /** 最后一次改密时刻；从未改过为 `null`。 */
  readonly lastChangedAt: number | null
  /** 剩余可尝试次数（锁定中为 0）。 */
  readonly remainingAttempts: number
}

/** 改密回执（ADR-0014：**不得**出现旧密码/新密码/哈希/盐/任何明文变形）。 */
export interface PasswordChanged {
  readonly changedAt: number
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
  /** 列持仓（只读；返回副本）。 */
  listHoldings(userId: UserId): Promise<Holding[]>
  /** 赎回理财（写；票据核销；缺省全额赎回）。 */
  redeemWealth(req: RedeemReq, ticket: TicketRef): Promise<RedeemResult>
  /**
   * 下发一张风险测评问卷（只读：不写主体等级、不产生落档）。
   *
   * 题目与分值来自服务端常量表（`risk-questionnaire.ts`），**不经模型**；
   * 返回的实例带 ID 与到期时刻，客户端只能拿它去 `assessRisk` 提交。
   */
  issueRiskQuestions(userId: UserId): Promise<RiskQuestionnaire>
  /** 按 ID 取问卷（只读副本；不存在返回 `undefined`）。 */
  getRiskQuestionnaire(questionnaireId: string): Promise<RiskQuestionnaire | undefined>
  /**
   * 风险测评落档（写：更新客户风险等级）。
   *
   * 入参必须是**服务端签发过的** `questionnaireId` + 逐题 `{index, key}`；
   * 核心负责存在性/归属/过期/齐全/选项五道校验，任一不满足抛结构化错误，
   * 等级保持不变（模型不持有合法问卷 ID 就落不了档）。
   */
  assessRisk(req: {
    readonly userId: UserId
    readonly questionnaireId: string
    readonly answers: readonly { readonly index: number; readonly key: string }[]
  }): Promise<RiskAssessment>
  /** 创建 AA 收款请求（写；只生成份额与待收状态，不伪造到账）。 */
  createAa(req: AaCreateReq): Promise<AaGroup>
  /** 查询 AA 收款请求（只读；不存在/非本人返回 `undefined`）。 */
  getAa(userId: UserId, groupId: AaGroupId): Promise<AaGroup | undefined>
  /**
   * 模拟代收（**demo 口径**，不是真实到账）：把某一位参与人的份额记进组织者主账户。
   *
   * 五道校验顺序固定：组归属 → 组 `collecting` → 参与人存在 → 未付过 → 记账。
   * 任一步失败都不改账本、不改组状态（用户可修正后重试）。
   * 全部 `paid` ⇒ 组 `completed`；重复代收返回 `aa-participant-paid`（幂等错误）。
   */
  collectAa(req: AaCollectReq): Promise<AaCollectResult>
  /**
   * 参与人明确拒绝（`pending → declined`）。
   *
   * 已拒绝 → 幂等返回（`affected` 为空，不改任何状态）；已付 → `aa-participant-paid`
   * （钱已经记进来，拒绝不是退款流程）；已过期 → `aa-participant-closed`。
   */
  declineAa(req: AaParticipantActionReq): Promise<AaSettlementResult>
  /**
   * 组织者提前结束：剩余 `pending` 全部转 `expired` 并按收口规则定组状态。
   *
   * 组不在 `collecting` → `aa-group-closed`；重复 close 不会把已 `completed`
   * 的组改回 `cancelled`（组状态是账本结论，不是可反复覆盖的 UI 字段）。
   */
  closeAa(req: AaCloseReq): Promise<AaSettlementResult>
  /**
   * 到期扫描（tick job 调用）：`status='collecting' && expiresAt < at` 的组按同一收口规则结束。
   *
   * 没有 `expiresAt` 的历史组跳过；已收口的组不会再次出现，天然只处理一次。
   */
  expireAaGroups(at: number): Promise<readonly AaSettlementResult[]>

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
  /** 申请一张新卡（写；黄档）。缺省虚拟卡，挂在主活期账户下。 */
  applyCard(req: CardApplyReq): Promise<CardIssued>
  /** 调整卡额度（写；红档）。至少给一项；日限额不得高于月限额。 */
  setCardLimits(userId: UserId, cardId: CardId, patch: CardLimitPatch): Promise<CardLimitsChanged>
  /** 设置 / 解除交易限制（写；黄档）。`clear` 不传 kind 时清空该卡全部限制。 */
  setCardRestriction(
    userId: UserId,
    cardId: CardId,
    input: CardRestrictionInput,
  ): Promise<CardRestrictionChange>
  /**
   * 以卡消费（写；mock 收单通道，不是真实收单）。
   *
   * 校验顺序固定：卡存在且属于该用户 → 卡状态 normal → online 限制 → category 限制 →
   * 日/月限额 → 账户可用余额。失败一律在记账之前抛出，账本不变。
   */
  spendOnCard(req: CardSpendReq): Promise<CardSpendResult>
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

  /* ── 交易密码（ADR-0014） ───────────────────────────────────────────────── */

  /**
   * 签发一次性改密交接票据（**写**；先核销审批票据）。
   *
   * @param req `ticketId` 由工具按 `pwd:<callId>` 派生，`ttlMs` 是交接窗口
   * @param approval 治理面签发并已批准的审批票据（红档；缺票据应抛 `ticket-missing`）
   * @throws `ticket-*`（审批票据核销失败）/ `user-unknown`
   */
  requestPasswordChange(
    userId: UserId,
    req: { readonly ticketId: string; readonly ttlMs: number },
    approval: TicketRef,
  ): Promise<PasswordHandoff>
  /**
   * 校验交接票据（**只读**，不核销）。
   *
   * 四种失败各有独立理由码：`password-ticket-unknown` / `password-ticket-expired` /
   * `password-ticket-foreign`（不是这个用户的票）/ `password-ticket-used`（一次性）。
   * 分开报码不是为了给前端看，而是为了让审计能区分"猜票号"与"重放自己的票"。
   */
  checkPasswordHandoff(ticketId: string, userId: UserId): Promise<PasswordHandoff>
  /** 核销交接票据（改密成功后才调用；票据从此不可再用）。 */
  consumePasswordHandoff(ticketId: string): Promise<void>
  /**
   * 修改交易密码（**写**）。
   *
   * 校验顺序固定（先便宜后贵）：长度 8–20 → 同时含字母与数字 → 新 ≠ 旧 → 旧密码比对。
   * 前三步抛 `password-invalid`，第四步抛 `password-mismatch`；连续 3 次旧密码不匹配后
   * 抛 `password-locked`（窗口见 `TXN_PASSWORD_LOCK_MS`）。**格式错不计入失败次数**。
   */
  changeTxnPassword(
    userId: UserId,
    oldPassword: string,
    newPassword: string,
  ): Promise<PasswordChanged>
  /**
   * 校验交易密码（**只读**：不累加失败计数、不锁定）。
   *
   * 计数只发生在 `changeTxnPassword`——把它留在这里会让"任何能调这个方法的代码"
   * 都能把用户锁死。
   */
  checkTxnPassword(userId: UserId, password: string): Promise<boolean>
  /** 交易密码状态（**只读**；`read/password-status` 的数据源）。 */
  passwordStatus(userId: UserId): Promise<PasswordStatus>
}
