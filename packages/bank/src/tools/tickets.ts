/**
 * 票据桥接（`@bah/core` 的三字段 `TicketRef` ↔ bank-core 的五绑定 `TicketRef`）。
 *
 * 施工单 07 把核销属主留在 bank-core，施工单 08/09 在**工具边界**补齐会话与工具名：
 * ```ts
 * { ticketId, binding: { sessionId, tool, fingerprint, amountCents, expiresAt } }
 * ```
 * 这里刻意不把桥接下沉到 core：核心不依赖运行时，五绑定才是核销的权威材料。
 *
 * 参数指纹由本包重算（`fingerprintOf`），因此"审批后模型改了参数"会在
 * `TicketStore.redeem()` 的绑定比对处被拒绝（`ticket-binding-mismatch`）。
 */

import { BahError } from '@bah/util'

import type { TicketId } from '@bah/core'

import type { TicketRef } from '../core/ticket.ts'
import type { ToolExecContext } from '@bah/core'
import { fingerprintOf } from './fingerprint.ts'
import type { BankToolDeps } from './types.ts'

/** 由调用 ID 派生票据 ID（**只作为旧路径的兜底**：票据 ID 现在是随机 UUID）。 */
export function ticketIdOfCall(callId: string): TicketId {
  return `ticket:${callId}` as TicketId
}

/**
 * 组装交给 bank-core 的票据引用。
 *
 * 票据 ID 优先取 `ctx.ticketId`（管线显式传下来的 UUID）。只有它缺位时才回退到
 * `ticket:${callId}`——那条兜底只为兼容"没有走审批链"的旧测试装置，
 * 生产路径上 `approval/asked` 一定先落过账，`ctx.ticketId` 必然存在。
 *
 * @throws `BahError('ticket-missing')` 治理平面没有为该调用签发票据
 */
export function ticketRefForCall(
  deps: BankToolDeps,
  ctx: ToolExecContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  amountCents: number,
): TicketRef {
  const ticketId = ctx.ticketId ?? ticketIdOfCall(ctx.callId)
  const record = deps.tickets.get(ticketId)
  if (record === undefined) {
    throw new BahError(
      'ticket-missing',
      `bank-tools: 调用 ${ctx.callId} 没有已签发的票据（写操作必须先过审批）`,
      { callId: ctx.callId, tool },
    )
  }
  return {
    ticketId,
    binding: {
      sessionId: ctx.sessionId,
      tool,
      fingerprint: fingerprintOf(tool, args),
      amountCents,
      expiresAt: record.binding.expiresAt,
    },
  }
}
