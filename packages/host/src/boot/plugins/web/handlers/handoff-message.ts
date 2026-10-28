/**
 * 坐席动作的四条路由：认领 / 发言 / 心跳 / 队列。
 *
 * 与 `handlers/handoff.ts`（客户侧三条：读摘要 / 请求接管 / 交回）分开：
 * 这里的每一条都要求 `auth:'operator'`，而客户侧是 `web`/`operator` 混合。
 * 分文件让"哪条路由是坐席面"在目录结构上就能看出来。
 *
 * 纪律：`operator` 一律取 `deps.operatorName`（来自部署配置），**不读 body**（I1）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { describeThrown } from '@bah/core'

import type { WebDeps, WebRequest } from '../deps.ts'
import { readBodyString, readJson, sendError, sendJson } from '../http.ts'

/** `POST /api/handoff/claim` —— 坐席认领（幂等；换人 409）。 */
export async function handleHandoffClaim(
  _req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const result = deps.handoff.claim(deps.operatorName)
  if (!result.ok) {
    sendError(
      res,
      409,
      result.code,
      result.code === 'handoff-not-active'
        ? '会话当前不在人工接管中，无需认领'
        : '会话已被其他坐席认领',
    )
    return
  }
  sendJson(res, 200, result.summary)
}

/** `POST /api/handoff/message` —— 坐席发言（D3：落领域事件，不进模型历史）。 */
export async function handleHandoffMessage(
  req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  let body: Record<string, unknown>
  try {
    // 与 handlers/handoff.ts 同款：坏 body 一律 400，不把解析错误讲成 409
    body = await readJson(req)
  } catch (error) {
    sendError(res, 400, 'web-invalid-body', describeThrown(error))
    return
  }
  const text = readBodyString(body, 'text') ?? ''
  const result = deps.handoff.say(deps.operatorName, text)
  if (!result.ok) {
    const status =
      result.code === 'handoff-not-active'
        ? 409
        : result.code === 'handoff-text-too-long'
          ? 413
          : 400
    sendError(res, status, result.code, describeSay(result.code))
    return
  }
  sendJson(res, 200, { ok: true, seq: result.seq })
}

/** `POST /api/handoff/heartbeat` —— 等待时长与超时判定（D6：只告警，不自动交回）。 */
export async function handleHandoffHeartbeat(
  _req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const beat = deps.handoff.heartbeat()
  sendJson(res, 200, { ok: true, waitedMs: beat.waitedMs, overdue: beat.overdue })
}

/** `GET /api/handoff/queue` —— 单会话架构下的"队列"恒 0 或 1（D7）。 */
export async function handleHandoffQueue(
  _req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const summary = deps.handoff.summary()
  sendJson(res, 200, {
    depth: summary.active ? 1 : 0,
    items: summary.active
      ? [
          {
            sessionId: summary.sessionId,
            waitedMs: summary.waitedMs,
            claimed: summary.claimed,
            overdue: summary.overdue,
            reason: summary.reason ?? null,
          },
        ]
      : [],
    // 明确写清能力边界，避免前端以为这是可扩展的队列
    note: 'single-session deployment: depth ∈ {0,1}',
  })
}

/** 发言失败的可读理由（错误码是给机器的，reason 是给人看的）。 */
function describeSay(code: string): string {
  switch (code) {
    case 'handoff-not-active':
      return '会话当前不在人工接管中，无法发言'
    case 'handoff-text-empty':
      return '发言内容不能为空'
    case 'handoff-text-too-long':
      return '发言内容超过 2000 字符上限，请分段发送'
    default:
      return '发言失败'
  }
}
