/**
 * `handoff` 处理器（C5）：`GET` 读摘要、`POST` 请求接管、`POST /resume` 交回。
 *
 * 三条路由共用一个处理器（与 `admin` 相同的做法）：它们的鉴权面、状态码集合与
 * 状态机是同一件事的三个动作，拆成三个文件只会让"哪个动作改了状态"更难追。
 *
 * 事件由 `HandoffRegistry` 落（`handoff/requested` / `handoff/resumed`，
 * `appendDomain` + `ignorable`）；本文件只管 HTTP 形状。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { describeThrown } from '@bah/core'
import type { Principal } from '@bah/util'

import type { WebDeps, WebRequest } from '../deps.ts'
import { readBodyString, readJson, sendError, sendJson } from '../http.ts'

/** 交回路由的精确路径（与 `router.ts` 的同名常量同源，这里只做本地判别）。 */
const RESUME_PATH = '/api/handoff/resume'

/** 本次请求的主体（匿名 / 未挂身份 → `undefined`）。 */
function principalOf(request: WebRequest): Principal | undefined {
  const identity = request.identity
  if (identity === undefined || identity.kind === 'anonymous') return undefined
  return identity.principal
}

export async function handleHandoff(
  req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  if (request.method === 'GET') {
    sendJson(res, 200, deps.handoff.summary())
    return
  }

  if (request.path === RESUME_PATH) {
    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch (error) {
      sendError(res, 400, 'web-invalid-body', describeThrown(error))
      return
    }
    // 交回没有 body 契约：操作者来自登录主体。带任何字段都是客户端在自报身份。
    const forged = Object.keys(body)[0]
    if (forged !== undefined) {
      sendError(res, 400, 'web-invalid-body', `未知字段：${forged}（操作者从登录主体派生）`)
      return
    }
    const result = deps.handoff.resume(principalOf(request)?.userId)
    if (!result.ok) {
      sendError(res, 409, result.code, '会话当前不在人工接管中，无需交回')
      return
    }
    sendJson(res, 200, result.summary)
    return
  }

  let body: Record<string, unknown>
  try {
    body = await readJson(req)
  } catch (error) {
    sendError(res, 400, 'web-invalid-body', describeThrown(error))
    return
  }
  // 主体字段一律从登录态派生；body 里出现任何非 reason 字段就是 400（03 TA-45）
  const forged = Object.keys(body).find((key) => key !== 'reason')
  if (forged !== undefined) {
    sendError(res, 400, 'web-invalid-body', `未知字段：${forged}（操作者从登录主体派生）`)
    return
  }
  const reason = readBodyString(body, 'reason')
  // 谁请求的接管：登录主体（03 TA-45），不接受 body 自报
  const result = deps.handoff.enter(reason, principalOf(request)?.userId)
  if (!result.ok) {
    sendError(
      res,
      409,
      result.code,
      '会话已处于人工接管中（重复请求不刷新进入时间，避免"已等多久"失真）',
    )
    return
  }
  sendJson(res, 200, result.summary)
}
