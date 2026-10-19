/**
 * 票据生命周期记账平面（施工单 10 §1 映射表第 3 行）：`tools/result`（emit）。
 *
 * **只记账、不核销**：读 bank-core 的权威票据状态（施工单 07 §3 的唯一属主），
 * 把「核销后成功 → consumed」「失败/受阻 → blocked」落进 TraceLog 与计数位，
 * 语义与 09 的 `TicketLedger` 一致，但不自己转移任何状态、不另造状态机。
 */

import type { TraceLog } from '../kernel/index.ts'

/** `tools/result` 载荷的最小结构形状（不 import `@bah/runtime`）。 */
interface ResultLike {
  readonly callId: string
  readonly name: string
  readonly isError: boolean
  readonly code?: string
}

/** 记账平面装配参数。 */
export interface SentryTicketingOptions {
  readonly sessionId: string
  readonly trace: TraceLog
  readonly now: () => number
  /** bank-core 的票据状态读取口（`ticket:<callId>`）。 */
  readonly ticketStatus: (ticketId: string) => string | undefined
}

/** 一次记账的结论（审计可见）。 */
type TicketAccounting = 'consumed' | 'blocked' | 'unknown'

/**
 * 造 `tools/result` 监听器。
 *
 * @returns 同步监听器：只观察，不修改管线结果（不得返回任何判决）
 */
export function createTicketingListener(options: SentryTicketingOptions): (payload: unknown) => void {
  const { sessionId, trace, now, ticketStatus } = options

  return (payload) => {
    const result = payload as ResultLike
    const ticketId = `ticket:${result.callId}`
    const status = ticketStatus(ticketId)
    if (status === undefined) return

    const accounting = account(status, result.isError)
    const at = now()
    if (accounting === 'consumed') trace.bump('ticketsConsumed')
    trace.append({
      session: sessionId,
      kind: 'ticket',
      ticketId,
      callId: result.callId,
      name: result.name,
      coreStatus: status,
      accounting,
      ...(result.code === undefined ? {} : { code: result.code }),
      at,
    })
  }
}

/**
 * bank-core 状态 + 调用结果 → 生命周期记账。
 *
 * @param status bank-core 的票据状态
 * @param isError 本次调用是否失败
 */
function account(status: string, isError: boolean): TicketAccounting {
  switch (status) {
    case 'redeemed':
      return isError ? 'blocked' : 'consumed'
    case 'consumed':
      return 'consumed'
    case 'issued':
    case 'approved':
    case 'blocked':
      return 'blocked'
    default:
      // 未来的 bank-core 状态：不猜测语义（记 unknown，保留原始状态供审计）
      return 'unknown'
  }
}
