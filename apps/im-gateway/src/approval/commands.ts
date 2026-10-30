/**
 * 审批文本指令 → 动作（施工单 03 §2.2）。
 *
 * 两件事只在这里做：
 * 1. **票据选择**：不带票号时只有"恰好一张"才可直接选中；多于一张一律要求带票号
 *    （避免用户一句 `1` 误批其中一张）。
 * 2. **红级防误触**：票据已知且未强验证时，先提示 `4 票据号`；这不是最终裁决——
 *    真正"未验证先批准"由审批服务判 `rejected` 并烧票。
 *
 * 子进程仍是结论的唯一真相：票号给了但网关内存里没有（重连 / 未同步）时照样转发，
 * 由子进程返回 `unknown-ticket` / `foreign-ticket`。
 */

import type { ImCommand } from '@bah/channels'
import { assertNever } from '@bah/util'

import type { PendingTicket } from './pending.ts'
import {
  NEED_TICKET_TEXT,
  NEED_VERIFY_TEXT,
  NO_CHALLENGE_TEXT,
  NO_PENDING_TEXT,
  UNKNOWN_TICKET_TEXT,
} from './texts.ts'

/** 指令的执行计划。 */
export type ApprovalPlan =
  | { readonly kind: 'reply'; readonly text: string }
  | {
      readonly kind: 'decide'
      readonly ticketId: string
      readonly decision: 'allowed-once' | 'rejected'
      readonly reason?: string
    }
  | { readonly kind: 'verify'; readonly ticketId: string }
  | { readonly kind: 'detail'; readonly ticketId: string }

/** 选择结果。 */
type Picked =
  | { readonly ok: true; readonly ticket: PendingTicket }
  | { readonly ok: false; readonly text: string }

/** 无票号时的歧义处理（0 张 / 多张都不猜）。 */
function pickOne(pending: readonly PendingTicket[]): Picked {
  if (pending.length === 0) return { ok: false, text: NO_PENDING_TEXT }
  if (pending.length > 1) return { ok: false, text: NEED_TICKET_TEXT }
  const only = pending[0]
  return only === undefined ? { ok: false, text: NO_PENDING_TEXT } : { ok: true, ticket: only }
}

/** 有票号时先查本地待办；查不到不算错（交给子进程裁决）。 */
function findTicket(pending: readonly PendingTicket[], ticketId: string): PendingTicket | undefined {
  return pending.find((ticket) => ticket.ticketId === ticketId)
}

/** 红级且本会话未验证 → 先提示验证。 */
function blockedByChallenge(ticket: PendingTicket | undefined): boolean {
  return ticket !== undefined && ticket.tier === 'red' && !ticket.verified
}

/**
 * 把一条审批类指令转成执行计划。
 *
 * @param command 已由 `parseImCommand` 识别出的指令
 * @param pending 本会话待审批列表（顺序 = 进入顺序）
 */
export function planApprovalCommand(
  command: ImCommand,
  pending: readonly PendingTicket[],
): ApprovalPlan {
  switch (command.kind) {
    case 'approve': {
      if (command.ticketId !== undefined) {
        const ticket = findTicket(pending, command.ticketId)
        if (blockedByChallenge(ticket)) return { kind: 'reply', text: NEED_VERIFY_TEXT }
        return { kind: 'decide', ticketId: command.ticketId, decision: 'allowed-once' }
      }
      const picked = pickOne(pending)
      if (!picked.ok) return { kind: 'reply', text: picked.text }
      if (blockedByChallenge(picked.ticket)) return { kind: 'reply', text: NEED_VERIFY_TEXT }
      return { kind: 'decide', ticketId: picked.ticket.ticketId, decision: 'allowed-once' }
    }
    case 'reject': {
      if (command.ticketId !== undefined) {
        return {
          kind: 'decide',
          ticketId: command.ticketId,
          decision: 'rejected',
          reason: command.reason,
        }
      }
      const picked = pickOne(pending)
      if (!picked.ok) return { kind: 'reply', text: picked.text }
      return {
        kind: 'decide',
        ticketId: picked.ticket.ticketId,
        decision: 'rejected',
        reason: command.reason,
      }
    }
    case 'verify': {
      const ticket =
        command.ticketId === undefined ? undefined : findTicket(pending, command.ticketId)
      if (ticket !== undefined && ticket.challenge === undefined) {
        return { kind: 'reply', text: NO_CHALLENGE_TEXT }
      }
      if (command.ticketId !== undefined) return { kind: 'verify', ticketId: command.ticketId }
      const picked = pickOne(pending)
      if (!picked.ok) return { kind: 'reply', text: picked.text }
      if (picked.ticket.challenge === undefined) return { kind: 'reply', text: NO_CHALLENGE_TEXT }
      return { kind: 'verify', ticketId: picked.ticket.ticketId }
    }
    case 'detail': {
      if (command.ticketId === undefined) {
        const picked = pickOne(pending)
        if (!picked.ok) return { kind: 'reply', text: picked.text }
        return { kind: 'detail', ticketId: picked.ticket.ticketId }
      }
      const ticket = findTicket(pending, command.ticketId)
      if (ticket === undefined) return { kind: 'reply', text: UNKNOWN_TICKET_TEXT }
      return { kind: 'detail', ticketId: command.ticketId }
    }
    case 'fetch-latest':
    case 'takeover':
      // 这两类不是审批动作（调用方在进入本函数前分流）
      return { kind: 'reply', text: NO_PENDING_TEXT }
    default:
      return assertNever(command, 'im-command')
  }
}
