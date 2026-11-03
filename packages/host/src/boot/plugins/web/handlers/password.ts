/**
 * 安全页改密端点（ADR-0014）：`POST /api/secure/password`。
 *
 * ## 这个 handler 唯一值得读的地方：它**不做什么**
 *
 * - 不判权：身份 401 / 角色 403 / CSRF 403 全在 `dispatch.ts` 的闸里（本文件排在闸之后）；
 * - 不解析身份：`request.identity` 是 `dispatch` 解析过一次的结果，这里再解析就有第二份真相；
 * - 不决定"这票是不是本人的"：票据归属、过期、一次性由 bank-core 判（`password-ticket-*`）；
 * - **不回显任何密码字段**：成功只回 `{ ok: true, changedAt }`，失败只回 `{ error: { code, reason } }`。
 *
 * ## 明文的生命周期
 *
 * `readJson` → 三个局部变量 → `PasswordHandoffPort.submit(sessionId, …)` → 核心立刻换成
 * `sha256(salt:password)`。这条路径上**没有** `logJson`、没有事件载荷、没有 URL 参数，
 * 也没有第二个副本——评审要查的那条 `grep -r "newPassword" sessions/` 因此必然是零命中。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { errorCodeOf, reasonOf } from '@bah/util'

import { TICKET_PATTERN, readBodyString, readJson, sendError, sendJson } from '../http.ts'
import type { WebDeps, WebRequest } from '../deps.ts'

/**
 * 改密失败码 → HTTP 状态码（封闭表；未登记的码一律 500，不猜）。
 *
 * 为什么 `password-ticket-foreign` 也回 404：403 等于告诉探测者"这个票号存在，但不是你的"。
 * 票据是一次性且带 120s TTL 的，把它当"不存在"处理既安全又不损失可诊断性（审计里仍有独立理由码）。
 */
const PASSWORD_ERROR_STATUS: Readonly<Record<string, number>> = {
  'password-invalid': 400,
  'password-mismatch': 400,
  'password-ticket-unknown': 404,
  'password-ticket-foreign': 404,
  'password-ticket-expired': 409,
  'password-ticket-used': 409,
  'password-locked': 423,
  'no-identity': 403,
}

/** 提交一次改密（`{ ticketId, oldPassword, newPassword }`）。 */
export async function handleSecurePassword(
  req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const port = deps.tryPassword()
  if (port === undefined) {
    // 没装 `bank:tools` 的 profile 没有改密能力：501 比 500 诚实（"未实现"≠"实现炸了"）
    sendError(res, 501, 'password-handoff-unavailable', '本部署没有装配交易密码能力（缺 bank:tools）')
    return
  }

  const body = await readJson(req)
  const ticketId = readBodyString(body, 'ticketId')
  const oldPassword = readBodyString(body, 'oldPassword')
  const newPassword = readBodyString(body, 'newPassword')
  if (ticketId === undefined || !TICKET_PATTERN.test(ticketId)) {
    sendError(res, 400, 'web-invalid-ticket', '票据 ID 缺失或格式非法')
    return
  }
  if (oldPassword === undefined || newPassword === undefined) {
    // 只报"缺哪个字段"，**不**回显任何值（连长度都不报：长度也是密码材料）
    sendError(res, 400, 'web-invalid-body', 'oldPassword 与 newPassword 都必填')
    return
  }

  try {
    // 身份只从会话来：`static` 模式的 HTTP 主体是 `svc:web`，不是客户号
    const result = await port.submit(String(deps.session.sessionId), {
      ticketId,
      oldPassword,
      newPassword,
    })
    sendJson(res, 200, { ok: true, changedAt: result.changedAt })
  } catch (error) {
    // 用全仓唯一的错误归一化（`verify-single-error-normalization`）：未登记的码继续向上抛，
    // 由 `sendThrown` 记 500——把"没预料到的失败"伪装成 400 会让排障失去线索。
    const code = errorCodeOf(error, 'web-internal')
    const status = PASSWORD_ERROR_STATUS[code]
    if (status === undefined) throw error
    sendError(res, status, code, reasonOf(error))
  }
}
