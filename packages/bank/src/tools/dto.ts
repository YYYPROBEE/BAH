/**
 * 银行工具族的结果 DTO（施工单 08 §3）。
 *
 * 这一层是 **presenter / 会话事件 / 渠道** 共用的纯数据形状：
 * - 工具体返回它；
 * - `presentResult` 只把它转成 `UiCard.data`（纯函数，不查 ctx）；
 * - `read/*` / `transfer/*` / `wealth/*` 会话事件把它整块落账，
 *   渠道按「卡片 = f(事件, 持久化结果)」重建（施工单 08 §4）。
 *
 * 金额一律**整数分**（字段名带 `Cents`）：模型参数里的「元」在 `inputs.ts` 转一次。
 */

import type {
  AccountId,
  AccountStatus,
  AccountType,
  AuthorizationId,
  AuthorizationStatus,
  BillAnomaly,
  CancelVerdict,
  CardId,
  ChargeCycle,
  Confidence,
  HoldingId,
  PayeeBinding,
  ProductId,
  ProductKind,
  RecurringKind,
  RiskGrade,
  SubscriptionId,
  SubscriptionNote,
  SubscriptionStatus,
  TxnCategory,
  TxnChannel,
  TxnDirection,
  TxnId,
  TxnStatus,
} from '../core/model.ts'
import type { MerchantCategory } from '../core/merchant.ts'
import type { RiskVerdict } from '../core/provider.ts'
import type { TicketId } from '@bah/core'

/** 账户列表的一项（账号只出尾号：核心层不脱敏，展示层负责）。 */
export interface AccountView {
  readonly accountId: AccountId
  readonly tail: string
  readonly type: AccountType
  readonly status: AccountStatus
  readonly balanceCents: number
  readonly availableCents: number
}

/** `account_list` 的结果。 */
export interface AccountsResult {
  readonly accounts: readonly AccountView[]
  /** 全部可用余额合计（分）。 */
  readonly availableTotalCents: number
}

/** `account_balance` 的结果。 */
export interface BalanceResult {
  readonly accountId: AccountId
  readonly tail: string
  readonly balanceCents: number
  readonly availableCents: number
  /** 余额 − 可用（理财冻结 / 锁定等；演示数据来自账户本身）。 */
  readonly frozenCents: number
  /** 读取时刻（epoch ms）。 */
  readonly asOf: number
  /**
   * 本次工具结果的引用 ID（幻觉防护：模型转述金额时必须带上它，
   * 前端按它回查权威结果，不接受模型自造数字）。
   */
  readonly txnRef: string
}

/** `txn_query` 的一项。 */
export interface TxnView {
  readonly txnId: TxnId
  readonly at: number
  readonly amountCents: number
  readonly direction: TxnDirection
  readonly counterpartyName: string
  readonly category: TxnCategory
  readonly channel: TxnChannel
  readonly status: TxnStatus
}

/** `txn_query` 的结果（分页）。 */
export interface TxnQueryResult {
  readonly items: readonly TxnView[]
  /** 当前页码（从 1 开始；模型侧口径）。 */
  readonly page: number
  readonly limit: number
  readonly hasMore: boolean
  readonly nextCursor?: string
  /** 查询区间（epoch ms），便于审计复算。 */
  readonly from: number
  readonly to: number
}

/** 账单分类汇总的一行。 */
export interface BillCategoryLine {
  readonly category: TxnCategory
  readonly amountCents: number
  /** 占总支出的百分比（保留两位）。 */
  readonly sharePct: number
}

/** 账单收款人汇总的一行（`groupBy = 'payee'` 时给）。 */
export interface BillPayeeLine {
  readonly payee: string
  readonly amountCents: number
  readonly sharePct: number
}

/**
 * 账单商户**品类**汇总的一行（`groupBy = 'merchant'` 时给）。
 *
 * 注意这是**叙事维度**（"咖啡喝掉多少"），不是账务分类 `TxnCategory`；
 * 两层不许压成一层（见 `core/merchant.ts` 的说明）。
 */
export interface BillMerchantLine {
  readonly category: MerchantCategory
  readonly amountCents: number
  readonly sharePct: number
}

