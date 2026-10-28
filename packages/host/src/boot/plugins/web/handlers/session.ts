/**
 * 会话面 handler（W16 从 `web.ts` 拆出）：探活 / 会话信息 / SSE / 提交 / 打断。
 *
 * 这五条路由的共同点是"读会话、改会话"，与审批、管理面无关；
 * 拆开之后它们不再需要认识 sentry、halt、admin token 里的任何一个。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { describeThrown } from '@bah/core'

import type { WebDeps, WebHandler, WebRequest } from '../deps.ts'
import { readBodyString, readJson, sendError, sendJson } from '../http.ts'

/**
 * 探活是唯一公开的 API：编排器与演示脚本只问"还活着吗"，不拿凭证。
 *
 * 只给数量：探针拿到 ID 就能绕过页面直接调审批/验证路由。
 */
export async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  sendJson(res, 200, {
    ok: true,
    lastSeq: deps.session.lastSeq(),
    pendingTicketCount: deps.adapter.pendingTickets().length,
  })
}

/** 会话信息与能力位（前端据此决定渲染哪些组件）。 */
export async function handleSession(
  _req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  sendJson(res, 200, {
    sessionId: String(deps.session.sessionId),
    lastSeq: deps.session.lastSeq(),
    capabilities: deps.adapter.capabilities,
  })
}

/** SSE：一条连接 = 一份快照 + 增量。 */
export async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const raw = request.url.searchParams.get('since') ?? '0'
  const since = Number(raw)
  if (!Number.isInteger(since) || since < 0) {
    sendError(res, 400, 'web-invalid-since', `since 必须是非负整数（收到 ${raw}）`)
    return
  }
  deps.hub.attach(req, res, since)
}

/** 提交一轮用户输入（202 表示已入队，不等模型结论）。 */
export async function handleTurn(
  req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const agent = deps.firstAgent()
  if (agent === undefined) {
    sendError(res, 503, 'agent-absent', '没有活体 agent：profile 缺少 core:agent 行')
    return
  }

  // ① 先读 body、先校验空消息：接管不能让 400 变成 409/202，也不能让坏 JSON
  //    被"正在接管"这个状态掩盖成另一种错误。
  const body = await readJson(req)
  const text = readBodyString(body, 'text') ?? ''
  let inbound
  try {
    inbound = deps.adapter.inbound({ text, at: deps.now() })
  } catch (error) {
    sendError(res, 400, 'web-empty-message', describeThrown(error))
    return
  }

  // ② C5-2：接管期间仍接收，但只落账、不驱动模型（I2 + I3 同时成立）。
  //    `sent === []` 依然成立；`source` 让前端与摘要都知道"这条是等人工的"。
  if (deps.handoff.active) {
    deps.session.append('user/message', { content: inbound.text, source: 'handoff-waiting' })
    sendJson(res, 202, { ok: true, accepted: 'queued-for-operator' })
    return
  }

  // ③ 以下与现状逐字不变（含 inbox-full 的 503）。
  //    HALT 判定在 `agent.send` 内部产生 423；接管期间压根不调它——停机停的是模型，不是人。
  try {
    agent.send(inbound.text)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'inbox-full') {
      sendError(res, 503, 'web-inbox-full', describeThrown(error))
      return
    }
    throw error
  }
  deps.ensureDriver(agent)
  sendJson(res, 202, { ok: true })
}

/** 打断当前 turn（理由进审计；缺省是"用户点击算了"）。 */
export async function handleInterrupt(
  req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const agent = deps.firstAgent()
  if (agent === undefined) {
    sendError(res, 503, 'agent-absent', '没有活体 agent')
    return
  }
  const body = await readJson(req)
  const reason = readBodyString(body, 'reason') ?? '用户点击"算了"'
  agent.interrupt(reason)
  sendJson(res, 200, { ok: true })
}

/** 会话面的路由表（dispatch 用；名字与 `RouteHandler` 一致）。 */
export const SESSION_HANDLERS: Readonly<Record<string, WebHandler>> = {
  health: handleHealth,
  session: handleSession,
  events: handleEvents,
  turn: handleTurn,
  interrupt: handleInterrupt,
}
