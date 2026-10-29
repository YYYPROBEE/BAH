/**
 * 银行领域的 durable 会话事件（施工单 03 §1.2 的领域族 + 施工单 08 §2 的「落账事件」列）。
 *
 * 为什么由本包声明：施工单 03 定的规矩是「`transfer/*`、`wealth/*`、`verify/*` 等
 * 领域事件由各自插件包用同一个增强机制追加」。`@bah/core` 的 `SessionEventMap`
 * 留了索引签名，这里用 `declare module` 补成逐键声明，不修改冻结文件。
 *
 * 两条纪律：
 * 1. **事件载荷就是卡片的数据源**（施工单 08 §4「卡片从事件派生」）：
 *    `result` 整块落账，渠道不依赖工具返回值的临时变量；
 * 2. 事件名只允许出现在 `BANK_SESSION_EVENT_TYPES` 里——`verify-session-events` 门禁会扫
 *    `audit.append('…')` 的字面量，并读取本文件的增强块。
 */

import type {
  AccountsResult,
  AnalysisResult,
  BalanceResult,
  BillAnalysisResult,
  BillReportResult,
  TransferCreatedResult,
  TransferPreviewResult,
  TxnQueryResult,
  VerifyResult,
  WealthListResult,
  WealthCompareResult,
  WealthPurchaseResult,
} from './dto.ts'
import type { SessionId, ToolTierLevel } from '@bah/core'

import type { IdentityBoundData } from './identity.ts'
import type { PolicyEvidence } from './policy.ts'
import type { TierReason } from './tier.ts'

