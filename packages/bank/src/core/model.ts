/**
 * 仿真银行的九实体数据模型。
 *
 * 两条纪律：
 * 1. **金额一律整数「分」**（字段名统一带 `Cents`）：浮点金额在余额、日累计、票据绑定上
 *    会累积误差，演示时对不上账；模型参数里的「元」只在工具边界用 `yuanToCents` 转一次。
 * 2. 跨边界 ID 一律品牌类型：`UserId` / `AccountId` / `CardId` / `TxnId` …
 *    与 `@bah/core` 已冻结的 `SessionId` / `TicketId` 同构，互不兼容。
 *
 * 本文件只有类型与纯函数；状态变更属 `mock.ts`（内存账本）与 `TicketStore`（票据状态机）。
 */

import type { SessionId, TicketId } from '@bah/core'
import type { Branded } from '@bah/util'

import { BahError } from '@bah/util'

/** 分页口径（core 与工具层共用，避免各写一个 100）。 */
export const PAGE_LIMIT_DEFAULT = 20
export const PAGE_LIMIT_MAX = 100

/** 中国时区固定偏移（夜间大额规则与账期展示共用）。 */
export const CN_TZ_OFFSET_MS = 8 * 60 * 60 * 1000

/** 占比（0–100，保留两位）：`part / total`；`total = 0` 返回 0。 */
export function toPct(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 10_000) / 100
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 品牌 ID（本包的铸造点见 `bankIds`）
 * ──────────────────────────────────────────────────────────────────────────── */

export type UserId = Branded<'user-id'>
export type AccountId = Branded<'account-id'>
export type CardId = Branded<'card-id'>
export type TxnId = Branded<'txn-id'>
export type PayeeId = Branded<'payee-id'>
export type ProductId = Branded<'product-id'>
export type HoldingId = Branded<'holding-id'>
export type SubscriptionId = Branded<'subscription-id'>
export type AuthorizationId = Branded<'authorization-id'>
export type CancelRequestId = Branded<'cancel-request-id'>
export type AaGroupId = Branded<'aa-group-id'>

/**
 * 品牌 ID 的铸造点。
 *
 * 造数（forge）与夹具是唯一允许"由字面量转入品牌类型"的地方；
 * 业务代码拿到 ID 后只能透传，不许再拼字符串。票据 / 会话 ID 由 `@bah/core` 铸造。
 */
export const bankIds = {
  user: (raw: string): UserId => raw as UserId,
  account: (raw: string): AccountId => raw as AccountId,
  card: (raw: string): CardId => raw as CardId,
  txn: (raw: string): TxnId => raw as TxnId,
  payee: (raw: string): PayeeId => raw as PayeeId,
  product: (raw: string): ProductId => raw as ProductId,
  holding: (raw: string): HoldingId => raw as HoldingId,
  subscription: (raw: string): SubscriptionId => raw as SubscriptionId,
  authorization: (raw: string): AuthorizationId => raw as AuthorizationId,
  cancelRequest: (raw: string): CancelRequestId => raw as CancelRequestId,
  aa: (raw: string): AaGroupId => raw as AaGroupId,
}

/** 本包会用到但由 `@bah/core` 铸造的两个 ID（这里只做类型转出口，便于使用方少 import 一行）。 */
export type { SessionId, TicketId }

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 金额（整数分）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 元 → 分（按十进制四舍五入到整数分）；非法输入 fail-loud。 */
export function yuanToCents(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new BahError('money-invalid', `bank: 金额必须是有限非负数（收到 ${String(value)}）`, {
      value,
    })
  }
  // 不能用 `Math.round(value * 100)`：`1.005 * 100 === 100.49999999999999`，
  // 会舍成 100 分（少 1 分）。转成十进制指数形式再取整，让"元"的十进制字面值说了算。
  // 极小/极大值在 `String()` 里会带 `e`，拼 `${value}e2` 不合法，退回乘法后由安全整数兜底。
  const text = String(value)
  const cents =
    text.includes('e') || text.includes('E')
      ? Math.round(value * 100)
      : Math.round(Number(`${text}e2`))
  if (!Number.isSafeInteger(cents)) {
    throw new BahError('money-invalid', `bank: 金额超出可精确表示的范围（收到 ${String(value)}）`, {
      value,
      cents,
    })
  }
  return cents
}

