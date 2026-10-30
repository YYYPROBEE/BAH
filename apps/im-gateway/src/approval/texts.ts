/**
 * 审批 / 接管的用户可见文案（施工单 03 §2.2 / §2.5 / §2.6）。
 *
 * 文案集中在一处：同一句话在文本指令与 H5 两条路径上不能各写一份，否则"已过期"与
 * "已批准"的口径会分叉。文案里不出现 errcode、子进程地址、端口。
 */

import { APPROVAL_LINK_MAX_TTL_MS, signApprovalLink, type ApprovalClosedFrame } from '@bah/channels'

import type { PendingTicket } from './pending.ts'

/** 无待审批。 */
export const NO_PENDING_TEXT = '当前没有待审批'
/** 多票据必须带票号。 */
export const NEED_TICKET_TEXT = '请带票据号，例如：1 t-abc'
/** 红级未验证的前置提醒（防误触，不是最终裁决）。 */
export const NEED_VERIFY_TEXT = '该票据需要强验证，请先回复 4 票据号'
/** 批准成功。 */
export const APPROVED_TEXT = '已批准'
/** 拒绝成功。 */
export const REJECTED_TEXT = '已拒绝'
/** 强验证成功。 */
export const VERIFIED_TEXT = '验证通过，回复 1 票据号 批准'
/** 票据不存在 / 已处理。 */
export const UNKNOWN_TICKET_TEXT = '票据不存在或已处理'
/** 票据不属于当前会话。 */
export const FOREIGN_TICKET_TEXT = '票据不属于当前会话'
/** 结论不合法。 */
export const INVALID_DECISION_TEXT = '结论不合法'
/** 拒绝必须填理由。 */
export const REASON_REQUIRED_TEXT = '拒绝必须填写理由'
/** 已有结论。 */
export const ALREADY_DECIDED_TEXT = '该票据已有结论（先到者胜出）'
/** 已过期，按拒绝处理（W04 口径：unavailable 不是放行）。 */
export const EXPIRED_TEXT = '票据已过期，结论未采纳'
/** 不需要强验证。 */
export const NO_CHALLENGE_TEXT = '该票据不需要强验证'
/** 强验证失败。 */
export const VERIFY_FAILED_TEXT = '强验证未通过'
/** 转人工成功。 */
export const TAKEOVER_TEXT = '已转人工，请稍候'
/** 已在人工服务中。 */
export const ALREADY_TAKEOVER_TEXT = '已在人工服务中'
/** 接管期间用户消息已记录。 */
export const QUEUED_FOR_OPERATOR_TEXT = '已记录，等坐席查看'
/** 审批提示的回复行。 */
const REPLY_HINT = '回复：1 批准一次 / 2 拒绝（附理由） / 3 查看详情'

/** 链接过期时刻：票据 TTL 与 5 分钟取小（票据没给 TTL 就按 5 分钟）。 */
export function linkExpiryOf(ticket: PendingTicket, nowMs: number): number {
  return Math.min(ticket.expiresAt ?? nowMs + APPROVAL_LINK_MAX_TTL_MS, nowMs + APPROVAL_LINK_MAX_TTL_MS)
}

/**
 * 生成一条 H5 审批链接（未配置公开基址 → `undefined`，文本指令仍可用）。
 */
export function approvalLinkOf(
  ticket: PendingTicket,
  sessionKey: string,
  secret: string,
  publicBaseUrl: string | undefined,
  nowMs: number,
): string | undefined {
  if (publicBaseUrl === undefined || publicBaseUrl.length === 0) return undefined
  const token = signApprovalLink(
    { v: 1, s: sessionKey, t: ticket.ticketId, e: linkExpiryOf(ticket, nowMs) },
    secret,
  )
  return `${publicBaseUrl}/a/${token}`
}

/**
 * 出站审批消息：摘要 + 分隔线 + 票据/有效期 + 可选 H5 + 指令提示。
 *
 * 审批消息**不与其他消息合并**（调用方逐条推送）。
 */
export function composeApprovalMessage(
  ticket: PendingTicket,
  options: {
    readonly sessionKey: string
    readonly linkSecret: string
    readonly publicBaseUrl: string | undefined
    readonly nowMs: number
  },
): string {
  const lines = [ticket.summary]
  lines.push('────')
  if (ticket.expiresAt === undefined) {
    lines.push(`票据 ${ticket.ticketId}`)
  } else {
    const seconds = Math.max(0, Math.ceil((ticket.expiresAt - options.nowMs) / 1000))
    lines.push(`票据 ${ticket.ticketId} · ${String(seconds)} 秒内有效`)
  }
  const link = approvalLinkOf(
    ticket,
    options.sessionKey,
    options.linkSecret,
    options.publicBaseUrl,
    options.nowMs,
  )
  if (link !== undefined) lines.push(`H5：${link}`)
  lines.push(REPLY_HINT)
  if (ticket.tier === 'red' || ticket.challenge !== undefined) {
    lines.push('需强验证：回复 4 票据号，或打开 H5 完成验证')
  }
  return lines.join('\n')
}

/** 详情指令：重发摘要 + 链接（链接无法生成时只发摘要）。 */
export function composeDetailMessage(
  ticket: PendingTicket,
  options: {
    readonly sessionKey: string
    readonly linkSecret: string
    readonly publicBaseUrl: string | undefined
    readonly nowMs: number
  },
): string {
  const link = approvalLinkOf(
    ticket,
    options.sessionKey,
    options.linkSecret,
    options.publicBaseUrl,
    options.nowMs,
  )
  return link === undefined ? ticket.summary : `${ticket.summary}\nH5：${link}`
}

/** 审批收尾文本（`unavailable` 也是拒绝，不写成"已批准"）。 */
export function closedTextOf(frame: ApprovalClosedFrame): string {
  const lines = [`【审批结果】${frame.label}（${frame.decision}）`]
  if (frame.reason !== undefined && frame.reason.length > 0) lines.push(`理由：${frame.reason}`)
  if (frame.code !== undefined) lines.push(`代码：${frame.code}`)
  if (frame.decision === 'unavailable') lines.push(EXPIRED_TEXT)
  return lines.join('\n')
}

/** 认领 / 进入 / 交回的文案（接管帧三态）。 */
export function handoffTextOf(frame: {
  readonly active: boolean
  readonly operator?: string
}): string {
  if (!frame.active) return '坐席已交回，继续为您服务。'
  if (frame.operator !== undefined && frame.operator.length > 0) {
    return `坐席 ${frame.operator} 已接入。`
  }
  return '已转人工，坐席会尽快接入；期间您的消息会排队。'
}
