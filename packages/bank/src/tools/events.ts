/**
 * 银行领域的 durable 会话事件。
 *
 * 为什么由本包声明： 定的规矩是「`transfer/*`、`wealth/*`、`verify/*` 等
 * 领域事件由各自插件包用同一个增强机制追加」。`@bah/core` 的 `SessionEventMap`
 * 留了索引签名，这里用 `declare module` 补成逐键声明，不修改冻结文件。
 *
 * 两条纪律：
 * 1. **事件载荷就是卡片的数据源**：
 *    `result` 整块落账，渠道不依赖工具返回值的临时变量；
 * 2. 事件名只允许出现在 `BANK_SESSION_EVENT_TYPES` 里——`verify-session-events` 门禁会扫
 *    `audit.append('…')` 的字面量，并读取本文件的增强块。
 */

import type {
  AaGroupResult,
  AccountsResult,
  AnalysisResult,
  BalanceResult,
  BillAnalysisResult,
  BillReportResult,
  RiskAssessResult,
  SubscriptionListResult,
  TransferCreatedResult,
  TransferPreviewResult,
  TxnQueryResult,
  VerifyResult,
  WealthListResult,
  WealthCompareResult,
  WealthPositionsResult,
  WealthPurchaseResult,
  WealthRedeemResult,
} from './dto.ts'
import type { SessionId, ToolTierLevel } from '@bah/core'

import type { IdentityBoundData } from './identity.ts'
import type { MerchantCategory } from '../core/merchant.ts'
import type { RiskGrade } from '../core/model.ts'
import type { PolicyEvidence } from './policy.ts'
import type { TierReason } from './tier.ts'