/** `bill_analyze` 的结果。 */
export interface BillAnalysisResult {
  /** `month` / `quarter` / `year`（模型给的口径）。 */
  readonly period: 'month' | 'quarter' | 'year'
  /** 参与汇总的账期（`YYYY-MM`，按时间升序）。 */
  readonly months: readonly string[]
  readonly totalInCents: number
  readonly totalOutCents: number
  /** 按金额降序（同额按分类名升序）。 */
  readonly byCategory: readonly BillCategoryLine[]
  readonly byPayee?: readonly BillPayeeLine[]
  /** `groupBy = 'merchant'` 时的品类汇总（按金额降序）。 */
  readonly byMerchantCategory?: readonly BillMerchantLine[]
  readonly anomalies: readonly BillAnomaly[]
  /** 环比（百分数；没有上期数据时缺省）。 */
  readonly momChangePct?: number
  /**
   * 环比基线账期（可能跨多个账期）。
   *
   * 年度口径**不做同比**（需 24 个月数据），因此没有基线、本字段缺省——
   * 宁可少一个字段，不拿"去年同月"去编一个不存在的对比。
   */
  readonly comparedPeriod?: string
  /** `period = 'year'` 时：有流水的账期数（用于"覆盖 N/12"的诚实声明）。 */
  readonly coveredMonths?: number
}

/** `bill_report` 的结果。 */
export interface BillReportResult {
  readonly period: 'month' | 'quarter' | 'year'
  readonly format: 'summary' | 'detail'
  /** 确定性生成的报告文本（长文本在卡片里折叠）。 */
  readonly text: string
  readonly analysis: BillAnalysisResult
}

/** `analysis_calc` 的结果。 */
export interface AnalysisResult {
  readonly code: string
  readonly value: number
  /** 求值过程中消耗的基本运算数（沙箱预算口径）。 */
  readonly operations: number
  readonly elapsedMs: number
}

/** 预检风险的一条（渠道文案用；结构与 `RiskFinding` 同形）。 */
export interface RiskView {
  readonly rule: string
  readonly severity: 'warn' | 'block'
  readonly code: string
  readonly message: string
}

/** `transfer_preview` 的结果。 */
export interface TransferPreviewResult {
  readonly amountCents: number
  readonly feeCents: number
  readonly payeeName: string
  readonly payeeBinding: PayeeBinding
  readonly payeeId?: string
  readonly dailyUsedCents: number
  readonly dailyLimitCents: number
  /** 当日剩余额度（**不含**本笔）。 */
  readonly remainingCents: number
  readonly risks: readonly RiskView[]
  readonly verdict: RiskVerdict
  /** 治理平面按「取高不取低」得出的级别（模型据此解释"为什么还要确认"）。 */
  readonly effectiveTier: 'green' | 'yellow' | 'red'
  readonly at: number
}

/** `transfer_create` 的结果。 */
export interface TransferCreatedResult {
  readonly txnId: TxnId
  readonly ticketId: TicketId
  readonly amountCents: number
  readonly feeCents: number
  readonly payeeName: string
  readonly balanceCents: number
  readonly availableCents: number
  readonly dailyUsedCents: number
  readonly dailyLimitCents: number
  readonly remainingCents: number
  readonly at: number
}

/** 理财产品视图。 */
export interface WealthProductView {
  readonly productId: ProductId
  readonly name: string
  readonly kind: ProductKind
  readonly termDays: number
  readonly expectedYieldPct: number
  readonly riskGrade: RiskGrade
  readonly minAmountCents: number
  /**
   * 客户等级是否够买（`customerRisk ≥ riskGrade`）。
   * **必填**：漏传就编译失败，比"默认放行"安全；不作为筛选条件——
   * 产品仍然展示，只是标出买不了（隐藏会被问"你们是不是把风险藏起来了"）。
   */
  readonly eligible: boolean
  /** 不可购买时的说明（`eligible=true` 时不带）。 */
  readonly suitabilityNote?: string
}

/** `wealth_list` / `wealth_compare` 的公共部分。 */
export interface WealthCatalogResult {
  readonly products: readonly WealthProductView[]
  /** 当前客户的风险承受能力（来自 `User.riskGrade` 静态画像）。 */
  readonly customerRisk: RiskGrade
  /**
   * 风险提示 ID（施工单 08 §0 第 5 条：`wealth.*` 必带）。
   * 前端必须按它渲染风险提示，不得省略。
   */
  readonly disclaimerId: string
}

/** `wealth_list` 的结果。 */
export interface WealthListResult extends WealthCatalogResult {
  readonly filter?: {
    readonly riskGrade?: RiskGrade
    readonly kind?: ProductKind
    readonly maxTermDays?: number
  }
}

/** `wealth_compare` 的结果。 */
export type WealthCompareResult = WealthCatalogResult

/**
 * `wealth_purchase` 的结果。
 *
 * `riskMatch` 是**轻量匹配留痕**（本轮不建 MatchRecord 实体）：成交时按什么客户等级
 * 匹配了什么产品等级。它随 `wealth/purchased` 载荷整块落审计链，回放时可见。
 */
