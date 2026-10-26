/**
 * 审批 / 票据生命周期的 durable 会话事件（施工单 09 §3、§2）。
 *
 * 为什么由本包声明：施工单 03 §1.2 的规矩是「领域事件由各自插件包用模块增强追加」。
 * `approval/asked` 与 `approval/decided` 由七段管线（`@bah/runtime`）落账，本包补齐
 * 两者之间的**仲裁过程**与**票据状态转移**：
 *
 * ```text
 * ask ─▶ ticket/issued ─▶ approval/asked ─▶（挑战签发 / 超时 / 重复应答）
 *     ─▶ approval/decided ─▶ ticket/approved ─▶ 执行 ─▶ ticket/redeemed ─▶ ticket/consumed
 *                                              ├─▶ ticket/lease-renewed（W12：只前移 lease）
 *                                              └─▶ ticket/blocked（拒绝 / 超时 / 执行失败）
 * ```
 *
 * 纪律：全部 `ignorable: true` 落账（施工单 09 硬约束 6）——平台 reader（`deriveMessages`）
 * 不认识领域族，漏标会让下一次请求装配抛 `session-unknown-event`。
 */

import type { SessionId } from '@bah/core'

import type { ApprovalOutcome, ChallengeChannel } from './types.ts'

/** 票据已签发（`ask` 判决 → 五绑定票据落库）。 */
export interface TicketIssuedData {
  /** 票据 ID。 */
  readonly ticketId: string
  /** 调用 ID。 */
  readonly callId: string
  /** 工具名。 */
  readonly name: string
  /** 参数指纹（参数变化即失效）。 */
  readonly fingerprint: string
  /** 金额（分；无金额工具缺省）。 */
  readonly amountCents?: number
  /** 过期时刻（epoch ms）。 */
  readonly expiresAt: number
  /** 转移时刻（注入时钟）。 */
  readonly at: number
}

/** 票据已批准（`approved`：只对那一次调用有效）。 */
export interface TicketApprovedData {
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  readonly at: number
}

/** 票据已被 bank-core 核销（`redeemed`；核销唯一属主仍是 bank-core）。 */
export interface TicketRedeemedData {
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  readonly at: number
}

/** 票据已消费（核销 + 调用成功）。 */
export interface TicketConsumedData {
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  readonly at: number
}

/** 票据已阻断（拒绝 / 超时 / 过期 / 执行失败）。 */
export interface TicketBlockedData {
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  /** 结构化理由（`approval-rejected` / `ticket-expired` / `tool-failed` …）。 */
  readonly reason: string
  readonly at: number
}

/** 票据 lease 已续租（W12：只前移到期时刻，不动票据 TTL）。 */
export interface TicketLeaseRenewedData {
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  readonly leaseId: string
  /** 续租前的到期时刻。 */
  readonly previousExpiresAt: number
  /** 续租后的到期时刻（必须 ≤ 票据 `expiresAt`）。 */
  readonly expiresAt: number
  readonly at: number
}

/** 重复应答（后到者被拒；**报警但绝不重复执行**）。 */
export interface ApprovalDuplicateData {
  readonly ticketId: string
  readonly callId: string
  /** 后到者的渠道 id。 */
  readonly responder: string
  /** 后到者提交的结论（非法结论记 `invalid-answer`）。 */
  readonly decision: string
  readonly at: number
}

/** 审批超时（票据 TTL 到期仍未有人应答 → `unavailable`）。 */
export interface ApprovalTimeoutData {
  readonly ticketId: string
  readonly callId: string
  /** 等待时长（ms）。 */
  readonly waitedMs: number
  readonly at: number
}

/** 红级挑战已签发（挑战 ID 与票据绑定，可回放到具体一次验证）。 */
export interface ApprovalChallengeIssuedData {
  readonly ticketId: string
  readonly callId: string
  readonly challengeId: string
  readonly channel: ChallengeChannel
  readonly sessionId: SessionId
  readonly at: number
}

/** 强验证未通过 → 批准不可达（`rejected` + `challenge-required`）。 */
export interface ApprovalChallengeFailedData {
  readonly ticketId: string
  readonly callId: string
  readonly challengeId: string
  /** 结构化理由码。 */
  readonly code: string
  readonly at: number
}

/** 本包声明的会话事件表（`SessionEventMap` 的增强内容）。 */
export interface InteractionSessionEventMap {
  /** 票据已签发。 */
  'ticket/issued': TicketIssuedData
  /** 票据已批准。 */
  'ticket/approved': TicketApprovedData
  /** 票据已被核销（bank-core 的唯一属主观察点）。 */
  'ticket/redeemed': TicketRedeemedData
  /** 票据已消费。 */
  'ticket/consumed': TicketConsumedData
  /** 票据已阻断。 */
  'ticket/blocked': TicketBlockedData
  /** 票据 lease 已续租。 */
  'ticket/lease-renewed': TicketLeaseRenewedData
  /** 重复应答报警。 */
  'approval/duplicate': ApprovalDuplicateData
  /** 审批超时。 */
  'approval/timeout': ApprovalTimeoutData
  /** 红级挑战已签发。 */
  'approval/challenge-issued': ApprovalChallengeIssuedData
  /** 强验证未通过（批准不可达）。 */
  'approval/challenge-failed': ApprovalChallengeFailedData
}

declare module '@bah/core' {
  interface SessionEventMap extends InteractionSessionEventMap {}
}

/** 本包认识的事件类型。 */
export type InteractionSessionEventType = keyof InteractionSessionEventMap

/** 领域事件全量键（门禁与文档用；顺序即声明顺序）。 */
export const INTERACTION_SESSION_EVENT_TYPES = [
  'ticket/issued',
  'ticket/approved',
  'ticket/redeemed',
  'ticket/consumed',
  'ticket/blocked',
  'ticket/lease-renewed',
  'approval/duplicate',
  'approval/timeout',
  'approval/challenge-issued',
  'approval/challenge-failed',
] as const satisfies readonly InteractionSessionEventType[]

/** 一条待落账的领域事件（判别联合：`type` 与 `data` 一一对应）。 */
export type InteractionRecord = {
  [K in InteractionSessionEventType]: {
    readonly type: K
    readonly data: InteractionSessionEventMap[K]
  }
}[InteractionSessionEventType]

/**
 * 领域事件出口（宿主接到 `session.append(type, data, { ignorable: true })`）。
 *
 * 单测用内存收集器；生产由 `packages/host/src/boot/plugins/approval.ts` 提供。
 */
export type InteractionRecordSink = (record: InteractionRecord) => void
