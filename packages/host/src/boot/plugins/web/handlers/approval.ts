/**
 * 审批面 handler（W16 从 `web.ts` 拆出）：提交结论 / 执行强验证。
 *
 * 这里**只做传输与状态码翻译**：归属校验（票据属于哪个会话）、幂等、过期、
 * 拒绝理由必填都在 `@bah/channels` 的适配器里。web 层再判一次就是第二真相源。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebDeps, WebRequest } from '../deps.ts'
import { TICKET_PATTERN, readJson, sendError, sendJson } from '../http.ts'

/** 从尾段取票据 ID（先解码再白名单校验：会进日志与查询键，禁止任意字符）。 */
function readTicketId(res: ServerResponse, rest: string): string | undefined {
  // 畸形百分号编码（`%E0%A4%A`）会让 `decodeURIComponent` 抛 `URIError`；
  // 不接住就是 500，等于把"输入错"报成"服务错"。票据 ID 本身也不可能含 `%`。
  let ticketId: string
  try {
    ticketId = decodeURIComponent(rest)
  } catch {
    sendError(res, 400, 'web-invalid-ticket', '票据 ID 不是合法的百分号编码')
    return undefined
  }
  if (!TICKET_PATTERN.test(ticketId)) {
    sendError(res, 400, 'web-invalid-ticket', `票据 ID 非法：${ticketId}`)
    return undefined
  }
  return ticketId
}

/** `POST /api/approval/:ticketId` —— 提交人的结论。 */
export async function handleApproval(
  req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const ticketId = readTicketId(res, request.rest)
  if (ticketId === undefined) return
  const body = await readJson(req)
  const result = deps.adapter.decide(ticketId, body)
  if (result.ok) {
    sendJson(res, 200, { ok: true })
    return
  }
  const status =
    result.code === 'unknown-ticket'
      ? 404
      : result.code === 'foreign-ticket'
        ? 403
        : result.code === 'already-decided' || result.code === 'expired'
          ? 409
          : 400
  sendError(res, status, result.code, result.reason)
}

/** `POST /api/verify/:ticketId` —— 红级票据的强验证（无挑战返回 `no-challenge`）。 */
export async function handleVerify(
  _req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const ticketId = readTicketId(res, request.rest)
  if (ticketId === undefined) return
  const result = await deps.adapter.verify(ticketId)
  if (result.ok) {
    sendJson(res, 200, { ok: true })
    return
  }
  const status = result.code === 'unknown-ticket' ? 404 : result.code === 'foreign-ticket' ? 403 : 400
  sendError(res, status, result.code, result.reason)
}