/** 分 → 元（只用于展示，不参与账本计算）。 */
export function centsToYuan(cents: number): number {
  return cents / 100
}

/** 分 → `¥12,345.67`（不依赖 locale，跨平台逐字一致）。 */
export function formatYuan(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const yuan = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}¥${yuan}.${String(abs % 100).padStart(2, '0')}`
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. 九实体
 * ──────────────────────────────────────────────────────────────────────────── */

/** 风险等级 R1–R5（用户与理财产品共用一套词汇）。 */
export type RiskGrade = 'R1' | 'R2' | 'R3' | 'R4' | 'R5'

/**
 * 五题总分（5–25）→ 客户风险等级。
 *
 * **唯一实现**：`MockBankCore.assessRisk` 与审批明细（`tools/approval-details.ts`）
 * 都调这里。审批卡要提前告诉用户"批完会变成几级"，但它不能另抄一份分段阈值——
 * 那就成了第二份真相源，改一处必漏另一处。
 */
export function riskGradeOfScore(score: number): RiskGrade {
  return score <= 8 ? 'R1' : score <= 12 ? 'R2' : score <= 16 ? 'R3' : score <= 20 ? 'R4' : 'R5'
}

/** 强验证方式（红级工具挑战渠道）。 */
export type StrongAuth = 'face' | 'sms' | 'ushield'

export interface User {
  readonly id: UserId
  readonly name: string
  readonly phone: string
  readonly riskGrade: RiskGrade
  /** 实名状态。 */
  readonly verified: boolean
  /** 强验证方式。 */
  readonly strongAuth: StrongAuth
}

export type AccountType = 'current' | 'fixed' | 'locked'
export type AccountStatus = 'active' | 'frozen' | 'closed'

export interface Account {
  readonly id: AccountId
  readonly userId: UserId
  /** 账号（展示时由渠道脱敏，核心层不脱敏）。 */
  readonly number: string
  readonly type: AccountType
  readonly balanceCents: number
  readonly availableCents: number
  readonly status: AccountStatus
}

/** 账户类型文案（唯一来源；`tools/presenters.ts` 从此处再导出，不重复一份）。 */
export const ACCOUNT_TYPE_LABEL: Readonly<Record<AccountType, string>> = {
  current: '活期',
  fixed: '定期',
  locked: '锁定',
}

/**
 * 本人账户的展示名（`锁定账户(9012)`）。
 *
 * 内部划转的命中口径：核心的命中判定与演示/文档里的称呼必须共用这一个函数——
 * 两处各写一份字符串，改名那天就会一边转得出去、一边看不懂。
 */
export function accountDisplayName(account: Account): string {
  const digits = account.number.replace(/\s+/g, '')
  return `${ACCOUNT_TYPE_LABEL[account.type]}账户(${digits.slice(-4)})`
}

export type CardType = 'physical' | 'virtual'
export type CardStatus = 'normal' | 'frozen' | 'lost'

/** 交易限制的范围：线上 / 境外 / 指定商户品类。 */
export type CardRestrictionKind = 'online' | 'overseas' | 'category'

/** 一条卡片交易限制（与卡片状态 `frozen` 不同：这是规则层，不是整卡停用）。 */
export interface CardRestriction {
  readonly kind: CardRestrictionKind
  /**
   * `category` 时的品类值（对齐 `MerchantCategory` 的键：dining / coffee / …）；
   * 其余 kind 缺省。只在 `spendOnCard` 的卡消费路径上判定，转账路径没有品类语义。
   */
  readonly value?: string
  readonly note?: string
  readonly at: number
}

export interface Card {
  readonly id: CardId
  readonly accountId: AccountId
  /** 卡号尾号（只存尾号，核心层不持有完整卡号）。 */
  readonly tail: string
  readonly type: CardType
  readonly status: CardStatus
  readonly dailyLimitCents: number
  readonly monthlyLimitCents: number
  /**
   * 卡产品：借记（缺省）/ 信用（ADR-0015）。信用产品才有授信额度。
   *
   * **不是 `type`**：`type` 是**介质**（实体/虚拟），与"借记/信用"正交；
   * 把 `'credit'` 塞进 `type` 会让"虚拟信用卡"无法表达。
   */
  readonly kind?: CardKind
  /** 授信额度（分）；仅 `kind='credit'` 有意义。 */
  readonly creditLimitCents?: number
  /** 已用额度（分）；仅 `kind='credit'` 有意义。可用额度是它的派生值，不落字段。 */
  readonly usedCreditCents?: number
  /** 交易限制规则（可选；空数组/缺省 = 无限制）。 */
  readonly restrictions?: readonly CardRestriction[]
}

/** 卡产品（缺省 = 借记：老造数/老快照里的卡没有 `kind`，按借记解释）。 */
export type CardKind = 'debit' | 'credit'

export type TxnDirection = 'in' | 'out'
export type TxnCategory =
  | 'transfer'
  | 'salary'
  | 'consumption'
  | 'subscription'
  | 'wealth'
  | 'fee'
  | 'refund'
export type TxnChannel = 'app' | 'web' | 'counter' | 'atm' | 'im'
export type TxnStatus = 'success' | 'failed' | 'pending'

/** 交易对手（转账 / 消费的对方）。 */
export interface Counterparty {
  readonly name: string
  readonly phone?: string
  readonly memo?: string
}

export interface Transaction {
  readonly id: TxnId
  readonly accountId: AccountId
  /** 发生时刻（epoch ms）。 */
  readonly at: number
  readonly amountCents: number
  readonly direction: TxnDirection
  readonly counterparty: Counterparty
  readonly category: TxnCategory
  readonly channel: TxnChannel
  readonly status: TxnStatus
  /**
   * 本笔以哪张卡支付（可选）。
   *
   * 月限额按卡归集，没有这个字段就无法区分"两张卡各刷一半"；冲正流水继承原值
   * （否则月累计的减法永远减不掉）。老造数与账户级转账不填。
   */
  readonly viaCardId?: CardId
  /** 冲正流水指向的原交易（W12）：只有冲正流水带这个字段，原交易永不被删改。 */
  readonly reversalOf?: TxnId
}

/** 账单异常标记。 */
export interface BillAnomaly {
  readonly kind: 'large' | 'late-night' | 'duplicate'
  readonly txnId: TxnId
  readonly note: string
}

export interface Bill {
  /** 账期（`YYYY-MM`，UTC）。 */
  readonly period: string
  readonly totalInCents: number
  readonly totalOutCents: number
  readonly byCategory: Readonly<Partial<Record<TxnCategory, number>>>
  readonly anomalies: readonly BillAnomaly[]
}

export type ProductKind = 'deposit' | 'fixed' | 'fund'

export interface WealthProduct {
  readonly id: ProductId
  readonly name: string
  readonly kind: ProductKind
  /** 期限（天）。 */
  readonly termDays: number
  /** 预期年化（百分数，如 3.2 表示 3.2%）。 */
  readonly expectedYieldPct: number
  readonly riskGrade: RiskGrade
  readonly minAmountCents: number
}

export interface Holding {
  readonly id: HoldingId
  readonly userId: UserId
  readonly productId: ProductId
  /** 购买时使用的账户（缺省 = 主活期；赎回退回该账户）。 */
  readonly accountId?: AccountId
  /** 份额（演示口径：按 1 元/份，允许两位小数）。 */
  readonly shares: number
  readonly costCents: number
  readonly marketValueCents: number
  readonly profitCents: number
}

export type ChargeCycle = 'weekly' | 'monthly' | 'quarterly'
export type SubscriptionStatus = 'active' | 'paused' | 'cancelled'

/** 订阅的用户标注（替代不存在的"使用频次"数据）。 */
export type SubscriptionNote = 'idle' | 'hesitating'

export interface Subscription {
  readonly id: SubscriptionId
  readonly userId: UserId
  readonly merchant: string
  readonly cycle: ChargeCycle
  readonly nextChargeAt: number
  readonly amountCents: number
  readonly status: SubscriptionStatus
  /** 与 `MerchantAuthorization` / `RecurringSeries` 同一套归一化键；缺省时按 `merchant` 现算。 */
  readonly merchantKey?: string
  /** 合约期；有值且 > now 即「不可快刀」（只给「到期即断」）。 */
  readonly contractEndAt?: number
  readonly authorizationId?: AuthorizationId
  /** 用户标注：`idle` = 我不用了；`hesitating` = 还在犹豫。 */
  readonly note?: SubscriptionNote
  /** 续费提醒提前量（1..7 天）；`remind` 标记的实际载荷。 */
  readonly reminderAheadDays?: number
  /** 「到期即断」的截止时刻：`status = 'paused'` 时置位。 */
  readonly pauseUntil?: number
}

/**
 * AA 收款参与人的状态。
 *
 * `pending` 待表态 / `paid` 已代收 / `declined` 明确拒绝 / `expired` 到期未付。
 * 后两态是 ADR-0017 新增：**钱没进来**，与 `paid` 不是同一回事——对账时必须分得开。
 */
export type AaParticipantStatus = 'pending' | 'paid' | 'declined' | 'expired'
export type AaGroupStatus = 'collecting' | 'completed' | 'cancelled'

/** 建组缺省收款窗口（小时）；到期 job 按 `expiresAt` 收口。 */
export const AA_DEFAULT_EXPIRY_HOURS = 72

/** 建组收款窗口上限（小时）。更长就该走"授权窗口"，不是 AA 组。 */
export const AA_MAX_EXPIRY_HOURS = 168

/** AA 收款参与人。 */
export interface AaParticipant {
  readonly name: string
  readonly phone?: string
  readonly shareCents: number
  readonly status: AaParticipantStatus
  readonly paidAt?: number
}

/** AA 收款请求（组织者 + 参与人份额）。 */
export interface AaGroup {
  readonly id: AaGroupId
  readonly userId: UserId
  readonly title: string
  readonly totalCents: number
  readonly participants: readonly AaParticipant[]
  readonly status: AaGroupStatus
  readonly createdAt: number
  /**
   * 收款截止时刻（epoch ms）。缺省 = 建组时 + {@link AA_DEFAULT_EXPIRY_HOURS} 小时。
   *
   * 可选是为了兼容本次改动之前落在内存里的组（它们没有截止时间，到期 job 跳过）。
   */
  readonly expiresAt?: number
}

/** 周期扣款三分法（只影响展示与取消路径建议，不影响是否检出）。 */
export type RecurringKind = 'subscription' | 'bill' | 'installment'/** 检测置信度分层。 */
export type Confidence = 'high' | 'medium' | 'low'
/** 代扣协议状态（**只关不开**：恢复扣款要商户侧重新签约）。 */
export type AuthorizationStatus = 'active' | 'revoked'
/** 取消路径：银行侧关协议 / 商户侧自助 / 只能人工。 */
export type CancelPath = 'authorize' | 'merchant' | 'manual'
/**
 * 取消核验结论（**推导值**，不落库）：
 * - `pending`：还没到核验窗口；
 * - `effective`：过了核验窗口且没有新扣款；
 * - `failed`：取消后仍有扣款（升级争议工单）；
 * - `breached`：协议已关仍扣款（critical）。
 */
export type CancelVerdict = 'pending' | 'effective' | 'failed' | 'breached'

/**
 * 代扣协议（硬断供的实体）。
 *
 * `merchant` 只用于展示（可含脏名）；`merchantKey` 才是关联/统计的唯一键——
 * 否则「关协议影响几个订阅」会按脏名精确匹配算出 0，硬断供的证据链当场断。
 */
export interface MerchantAuthorization {
  readonly id: AuthorizationId
  readonly userId: UserId
  readonly merchant: string
  readonly merchantKey: string
  /** 协议号（展示时可脱敏到后 4 位）。 */
  readonly agreementNo: string
  readonly accountId: AccountId
  readonly status: AuthorizationStatus
  readonly signedAt: number
  readonly revokedAt?: number
}

/**
 * 取消请求（状态机；「已提交 ≠ 已生效」）。
 *
 * 只持久化「用户提交过取消」这一事实；生效与否由流水现算（`deriveCutoffFindings`），
 * 不回写——查询是绿档，不能在读路径上做状态迁移。
 */
export interface CancelRequest {
  readonly id: CancelRequestId
  readonly userId: UserId
  readonly subscriptionId: SubscriptionId
  readonly path: CancelPath
  /** `at-next-cycle` = 到期即断：置 `Subscription.status='paused'` + `pauseUntil`。 */
  readonly mode: 'now' | 'at-next-cycle'
  readonly requestedAt: number
  /** A 档即时；B/C 档 +2~10 天（诚实口径）。 */
  readonly expectedEffectiveAt: number
  /** 下期扣款 +3 天：过了还没扣 = 生效。 */
  readonly verifyBy: number
}

/** 检测产出（推断，不落账，每次重算）。 */
export interface RecurringSeries {
  readonly merchantKey: string
  /** 展示名（原始商户名里最干净的那个）。 */
  readonly displayName: string
  readonly kind: RecurringKind
  readonly cycle: ChargeCycle
  /** 最近一期金额（分）。 */
  readonly amountCents: number
  readonly instances: readonly { txnId: TxnId; at: number; amountCents: number }[]
  readonly confidence: Confidence
  readonly nextChargeAt: number
  readonly priceHike?: { fromCents: number; toCents: number; at: number }
  readonly priceDrop?: { fromCents: number; toCents: number; at: number }
  /** 弱信号：等额 6/12/24 期但无分期强特征（展示「疑似分期，确认一下」）。 */
  readonly suspectedInstallment?: boolean
  /** 首期 0 元试用 → 次期转正收费。 */
  readonly trialConverted?: boolean
  /** 与事实库对上才有。 */
  readonly matchedSubscriptionId?: SubscriptionId
}

/** 收款人绑定关系：白名单（老熟人）/ 新收款人（演示"升红"规则的素材）。 */
export type PayeeBinding = 'whitelist' | 'new'

export interface Payee {
  readonly id: PayeeId
  readonly userId: UserId
  readonly name: string
  readonly phone?: string
  readonly binding: PayeeBinding
  /** 首次出现时刻（白名单判定与"首笔"话术用）。 */
  readonly firstSeenAt: number
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. 风控阈值（可调项一律配置化， 第 4 条）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * mock 侧风控预检阈值。
 *
 * 这些是**数据侧**阈值，与 Harness 治理平面的工具 tier 互相冗余：
 * 核心在 `previewTransfer` 里先给业务解释，治理平面再按 tier 决定 ask / deny。
 */
export interface BankLimits {
  /** 单日转账上限（分）；卡上没配日限额时用它兜底。 */
  readonly dailyTransferLimitCents: number
  /** 夜间时段起点（本地小时，含）。 */
  readonly nightStartHour: number
  /** 夜间时段终点（本地小时，不含）。 */
  readonly nightEndHour: number
  /** 夜间大额阈值（分）。 */
  readonly nightLargeCents: number
  /** 短时高频窗口（毫秒）。 */
  readonly velocityWindowMs: number
  /** 窗口内允许的成功转出笔数上限。 */
  readonly velocityMaxCount: number
  /** 账单里"大额"异常阈值（分）。 */
  readonly billLargeCents: number
}
