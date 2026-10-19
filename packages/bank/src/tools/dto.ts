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
  BillAnomaly,
  CardId,
  HoldingId,
  PayeeBinding,
  ProductId,
  ProductKind,
  RiskGrade,
  SubscriptionId,
  TxnCategory,
  TxnChannel,
  TxnDirection,
  TxnId,
  TxnStatus,
} from '../core/model.ts'
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

/** `bill_analyze` 的结果。 */
export interface BillAnalysisResult {
  /** `month` / `quarter`（模型给的口径）。 */
  readonly period: 'month' | 'quarter'
  /** 参与汇总的账期（`YYYY-MM`，按时间升序）。 */
  readonly months: readonly string[]
  readonly totalInCents: number
  readonly totalOutCents: number
  /** 按金额降序（同额按分类名升序）。 */
  readonly byCategory: readonly BillCategoryLine[]
  readonly byPayee?: readonly BillPayeeLine[]
  readonly anomalies: readonly BillAnomaly[]
  /** 环比（百分数；没有上期数据时缺省）。 */
  readonly momChangePct?: number
  /** 环比基线账期（可能跨多个账期）。 */
  readonly comparedPeriod: string
}

/** `bill_report` 的结果。 */
export interface BillReportResult {
  readonly period: 'month' | 'quarter'
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
}

/** `wealth_list` / `wealth_compare` 的公共部分。 */
export interface WealthCatalogResult {
  readonly products: readonly WealthProductView[]
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

/** `wealth_purchase` 的结果。 */
export interface WealthPurchaseResult {
  readonly holdingId: HoldingId
  readonly productId: ProductId
  readonly productName: string
  readonly amountCents: number
  readonly shares: number
  readonly disclaimerId: string
  readonly at: number
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