/** 银行领域事件的数据表（`SessionEventMap` 的增强内容）。 */
export interface BankSessionEventMap {
  /** 会话已绑定银行用户。 */
  'identity/bound': IdentityBoundData
  /** 三级判决已作出（允许 / 需审批 / 拒绝 + 理由码； 的审计落点）。 */
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
  /** 持仓已读取。 */
  'read/wealth-positions': { readonly result: WealthPositionsResult }
  /**
   * 风险问卷已下发（只读分支；**不改等级、不落档**）。
   *
   * 载荷带题目快照而不是只带问卷 ID：回放时要能回答「用户当时看到的题干与选项」，
   * 只留 ID 的话，常量表一改（版本升级）历史就再也复现不出来。
   * `score` 也随卷下发：审批卡要逐题显示分值，渠道不得自己乘系数。
   */
  'read/risk-questions': {
    /** 发卷的那次工具调用（渠道据此把问卷卡挂到正确的 `tool` 帧上）。 */
    readonly callId: string
    readonly questionnaireId: string
    readonly version: string
    readonly issuedAt: number
    readonly expiresAt: number
    readonly currentGrade: RiskGrade
    readonly questions: readonly {
      readonly index: number
      readonly title: string
      readonly options: readonly {
        readonly key: string
        readonly text: string
        readonly score: number
      }[]
    }[]
  }
  /**
   * 风险测评完成（客户风险等级已更新）。
   *
   * `confirmedBy / ticketRef / questionnaireId / version` 是 C-03 的确认凭证：
   * 等级不是模型给的，是「服务端签发的问卷 + 用户逐题作答 + 用户点批准核销的票据」三者合成的。
   */
  'risk/assessed': {
    readonly result: RiskAssessResult
    /** 依据的问卷实例（一次性凭证，落档即核销）。 */
    readonly questionnaireId: string
    /** 题目版本。 */
    readonly version: string
    /** 确认来源：只允许「审批票据」——没有票据就不该有这条事件。 */
    readonly confirmedBy: 'approval-ticket'
    /** 票据 ID（核销凭证；审计可据此反查审批链）。 */
    readonly ticketRef: string
    /** 用户逐题所选的选项键（与 `result.answers` 同一份事实，冗余落账便于审计单条读全）。 */
    readonly answers: readonly { readonly index: number; readonly key: string }[]
  }
  /** 理财赎回成功。 */
  'wealth/redeemed': { readonly result: WealthRedeemResult }
  /** AA 收款请求已创建。 */
  'aa/created': { readonly result: AaGroupResult }
  /** AA 收款请求已读取。 */
  'read/aa': { readonly result: AaGroupResult }
  /**
   * AA 模拟代收（demo 口径；ADR-0011）。
   *
   * 载荷只放账本事实：哪一组、第几位参与人、入账多少、对应流水。**不放姓名/手机号**——
   * 姓名已在组快照里，重复落账只会多一处需要清理的 PII。
   */
  'aa/collected': {
    readonly groupId: string
    readonly participantIndex: number
    readonly collectedCents: number
    readonly txnId: string
    readonly at: number
  }
  /**
   * AA 参与人表态（ADR-0017）：`pending → declined | expired`。
   *
   * **不复用 `aa/collected`**：那个键的语义是"钱进来了"，这里是"钱没进来"。
   * 混用会让对账时无法区分"未付"与"已收"。也不加 `aa/expired` 第二个键——
   * `to` 已经表达了去向。载荷只记账本事实（组号/序号/去向），不放姓名。
   */
  'aa/participant-updated': {
    readonly groupId: string
    readonly participantIndex: number
    readonly from: 'pending'
    readonly to: 'declined' | 'expired'
    readonly at: number
  }
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
  /** 新卡申请成功（虚拟/实体卡）。 */
  'card/issued': {
    readonly cardId: string
    readonly accountId: string
    readonly tail: string
    readonly type: 'physical' | 'virtual'
    readonly dailyLimitCents: number
    readonly monthlyLimitCents: number
    /**
     * 授信额度（ADR-0015 / event-table §3.5；仅 `kind='credit'` 的信用产品）。
     *
     * 可选增量：借记卡发射的事件 `Object.keys` 与 v1.0.3 完全一致，老回放无需迁移。
     */
    readonly creditLimitCents?: number
    readonly at: number
  }
  /** 卡片额度调整。 */
  'card/limits-changed': {
    readonly cardId: string
    readonly tail: string
    readonly from: { readonly dailyLimitCents: number; readonly monthlyLimitCents: number }
    readonly to: { readonly dailyLimitCents: number; readonly monthlyLimitCents: number }
    /**
     * 变更后的授信额度（ADR-0015 / event-table §3.5；仅信用产品）。
     *
     * 两个字段都是**可选增量**：借记卡的事件形状不变。
     */
    readonly creditLimitCents?: number
    /**
     * **变更时**的已用额度（仅信用产品）。
     *
     * 为什么要落它：额度调整的合法性取决于"已用多少"（降额不得低于已用）；
     * 不落这个数，事后回放无法解释一次降额为什么被允许或被拒。
     * 它是变更时的快照，**不随下一笔消费更新**——事件是事实，不是实时镜像。
     */
    readonly usedCreditCents?: number
    readonly at: number
  }
  /** 卡片交易限制设置/解除。 */
  'card/restrictions-changed': {
    readonly cardId: string
    readonly tail: string
    readonly mode: 'set' | 'clear'
    readonly restrictions: readonly {
      readonly kind: 'online' | 'overseas' | 'category'
      readonly value?: string
      readonly note?: string
      readonly at: number
    }[]
    readonly at: number
  }
  /**
   * 卡消费已记账（ADR-0012；mock 收单通道，不是真实收单）。
   *
   * 载荷只放**账本事实**（卡、流水、品类、金额、时刻）；限额结论在回执里，
   * 不重复落账（限额会随下一笔变化，落进来就变成第二份会漂移的真相）。
   */
  'card/spent': {
    readonly cardId: string
    readonly tail: string
    readonly txnId: string
    readonly merchantCategory: MerchantCategory
    readonly amountCents: number
    readonly at: number
  }
  /** 取消自动扣款订阅（ADR-0003；黄档写操作）。 */
  'sub/cancelled': {
    readonly subscriptionId: string
    readonly merchant: string
    readonly at: number
  }
  /**
   * 订阅清单 + 周期检测结果已读取（ADR-0007）。
   *
   * `detected` 是**推断**，一旦落进 `session.jsonl` 就获得事实级的耐久性；
   * `detectedAt / basis / detectorVersion` 三件套让回放能识别这是快照，不是现况。
   */
  'read/subscriptions': {
    readonly result: SubscriptionListResult
    readonly detectedAt: number
    readonly basis: { readonly from: number; readonly to: number; readonly txnCount: number }
    readonly detectorVersion: string
  }
  /** 代扣协议已关闭（ADR-0007；黄档写操作，**只关不开**）。 */
  'sub/authorization-revoked': {
    readonly authorizationId: string
    readonly merchant: string
    readonly affected: number
    readonly at: number
  }
  /** 订阅提醒 / 标注已更新（ADR-0007；黄档写操作）。 */
  'sub/watch-updated': {
    readonly subscriptionId: string
    readonly watch: 'remind' | 'idle' | 'none'
    readonly aheadDays?: number
    readonly at: number
  }
  /**
   * 交易密码已修改（ADR-0014；红档写操作，**交办**而不是代改）。
   *
   * 载荷里**禁止**出现旧密码、新密码、密码哈希、盐或明文的任何变形——评审会逐字看这一行。
   * 想回答"谁在什么时候用什么方式改的"，这三个字段就够了；密码材料一律不在事件里。
   */
  'security/password-changed': {
    readonly userId: string
    /** 改密来源：只允许渠道安全页（模型与工具都接触不到明文）。 */
    readonly method: 'secure-page'
    readonly at: number
  }
  /**
   * 交易密码状态已读取（ADR-0014；只读分支，不签票）。
   *
   * `lastChangedAt = null` 表示从未改过；`remainingAttempts` 在锁定窗口内为 0。
   * 这两个字段是**状态**而不是凭据：知道"还能试几次"不能用来通过验证。
   */
  'read/password-status': {
    readonly lastChangedAt: number | null
    readonly remainingAttempts: number
    readonly at: number
  }
  /**
   * 主动提醒已投递 / 被预算压掉（ADR-0016；通用通道 `bah:proactive`）。
   *
   * 载荷只有**投递结论**：谁发的（`source`）、哪一件（`key`，幂等键）、说了什么（`title`）、
   * 走哪条路（`channel`）、没走成的原因（`suppressedReason`）。
   *
   * 三条纪律：
   * 1. `source` 是 `string` 而不是封闭联合——新的主动能力（生日、安全、计划…）**不该**
   *    因为"要发一条提醒"而改事件类型；取值域在 `ProactiveService.push` 的入参上收紧。
   * 2. `channel='none'` 时**必须**带 `suppressedReason`（否则审计只能看到"没提醒"，
   *    看不出"为什么没提醒"；夜里被静默正是最需要可解释的那一种）。
   * 3. **不落 `text`**：正文压进 `title`。多一个自由文本字段就是多一个将来会漂移的真相，
   *    而这条事件的用途是"证明提醒发生过/被谁压掉"，不是重放排版。
   */
  'proactive/reminder': {
    readonly source: string
    readonly key: string
    readonly title: string
    readonly channel: 'in-app' | 'im' | 'none'
    readonly suppressedReason?: string
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
  'read/wealth-positions',
  'read/risk-questions',
  'risk/assessed',
  'wealth/redeemed',
  'aa/created',
  'read/aa',
  'aa/collected',
  // ADR-0017：参与人拒绝 / 到期（同一键，`to` 区分去向）
  'aa/participant-updated',
  'verify/face',
  'verify/sms',
  'verify/ushield',
  'verify/locked',
  'ticket/ledger-failed',
  'card/reported-lost',
  'card/state-changed',
  'card/issued',
  'card/limits-changed',
  'card/restrictions-changed',
  'card/spent',
  'sub/cancelled',
  'read/subscriptions',
  'sub/authorization-revoked',
  'sub/watch-updated',
  // ADR-0014：交易密码（写分支 + 只读分支各一键）
  'security/password-changed',
  'read/password-status',
  // ADR-0016：通用主动通知通道（订阅续费提醒是第一个消费者；键名刻意不叫 sub/*）
  'proactive/reminder',
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
