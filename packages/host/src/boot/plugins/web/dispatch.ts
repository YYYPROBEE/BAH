/**
 * `channel:web` 的请求分派（W16 新建）。
 *
 * 拆分前这是一条 180 行的 `if` 链，闸与路由混在一起；现在闸按**路由表的 `auth` 字段**决定，
 * 顺序仍然逐字保留（W09 §2.3 的硬约束）：
 *
 * 限流 429 → 管理面（豁免）→ Bearer 401 → CSRF 403 → 业务 423/409 → 静态 404 → 405。
 *
 * 为什么闸不写在 handler 里：一条路由漏写就是一次绕过，而"漏写"在 `if` 链里看不出来。
 * 闸只有这一处，路由表只有方法/路径/状态码三元组。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebSettings } from './config.ts'
import { CSRF_METHODS, csrfVerdict } from './csrf.ts'
import type { WebDeps, WebHandler, WebRequest } from './deps.ts'
import { handleAdmin } from './handlers/admin.ts'
import { handleApproval, handleVerify } from './handlers/approval.ts'
import {
  handleEvents,
  handleHealth,
  handleInterrupt,
  handleSession,
  handleTurn,
} from './handlers/session.ts'
import { handleStatic } from './handlers/static.ts'
import { handleFork } from './handlers/fork.ts'
import { handleHandoff } from './handlers/handoff.ts'
import {
  handleHandoffClaim,
  handleHandoffHeartbeat,
  handleHandoffMessage,
  handleHandoffQueue,
} from './handlers/handoff-message.ts'
import { handleMetrics } from './handlers/metrics.ts'
import { handleTrace } from './handlers/trace.ts'
import { sendError } from './http.ts'
import { METHOD_NOT_ALLOWED_CODE, METHOD_NOT_ALLOWED_STATUS, matchRoute, type RouteHandler } from './router.ts'
import { startHttpSpan } from './trace.ts'
import { presentedPrincipal } from '../web-operator.ts'

/** 处理器查表（键与 `RouteHandler` 一一对应）。 */
const HANDLERS: Readonly<Record<RouteHandler, WebHandler>> = {
  health: handleHealth,
  session: handleSession,
  events: handleEvents,
  metrics: handleMetrics,
  trace: handleTrace,
  turn: handleTurn,
  interrupt: handleInterrupt,
  approval: handleApproval,
  verify: handleVerify,
  handoff: handleHandoff,
  'handoff-message': handleHandoffMessage,
  'handoff-claim': handleHandoffClaim,
  'handoff-heartbeat': handleHandoffHeartbeat,
  'handoff-queue': handleHandoffQueue,
  fork: handleFork,
  admin: handleAdmin,
  static: handleStatic,
}

/**
 * 造一个请求监听器。
 *
 * 闸的判定只看 `path` 与方法（不看命中的 spec 是否恰好是它）：
 * 未命中的 `/api/*` 也必须先过限流与凭证，否则"打一个不存在的接口"就成了免鉴权探测。
 */
export function createDispatcher(
  config: WebSettings,
  deps: WebDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const path = url.pathname
    const isApi = path.startsWith('/api/')
    const match = matchRoute(method, path)
    const isAdmin = match?.spec.auth === 'admin'

    // 可观测性 01：一条请求一个 `http.request` span。
    // 收尾挂在 `res.once('close')`，所以下面 6 个提前 return 全都被覆盖，
    // 闸的顺序一个字都不用改（`route` 取模板，未命中记 `unmatched`——不记原始 URL）。
    startHttpSpan(deps.tryTelemetry(), req, res, match?.spec.path ?? 'unmatched')

    // 限流先于凭证：脚本误刷与重连风暴不该消耗票据查询/验签资源。
    if (isApi) {
      const verdict = deps.rateLimiter.check(req.socket.remoteAddress ?? 'unknown', deps.now())
      if (!verdict.ok) {
        res.setHeader('retry-after', String(verdict.retryAfterSec))
        sendError(
          res,
          429,
          'web-rate-limited',
          `请求过于频繁，请 ${String(verdict.retryAfterSec)} 秒后重试`,
        )
        return
      }
    }

    const auth = match?.spec.auth

    // 坐席面未配置 ⇒ 路由不存在。放在鉴权之前：401 会告诉探测者"这里有东西"。
    if (auth === 'operator' && deps.operatorToken === undefined) {
      sendError(res, 404, 'web-not-found', `没有这个资源：${path}`)
      return
    }

    // 身份解析（D5）：`web` = 任一有效凭证；`user` = 仅客户；`operator` = 仅坐席。
    // SSE 例外：`EventSource` 不能设请求头，只能带 `?token=`——只对 GET /api/events 放宽。
    const queryToken =
      method === 'GET' && path === '/api/events' ? url.searchParams.get('token') : null
    const principal = presentedPrincipal(req.headers, queryToken, {
      webToken: deps.webToken,
      operatorToken: deps.operatorToken,
    })

    if (isApi && !isAdmin && auth !== 'public') {
      if (principal === undefined) {
        sendError(res, 401, 'web-unauthorized', '缺少或错误的访问凭证')
        return
      }
      // 坐席不能替客户发消息 / 打断（D9）；401 而不是 403：不暴露"你可以但你没权限"
      if (auth === 'user' && principal !== 'user') {
        sendError(res, 401, 'web-unauthorized', '该接口只接受客户凭证')
        return
      }
      if (auth === 'operator' && principal !== 'operator') {
        sendError(res, 401, 'web-unauthorized', '该接口只接受坐席凭证')
        return
      }
    }

    // W09 CSRF：鉴权之后、业务之前。管理面已在上一步排除（豁免 CLI 客户端）；
    // 缺凭证仍是 401，不会被 CSRF 抢成 403；`/api/turn` 的 HALT 423 仍由 agent.send 产生。
    if (config.csrf.enabled && isApi && !isAdmin && CSRF_METHODS.has(method)) {
      const csrf = csrfVerdict(req, deps.csrfToken)
      if (csrf !== 'pass') {
        sendError(
          res,
          403,
          csrf === 'missing' ? 'web-csrf-required' : 'web-csrf-forbidden',
          csrf === 'missing' ? '写请求缺少同源 Origin 或 CSRF 令牌' : '写请求的 CSRF 校验失败',
        )
        return
      }
    }

    if (match === undefined) {
      sendError(res, METHOD_NOT_ALLOWED_STATUS, METHOD_NOT_ALLOWED_CODE, `${method} ${path} 不被支持`)
      return
    }

    const request: WebRequest = {
      method,
      url,
      path,
      rest: match.rest,
      ...(principal === undefined ? {} : { principal }),
    }
    await HANDLERS[match.spec.handler](req, res, request, deps)
  }
}
