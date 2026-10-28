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
import { isLoopbackAddress, readAdminToken, tokenMatches } from '../web-admin.ts'

/**
 * 管理面统一闸。
 *
 * @returns `true` = 已放行，调用方继续；`false` = 已写好错误响应
 */
export async function guardAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  const token = readAdminToken(process.env)
  if (token === undefined) {
    sendError(res, 404, 'web-not-found', '没有这个资源')
    return false
  }
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    sendError(res, 403, 'web-admin-forbidden', '管理路由只接受本机回环请求')
    return false
  }
  if (method !== 'POST') {
    sendError(res, 405, 'web-method-not-allowed', `${method} ${path} 不被支持`)
    return false
  }
  if (!tokenMatches(token, req.headers.authorization)) {
    sendError(res, 401, 'web-admin-unauthorized', '缺少或错误的 admin token')
    return false
  }
  return true
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
