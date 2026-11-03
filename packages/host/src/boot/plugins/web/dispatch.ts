/**
 * `channel:web` 的请求分派（W16 新建）。
 *
 * 拆分前这是一条 180 行的 `if` 链，闸与路由混在一起；现在闸按**路由表的 `auth` 字段**决定，
 * 顺序仍然逐字保留（W09 §2.3 的硬约束）：
 *
 * 限流 429 → 管理面（自身 token，豁免 CSRF）→ Bearer 401（static 双凭证 / password 会话）
 * → 角色 403 → CSRF 403 → 业务 423/409 → 静态 404 → 405。
 *
 * 02 起"Bearer 401"换成"身份 401"：`static` 模式的身份解析内部做双凭证比对，
 * `password` 模式读会话 cookie。03 把"该不该进"集中到 `authz/authorize.ts`（Z1），
 * 本文件只留一个调用点。**闸仍然只有这一处**——身份/角色不通过的请求走不到 handler。
 *
 * 为什么角色 403 排在 CSRF 之前：两处都回 403，但顺序反了会让跨站请求先被 CSRF 拦下，
 * 日志里就看不出"越权意图"（03 TA-42 的反例）。身份仍在角色之前：匿名是 401，不是 403。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebSettings } from './config.ts'
import { CSRF_METHODS, csrfVerdict } from './csrf.ts'
import type { WebDeps, WebHandler, WebRequest } from './deps.ts'
import { authorize, type AuthorizeSpec } from './authz/authorize.ts'
import { handleAdmin } from './handlers/admin.ts'
import { handleApproval, handleVerify } from './handlers/approval.ts'
import { handleSecurePassword } from './handlers/password.ts'
import {
  handleEvents,
  handleHealth,
  handleInterrupt,
  handleSession,
  handleTurn,
} from './handlers/session.ts'
import { AUTH_HANDLERS } from './handlers/auth.ts'
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
import { handleSessionList, handleSessionRead } from './handlers/sessions.ts'
import { handleSuggest } from './handlers/suggest.ts'
import { handleTrace } from './handlers/trace.ts'
import { sendError } from './http.ts'
import { METHOD_NOT_ALLOWED_CODE, METHOD_NOT_ALLOWED_STATUS, matchRoute, type RouteHandler } from './router.ts'
import { startHttpSpan } from './trace.ts'

/** 处理器查表（键与 `RouteHandler` 一一对应）。 */
const HANDLERS: Readonly<Record<RouteHandler, WebHandler>> = {
  health: handleHealth,
  session: handleSession,
  sessions: handleSessionList,
  'session-read': handleSessionRead,
  events: handleEvents,
  metrics: handleMetrics,
  trace: handleTrace,
  turn: handleTurn,
  suggest: handleSuggest,
  interrupt: handleInterrupt,
  approval: handleApproval,
  verify: handleVerify,
  'secure-password': handleSecurePassword,
  handoff: handleHandoff,
  'handoff-message': handleHandoffMessage,
  'handoff-claim': handleHandoffClaim,
  'handoff-heartbeat': handleHandoffHeartbeat,
  'handoff-queue': handleHandoffQueue,
  fork: handleFork,
  admin: handleAdmin,
  login: AUTH_HANDLERS.login,
  logout: AUTH_HANDLERS.logout,
  me: AUTH_HANDLERS.me,
  static: handleStatic,
}

/** 未命中路由时的合成 spec（TA-42 边界 1/2）。 */
const UNMATCHED_API_SPEC: AuthorizeSpec = { auth: 'web' }
const UNMATCHED_STATIC_SPEC: AuthorizeSpec = { auth: 'static' }

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

    // 坐席面未启用 ⇒ 路由不存在。放在身份解析之前：401 会告诉探测者"这里有东西"。
    // 作用面：5 条坐席 API（resume/message/claim/heartbeat/queue）与 `/operator` 页面
    // （后者在 handleStatic 里判，因为它是静态路由）。
    if (match?.spec.seat === true && !deps.seatApiEnabled) {
      sendError(res, 404, 'web-not-found', `没有这个资源：${path}`)
      return
    }

    // 身份解析（02 TA-25）：**唯一**一次；结果挂到 WebRequest，handler 不再自己解析。
    // 失败且该路由需要主体 → 401。三种模式的区别都在 deps.auth.identify 内部，
    // 这里不写任何 `mode === ...` 分支（否则闸就有第二份真相）。
    const identity = deps.auth.identify(req, deps.now())
    // 授权（03 TA-42）：**唯一**的角色判定点。未命中的路由也有合成 spec——
    // `/api/*` 视为需要身份的业务面，其余视为静态面（走到 405）。
    // 角色 403 必须排在 CSRF 之前（否则越权意图会被 CSRF 的 403 掩盖）。
    const verdict = authorize({
      identity,
      spec: match?.spec ?? (isApi ? UNMATCHED_API_SPEC : UNMATCHED_STATIC_SPEC),
      method,
      path,
      isApi,
    })
    if (!verdict.ok) {
      sendError(res, verdict.status, verdict.code, verdict.reason)
      return
    }

    // W09 CSRF：鉴权之后、业务之前。管理面已在上一步排除（豁免 CLI 客户端）；
    // 缺凭证仍是 401，不会被 CSRF 抢成 403；`/api/turn` 的 HALT 423 仍由 agent.send 产生。
    if (config.csrf.enabled && isApi && !isAdmin && CSRF_METHODS.has(method)) {
      const csrf = csrfVerdict(req, deps.auth.csrfExpectation(identity), {
        // 同一个开关：cookie.secure=true ⇔ 整站 HTTPS（Origin 允许 https:）
        allowHttps: deps.auth.cookie.secure,
      })
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

    const request: WebRequest = { method, url, path, rest: match.rest, identity }
    await HANDLERS[match.spec.handler](req, res, request, deps)
  }
}
