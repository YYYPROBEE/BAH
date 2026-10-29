/**
 * 管理面统一闸（W16 从 `web.ts` 拆出）。
 *
 * 状态码顺序是硬约束（HP-0 §3.2，W07 沿用）：
 * **"路由是否存在"必须排在最前**——没配 token 时无论用什么方法打过来都返回 404，
 * 否则一个 `GET` 拿到 405 就等于告诉扫描器"这里有个管理口，只是方法不对"。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { describeThrown } from '@bah/core'

import { readJson, sendError } from './http.ts'
import { isLoopbackAddress, readAdminOperators, tokenMatches } from '../web-admin.ts'

/** 管理面闸的结果：放行时必须带回**操作员 id**（03 TA-44，审计的"谁"不可伪造）。 */
export type AdminGuardResult =
  | { readonly ok: true; readonly operator: string }
  | { readonly ok: false }

/**
 * 管理面统一闸。
 *
 * @returns `{ok:true, operator}` = 已放行，调用方继续；`{ok:false}` = 已写好错误响应
 */
export async function guardAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<AdminGuardResult> {
  const parsed = readAdminOperators(process.env)
  if (!parsed.ok) {
    // 坏配置 fail-closed：503 而不是静默当成"没配 token"（那会变 404，运维以为功能没开）。
    // 但先判回环：坏配置不该让局域网扫描器看到 503（那等于确认管理口存在）。
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendError(res, 403, 'web-admin-forbidden', '管理路由只接受本机回环请求')
      return { ok: false }
    }
    console.error(`[web-admin] ${parsed.reason}；管理面拒绝服务（503）`)
    sendError(res, 503, 'web-admin-unavailable', '管理面操作员配置无效')
    return { ok: false }
  }
  if (parsed.operators.length === 0) {
    sendError(res, 404, 'web-not-found', '没有这个资源')
    return { ok: false }
  }
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    sendError(res, 403, 'web-admin-forbidden', '管理路由只接受本机回环请求')
    return { ok: false }
  }
  if (method !== 'POST') {
    sendError(res, 405, 'web-method-not-allowed', `${method} ${path} 不被支持`)
    return { ok: false }
  }
  // 遍历全部操作员（不提前返回）：命中位置不通过耗时泄漏。
  let operator: string | undefined
  for (const candidate of parsed.operators) {
    if (tokenMatches(candidate.token, req.headers.authorization)) operator = candidate.id
  }
  if (operator === undefined) {
    sendError(res, 401, 'web-admin-unauthorized', '缺少或错误的 admin token')
    return { ok: false }
  }
  return { ok: true, operator }
}

/** 读管理面 JSON body；坏体 / 过大一律 400（客户端问题不许报 500）。 */
export async function readAdminBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false }> {
  try {
    return { ok: true, body: await readJson(req) }
  } catch (error) {
    sendError(res, 400, 'web-admin-invalid-body', describeThrown(error))
    return { ok: false }
  }
}