export interface WealthPurchaseResult {
  readonly holdingId: HoldingId
  readonly productId: ProductId
  readonly productName: string
  readonly amountCents: number
  readonly shares: number
  readonly disclaimerId: string
  readonly at: number
  readonly riskMatch: {
    readonly customerRisk: RiskGrade
    readonly productRisk: RiskGrade
    readonly at: number
  }
}

/** 强验证结果。 */
export interface VerifyResult {
  readonly channel: 'face' | 'sms' | 'ushield'
  readonly challengeId: string
  readonly success: boolean
  readonly attempts: number
  readonly remainingAttempts: number
  /** 本次失败是否触发了会话级锁定（epoch ms）。 */
  readonly lockedUntil?: number
}

/** 卡片（`card.list` 的 P1 视图；08 只落 DTO，Provider 方法随施工单 08 的工具对齐补齐）。 */
export interface CardView {
  readonly cardId: CardId
  readonly tail: string
  readonly type: 'physical' | 'virtual'
  readonly status: 'normal' | 'frozen' | 'lost'
}

/** 订阅视图（P1）。 */
export interface SubscriptionView {
  readonly subscriptionId: SubscriptionId
  readonly merchant: string
  readonly cycle: 'weekly' | 'monthly'
  readonly nextChargeAt: number
  readonly amountCents: number
  readonly status: 'active' | 'paused' | 'cancelled'
}

/* ── 场景 5：订阅 / 代扣 ─────────────────────────────────────────────────── */

/** 已确认订阅（事实账本）的一行。 */
export interface SubscriptionItemView {
  readonly subscriptionId: SubscriptionId
  readonly merchant: string
  readonly merchantKey: string
  readonly cycle: ChargeCycle
  readonly amountCents: number
  /** 月折算（周 ×52/12；季 ÷3），用于「每月固定扣多少」。 */
  readonly monthlyCents: number
  readonly nextChargeAt: number
  readonly status: SubscriptionStatus
  readonly note?: SubscriptionNote
  readonly reminderAheadDays?: number
  readonly contractEndAt?: number
  readonly pauseUntil?: number
  readonly authorizationStatus?: AuthorizationStatus
}

/** 检测出的一条周期扣款（推断；`confidence = low` 不进清单，只进统计）。 */
export interface SubscriptionSeriesView {
  readonly merchantKey: string
  readonly displayName: string
  readonly kind: RecurringKind
  readonly cycle: ChargeCycle
  readonly amountCents: number
  readonly monthlyCents: number
  readonly confidence: Confidence
  readonly nextChargeAt: number
  /** 参与判定的扣款笔数（已剔除重复扣款与 0 元试用首期）。 */
  readonly count: number
  readonly priceHike?: { readonly fromCents: number; readonly toCents: number; readonly at: number }
  readonly priceDrop?: { readonly fromCents: number; readonly toCents: number; readonly at: number }
  readonly trialConverted?: boolean
  readonly suspectedInstallment?: boolean
  readonly matchedSubscriptionId?: SubscriptionId
}

/** 三分法汇总（**检测出的 series 口径**：月折算金额 + 条数；不是事实订阅数）。 */
export interface SpendSplitView {
  readonly subscriptionCents: number
  readonly billCents: number
  readonly installmentCents: number
  readonly subscriptionCount: number
  readonly billCount: number
  readonly installmentCount: number
}

/** 断供核验的一条（纯推导，不回写实体）。 */
export interface CutoffFindingView {
  readonly kind: 'cancel' | 'authorization'
  readonly verdict: CancelVerdict
  readonly merchantKey: string
  readonly subscriptionId?: SubscriptionId
  readonly authorizationId?: AuthorizationId
  readonly level?: 'critical'
  readonly hint: string
  readonly dueAt: number
}

/** `sub_list` 的结果。 */
export interface SubscriptionListResult {
  /** 事实：用户确认过的订阅（不含 cancelled）。 */
  readonly confirmed: readonly SubscriptionItemView[]
  /** 推断：置信度 high / medium 的周期扣款（low 只进三分法统计）。 */
  readonly detected: readonly SubscriptionSeriesView[]
  readonly spendSplit: SpendSplitView
  readonly cutoffFindings: readonly CutoffFindingView[]
  /** 推断生成时刻（事件载荷同名字段使用）。 */
  readonly detectedAt: number
  /** 取证边界（让回放能识别这是快照，不是现况）。 */
  readonly basis: { readonly from: number; readonly to: number; readonly txnCount: number }
  readonly detectorVersion: string
}
