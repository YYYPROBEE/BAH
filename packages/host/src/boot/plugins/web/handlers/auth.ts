/**
 * 三条认证路由的处理器（租户与鉴权 02 · TA-26）：登录 / 登出 / 自查。
 *
 * ## 回包纪律
 *
 * **任何回包都不含 `sid`**：cookie 已经把会话带过去了，回包再带一遍等于给 XSS 一个读点
 * （`HttpOnly` 挡的是 `document.cookie`，挡不住 JS 读响应体）。
 *
 * ## 登录失败的同形（A2）
 *
 * "用户不存在"与"口令错"必须**同状态码、同 body、同耗时量级**：
 * 否则这个接口就是一个用户枚举器。耗时由 `identity.login` 里的 dummy 校验抹平；
 * 这里两个分支共用同一段回包代码。
 *
 * ## 两个 cookie 的正确下发方式（AR-07 的实现陷阱）
 *
 * `sendJson` 内部是 `res.writeHead(status, {...})`，它会**保留**此前 `setHeader` 设过的头。
 * 所以顺序是"先 `setHeader('set-cookie', [a, b])` 再 `sendJson`"；
 * 若把两条 cookie 拼成一个字符串，Node 只会发一条（或把第二条塞进第一条的属性里）。
 */


import type { WebDeps, WebHandler, WebRequest } from '../deps.ts'
import { csrfCookieHeader, CSRF_COOKIE } from '../csrf.ts'
import { readBodyString, readJson, sendError, sendJson } from '../http.ts'
import { clearSessionCookieHeader, sessionCookieHeader } from '../auth/cookies.ts'

/** 登录回包（**不含 sid**）。 */
interface LoginBody {
  readonly userId: string
  readonly roles: readonly string[]
  readonly expiresAt: number
}

/** 登录。 */
export const handleLogin: WebHandler = async (req, res, _request, deps) => {
  if (deps.auth.mode !== 'password') {
    // static/none 下没有登录这回事：路由存在但明确说"没开启"，不是 404（免探测）
    sendError(res, 409, 'web-auth-disabled', '本部署没有开启登录（auth.mode 不是 password）')
    return
  }
  let body: Record<string, unknown>
  try {
    body = await readJson(req)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'web-invalid-body'
    sendError(res, 400, code, '登录请求体必须是 JSON 对象')
    return
  }
  const userId = readBodyString(body, 'userId')?.trim() ?? ''
  const password = readBodyString(body, 'password') ?? ''
  if (userId === '' || password === '') {
    sendError(res, 400, 'web-login-invalid', '需要 userId 与 password')
    return
  }

  const result = await deps.auth.login({
    userId,
    password,
    ip: req.socket.remoteAddress ?? 'unknown',
  })
  if (!result.ok) {
    if (result.retryAfterSec !== undefined) {
      res.setHeader('retry-after', String(result.retryAfterSec))
    }
    if (result.code === 'web-login-locked') {
      sendError(res, 409, 'web-login-locked', '尝试过于频繁，请稍后再试')
      return
    }
    sendError(res, 401, 'web-login-failed', '账号或口令不正确')
    return
  }

  const payload: LoginBody = {
    userId: result.principal.userId,
    roles: [...result.principal.roles],
    expiresAt: result.session.absoluteExpiresAt,
  }
  // 两条 cookie **必须用数组**（见模块注释）；CSRF 与 sid 同一个 Max-Age（AR-07 陷阱 2）
  res.setHeader('set-cookie', [
    sessionCookieHeader(
      deps.auth.cookie.name,
      result.session.sid,
      deps.auth.cookie.maxAgeSec,
      deps.auth.cookie.secure,
    ),
    csrfCookieHeader(result.session.csrf, deps.auth.cookie.maxAgeSec),
  ])
  sendJson(res, 200, payload)
}

/** 登出（幂等：没有会话也 200，但会清 cookie）。 */
export const handleLogout: WebHandler = async (_req, res, request, deps) => {
  const identity = request.identity
  if (identity !== undefined) deps.auth.logout(identity, deps.now())
  res.setHeader('set-cookie', [
    clearSessionCookieHeader(deps.auth.cookie.name, deps.auth.cookie.secure),
    `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0`,
  ])
  sendJson(res, 200, { ok: true })
}

/** 自查：当前主体是谁（`static` 模式返回合成服务主体）。 */
export const handleMe: WebHandler = async (_req, res, request, deps) => {
  // 身份由 dispatch 预解析并挂在 request 上（只有一处解析）；这里拿不到就是匿名
  const identity = request.identity
  if (identity === undefined || identity.kind === 'anonymous') {
    sendError(res, 401, 'web-unauthorized', '缺少或失效的登录状态')
    return
  }
  if (identity.kind === 'service') {
    sendJson(res, 200, {
      tenant: String(deps.tenantId),
      userId: identity.principal.userId,
      roles: [...identity.principal.roles],
      expiresAt: null,
      mode: deps.auth.mode,
    })
    return
  }
  sendJson(res, 200, {
    tenant: String(deps.tenantId),
    userId: identity.principal.userId,
    roles: [...identity.principal.roles],
    expiresAt: identity.session.absoluteExpiresAt,
    mode: deps.auth.mode,
  })
}

/** 认证路由的处理器表。 */
export const AUTH_HANDLERS: Readonly<Record<'login' | 'logout' | 'me', WebHandler>> = {
  login: handleLogin,
  logout: handleLogout,
  me: handleMe,
}

/** 供 `dispatch.ts` 的查表使用（避免四张表各写一遍）。 */
export type AuthHandlerName = keyof typeof AUTH_HANDLERS
