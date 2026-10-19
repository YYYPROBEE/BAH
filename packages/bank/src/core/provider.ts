/**
 * Provider seam（施工单 07 §2）：业务能力面与实现解耦。
 *
 * 真实对接只换 Provider——工具族（施工单 08）、审批（09）与渠道（13–15）都只依赖本接口。
 * mock 实现（`mock.ts`）不做任何 I/O：全部状态在内存，重启即回到造数初始态。
 */

import type {
  Account,
  AccountId,
  BankLimits,
  BillAnomaly,
  Holding,
  PayeeBinding,
  PayeeId,
  ProductId,
  ProductKind,
  RiskGrade,
  Transaction,
  TxnCategory,
  TxnChannel,
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
export type RiskRule = 'insufficient-balance' | 'daily-limit' | 'payee' | 'night-amount' | 'velocity'

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
 * card / subscription 的读写随施工单 08 的工具对齐补齐（本阶段只落九实体与造数）。
 */
export interface BankCoreProvider {
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

  /** 风控阈值（只读视图，供工具层展示/解释用）。 */
  limits(): BankLimits
}
