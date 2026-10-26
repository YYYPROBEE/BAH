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
import { sendError } from './http.ts'
import { METHOD_NOT_ALLOWED_CODE, METHOD_NOT_ALLOWED_STATUS, matchRoute, type RouteHandler } from './router.ts'
import { tokenMatches } from '../web-admin.ts'
import { presentedWebToken } from '../web-auth.ts'

/** 处理器查表（键与 `RouteHandler` 一一对应）。 */
const HANDLERS: Readonly<Record<RouteHandler, WebHandler>> = {
  health: handleHealth,
  session: handleSession,
  events: handleEvents,
  turn: handleTurn,
  interrupt: handleInterrupt,
  approval: handleApproval,
  verify: handleVerify,
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

    // Web 凭证检查（D5 最小集）：除探活与管理面外，所有 `/api/*` 一律先验 Bearer。
    // SSE 例外：`EventSource` 不能设请求头，只能带 `?token=`——只对 GET /api/events 放宽。
    if (isApi && !isAdmin && match?.spec.auth !== 'public') {
      const queryToken =
        method === 'GET' && path === '/api/events' ? url.searchParams.get('token') : null
      if (!tokenMatches(deps.webToken, presentedWebToken(req.headers, queryToken))) {
        sendError(res, 401, 'web-unauthorized', '缺少或错误的访问凭证')
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

    const request: WebRequest = { method, url, path, rest: match.rest }
    await HANDLERS[match.spec.handler](req, res, request, deps)
  }
}
