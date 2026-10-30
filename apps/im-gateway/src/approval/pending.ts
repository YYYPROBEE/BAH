/**
 * 网关侧待审批状态（施工单 03 §2.1）。
 *
 * 快照是**全量状态**，不是增量：同一票据同时出现 `approval` 与 `approval-closed` 时，
 * 以后者为准（票据已收尾，不能再显示成待办）。快照重建不推送、不补发历史。
 *
 * 一切结论仍以子进程返回为准；这里只维护"能不能显示/选择"的展示状态。
 */

import { projectImOutbound, type ApprovalClosedFrame, type ApprovalFrame, type FrameTier, type WebFrame } from '@bah/channels'

/** 一张待审批票据（网关内存态；不含平台用户标识）。 */
export interface PendingTicket {
  readonly ticketId: string
  readonly tier: FrameTier
  readonly challenge?: 'face' | 'sms' | 'ushield'
  readonly expiresAt?: number
  /** 出站摘要（`projectImOutbound` 的审批文本，不含链接）。 */
  readonly summary: string
  /** 强验证是否已在**本会话**内通过。 */
  verified: boolean
  /** 操作类型（H5 页展示）。 */
  readonly operation: string
  readonly amountText?: string
  readonly payeeName?: string
}

/** 帧 → 待审批票据。 */
export function ticketOf(frame: ApprovalFrame): PendingTicket {
  const projected = projectImOutbound([frame])[0]
  return {
    ticketId: frame.ticketId,
    tier: frame.tier,
    summary: projected !== undefined && projected.kind === 'approval' ? projected.text : '',
    verified: false,
    operation: frame.operation,
    ...(frame.challenge === undefined ? {} : { challenge: frame.challenge }),
    ...(frame.expiresAt === undefined ? {} : { expiresAt: frame.expiresAt }),
    ...(frame.amountText === undefined ? {} : { amountText: frame.amountText }),
    ...(frame.payeeName === undefined ? {} : { payeeName: frame.payeeName }),
  }
}

/** 一帧对待审批表的影响。 */
export type PendingChange =
  | { readonly kind: 'added'; readonly ticket: PendingTicket }
  | { readonly kind: 'updated'; readonly ticket: PendingTicket }
  | { readonly kind: 'closed'; readonly ticketId: string; readonly frame: ApprovalClosedFrame }

/**
 * 应用一帧增量。
 *
 * @returns `undefined` = 与本表无关（调用方忽略）
 */
export function applyPendingFrame(
  pending: Map<string, PendingTicket>,
  frame: WebFrame,
): PendingChange | undefined {
  if (frame.kind === 'approval') {
    const previous = pending.get(frame.ticketId)
    const ticket = { ...ticketOf(frame), verified: previous?.verified ?? false }
    pending.set(ticket.ticketId, ticket)
    return { kind: previous === undefined ? 'added' : 'updated', ticket }
  }
  if (frame.kind === 'approval-closed') {
    pending.delete(frame.ticketId)
    // 未见过 approval 帧也照常返回：收尾文本仍应推给用户（例如网关重连后错过开启帧）
    return { kind: 'closed', ticketId: frame.ticketId, frame }
  }
  return undefined
}

/**
 * 用快照重建待审批表。
 *
 * 快照帧按 `seq` 升序；先收集全部 `approval`，再把有 `approval-closed` 的票据踢掉。
 */
export function rebuildPending(frames: readonly WebFrame[]): Map<string, PendingTicket> {
  const pending = new Map<string, PendingTicket>()
  const closed = new Set<string>()
  for (const frame of frames) {
    if (frame.kind === 'approval') {
      if (!pending.has(frame.ticketId)) pending.set(frame.ticketId, ticketOf(frame))
      continue
    }
    if (frame.kind === 'approval-closed') closed.add(frame.ticketId)
  }
  for (const ticketId of closed) pending.delete(ticketId)
  return pending
}

/** 标记强验证通过（只影响红级前置提醒，不改变票据结论）。 */
export function markVerified(pending: Map<string, PendingTicket>, ticketId: string): void {
  const ticket = pending.get(ticketId)
  if (ticket !== undefined) ticket.verified = true
}