/** 银行领域事件的数据表（`SessionEventMap` 的增强内容）。 */
export interface BankSessionEventMap {
  /** 会话已绑定银行用户（施工单 09 §4；回放时据此恢复身份）。 */
  'identity/bound': IdentityBoundData
  /** 三级判决已作出（允许 / 需审批 / 拒绝 + 理由码；施工单 09 §1.2 的审计落点）。 */
  'tier/decided': {
    /** 调用 ID。 */
    readonly callId: string
    /** 工具名。 */
    readonly name: string
    /** 判定出的生效级别（未绑定身份 / sentry 先拒等早期拒绝时为声明级别）。 */
    readonly level: ToolTierLevel
    /** 升级 / 追加理由。 */
    readonly reason: TierReason
    /** 判决种类。 */
    readonly verdict: 'allow' | 'ask' | 'deny'
    /** 拒绝理由码（`no-identity` / `verify-locked` / 预检失败码）。 */
    readonly code?: string
    /** 判决时刻（注入时钟）。 */
    readonly at: number
    /**
     * 策略版本（策略外置 S2）。legacy 判决写 `legacy`，bundle 写
     * `name/version+sha256:<16>`；早拒路径写"当前生效版本"（不是空串）。
     */
    readonly policyVersion?: string
    /** 命中的规则 ID（含默认行）；legacy 与早拒路径为 `[]`。 */
    readonly ruleIds?: readonly string[]
    /** 参数摘要（`sha256:<64 hex>`）：回答"当时用的哪组阈值"。 */
    readonly paramsDigest?: string
    /** 判决来源：`legacy`（tier.ts）| `bundle`（外置规则）。 */
    readonly engineSource?: 'legacy' | 'bundle'
    /** 判决证据（仅 bundle 模式；去 PII，只含枚举与整数分）。 */
    readonly evidence?: PolicyEvidence
  }
  /** 账户列表已读取。 */
  'read/accounts': { readonly result: AccountsResult }
  /** 余额已读取（`txnRef` 是幻觉防护引用）。 */
  'read/balance': { readonly result: BalanceResult }
  /** 交易流水已读取。 */
  'read/txns': { readonly result: TxnQueryResult }
  /** 账单分析已完成。 */
  'read/bill-analyzed': { readonly result: BillAnalysisResult }
  /** 账单报告已生成。 */
  'read/bill-report': { readonly result: BillReportResult }
  /** 受限计算已完成（代码与结果一起落账，可回放）。 */
  'read/analysis': { readonly result: AnalysisResult }
  /** 理财产品列表 / 对比已读取（`disclaimerId` 在内）。 */
  'read/wealth': {
    readonly op: 'list' | 'compare'
    readonly result: WealthListResult | WealthCompareResult
  }
  /** 转账试算（含风控预检与生效级别）。 */
  'transfer/preview': { readonly result: TransferPreviewResult }
  /** 转账已创建（票据已核销）。 */
  'transfer/created': { readonly result: TransferCreatedResult }
  /** 理财购买成功。 */
  'wealth/purchased': { readonly result: WealthPurchaseResult }
  /** 人脸验证尝试。 */
  'verify/face': { readonly result: VerifyResult }
  /** 短信验证尝试。 */
  'verify/sms': { readonly result: VerifyResult }
  /** U 盾验证尝试。 */
  'verify/ushield': { readonly result: VerifyResult }
  /** 连续失败触发的会话级锁定（红色操作 30 分钟不可执行）。 */
  'verify/locked': {
    readonly sessionId: SessionId
    readonly channel: 'face' | 'sms' | 'ushield'
    readonly until: number
    readonly attempts: number
  }
  /** 票据生命周期记账失败（账本异常不得改动资金结论，只留审计证据）。 */
  'ticket/ledger-failed': {
    readonly ticketId: string
    readonly op: 'issue' | 'approve' | 'redeem' | 'consume' | 'block' | 'result'
    readonly code: string
    readonly reason: string
    readonly at: number
  }
  /** 银行卡挂失（ADR-0003；红档写操作）。 */
  'card/reported-lost': {
    readonly cardId: string
    readonly tail: string
    readonly status: 'lost'
    readonly at: number
  }
  /** 卡片状态迁移（ADR-0006；冻结/解冻。挂失仍走 card/reported-lost）。 */
  'card/state-changed': {
    readonly cardId: string
    readonly tail: string
    readonly from: 'normal' | 'frozen'
    readonly to: 'normal' | 'frozen'
    readonly reason: 'freeze' | 'unfreeze'
    /** 可选的用户/模型给出的原因（只落审计，不参与判定）。 */
    readonly note?: string
    readonly at: number
  }
  /** 取消自动扣款订阅（ADR-0003；黄档写操作）。 */
  'sub/cancelled': {
    readonly subscriptionId: string
    readonly merchant: string
    readonly at: number
  }
}

declare module '@bah/core' {
  interface SessionEventMap extends BankSessionEventMap {}
}

/** 本包认识的领域事件类型。 */
export type BankSessionEventType = keyof BankSessionEventMap

/** 领域事件全量键（门禁与文档用；顺序即声明顺序）。 */
export const BANK_SESSION_EVENT_TYPES = [
  'identity/bound',
  'tier/decided',
  'read/accounts',
  'read/balance',
  'read/txns',
  'read/bill-analyzed',
  'read/bill-report',
  'read/analysis',
  'read/wealth',
  'transfer/preview',
  'transfer/created',
  'wealth/purchased',
  'verify/face',
  'verify/sms',
  'verify/ushield',
  'verify/locked',
  'ticket/ledger-failed',
  'card/reported-lost',
  'card/state-changed',
  'sub/cancelled',
] as const satisfies readonly BankSessionEventType[]

/**
 * 审计出口：工具只依赖「能 append 一条领域事件」。
 *
 * 运行时适配器把 `SessionApi.append` 按领域键转发；单测用内存收集器。
 * 不让本包直接依赖 `@bah/runtime` 的 `SessionSink`：工具族不该把插件线拖进运行时包。
 */
export interface BankAudit {
  append<K extends BankSessionEventType>(type: K, data: BankSessionEventMap[K]): void
}
