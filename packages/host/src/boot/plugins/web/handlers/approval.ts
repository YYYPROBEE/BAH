/**
 * 审批面 handler（W16 从 `web.ts` 拆出）：提交结论 / 执行强验证。
 *
 * 这里**只做传输与状态码翻译**：归属校验（票据属于哪个会话）、幂等、过期、
 * 拒绝理由必填都在 `@bah/channels` 的适配器里。web 层再判一次就是第二真相源。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Principal } from '@bah/util'

import type { WebDeps, WebRequest } from '../deps.ts'
import { TICKET_PATTERN, readJson, sendError, sendJson } from '../http.ts'

/** 真实登录主体（`kind: 'principal'`）；`service` 是合成主体，不算"人"。 */
function actingPrincipal(request: WebRequest): Principal | undefined {
  const identity = request.identity
  return identity?.kind === 'principal' ? identity.principal : undefined
}

/** 票据归属用的服务端身份（匿名 → `undefined`；合成主体只出会话层，不带 userId）。 */
function ticketOwnerOf(request: WebRequest, deps: WebDeps): { sessionId: string; userId?: string } | undefined {
  const identity = request.identity
  if (identity === undefined || identity.kind === 'anonymous') return undefined
  return {
    sessionId: String(deps.session.sessionId),
    ...(identity.kind === 'principal' ? { userId: identity.principal.userId } : {}),
  }
}

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
  const principal = actingPrincipal(request)
  // 操作者先入链、再落结论（03 TA-46）：链上出现 decided 而其前没有 actor，
  // 才是"无主体决策"（超时 / 无人值守）的合法信号。
  //
  // **只有真实登录主体 + 真实待答票据才写**：
  // - static 模式的 `svc:web` 是合成主体，记成 actor 会让"人批必有主"假阳性；
  // - 未知票号不写链：否则任意已认证用户都能用随机 ticketId 刷长审计链。
  //   跨会话的"待答票据"仍会记 actor（那是真实的越权尝试）。
  if (principal !== undefined && deps.adapter.pendingTickets().includes(ticketId)) {
    try {
      deps.tryAudit()?.appendActor(
        ticketId,
        { tenantId: principal.tenantId, userId: principal.userId, roles: principal.roles },
        deps.now(),
      )
    } catch (error) {
      // 审计是证据旁路：写失败不能把一次审批变成错误（与 tier/decided 同口径）
      console.warn(
        `[web] approval/actor 写入失败（审批照常处理）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const result = deps.adapter.decide(ticketId, body, ticketOwnerOf(request, deps))
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
  const result = await deps.adapter.verify(ticketId, ticketOwnerOf(request, deps))
  if (result.ok) {
    sendJson(res, 200, { ok: true })
    return
  }
  const status = result.code === 'unknown-ticket' ? 404 : result.code === 'foreign-ticket' ? 403 : 400
  sendError(res, status, result.code, result.reason)
}
