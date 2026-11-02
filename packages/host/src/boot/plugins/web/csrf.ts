/**
 * `channel:web` 的 CSRF 闸（W09 新增，W16 从 `web.ts` 拆出）。
 *
 * 两条放行路径，都要求**写方法**：
 * 1. 同源 `Origin`（浏览器表单/fetch 一定带；跨站带的是别人的 Origin）；
 * 2. double-submit：`bah_csrf` cookie 与 `x-bah-csrf` 头都存在、相等、且等于进程内的值。
 *
 * 为什么 cookie **不是 HttpOnly**：同源脚本要读出来回填请求头。代价是同源 XSS 能读 cookie——
 * 但同源 XSS 本来就能以用户身份直接发请求，所以这不是新增的攻击面（CSP 只允许同源脚本）。
 *
 * 顺序纪律（W09 §2.3）：限流 → 管理路由（豁免）→ Bearer 401 → **本闸 403** → 业务 423/409。
 * 反过来会把"缺凭证"报成 403，或把"停机"误报成跨站攻击。
 */

import type { IncomingMessage } from 'node:http'

import { readCookie } from './http.ts'

/** double-submit cookie 与请求头（前端同批读取 cookie 后回填）。 */
export const CSRF_COOKIE = 'bah_csrf'
export const CSRF_HEADER = 'x-bah-csrf'

/** 需要 CSRF 的写方法（GET/HEAD 与 SSE 不受影响）。 */
export const CSRF_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'DELETE'])

/** CSRF 结论：`pass` 放行；`missing` 什么都没带；`mismatch` 带了但对不上。 */
export type CsrfVerdict = 'pass' | 'missing' | 'mismatch'

/** 同源判定的开关（`secure` 即"整站 HTTPS"的部署开关）。 */
export interface CsrfOriginOptions {
  /** `true` 时允许 `https:` 的 Origin；否则只认 `http:`。 */
  readonly allowHttps?: boolean
}

/**
 * `Origin` 与 `Host` 是否同源（**只比 host 段**，不比 path）。
 *
 * 为什么不再写死 `http://`：反代 / HTTPS 部署下，浏览器的 Origin 是 `https://…`
 * 而内部请求仍是 http；旧比较式会让所有写请求 403。协议只做"是否允许 https"的开关
 * （`allowHttps = cookie.secure`：要么整站 HTTPS，要么整站 HTTP）。
 *
 * 端口必须比：`http://a:7331` 与 `Host: a:7331` 一致才算同源；默认端口由 `URL` 归一化
 * （`https://a:443` 与 `Host: a` 视为同源）。
 */
export function sameOriginHost(
  origin: string,
  host: string | undefined,
  options: CsrfOriginOptions = {},
): boolean {
  if (host === undefined || host.trim() === '') return false
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '') return false
  // 协议开关是**二选一**：secure=true ⇔ 整站 HTTPS；secure=false ⇔ 整站 HTTP。
  // 允许 http 与 https 同时通过会留下降级面（HTTPS 站点在 http 入口上被 CSRF）。
  if (parsed.protocol === 'https:') {
    if (options.allowHttps !== true) return false
  } else if (parsed.protocol === 'http:') {
    if (options.allowHttps === true) return false
  } else {
    return false
  }
  let target: URL
  try {
    // Host 可能是 `a:7331` / `[::1]:7331`；用同一协议解析，默认端口会被 URL 归一化
    target = new URL(`${parsed.protocol}//${host.trim()}`)
  } catch {
    return false
  }
  return parsed.host.toLowerCase() === target.host.toLowerCase()
}

/** 写请求的 CSRF 结论（同源 `Origin` 直接放行；否则要求 double-submit 一致）。 */
export function csrfVerdict(
  req: IncomingMessage,
  expected: string,
  options: CsrfOriginOptions = {},
): CsrfVerdict {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    return sameOriginHost(origin, req.headers.host, options) ? 'pass' : 'mismatch'
  }
  const cookie = readCookie(req.headers.cookie, CSRF_COOKIE)
  const header = req.headers[CSRF_HEADER]
  const presented = typeof header === 'string' ? header : undefined
  if (cookie === undefined && presented === undefined) return 'missing'
  if (cookie === undefined || presented === undefined) return 'mismatch'
  return cookie === presented && presented === expected ? 'pass' : 'mismatch'
}

/**
 * 下发 cookie 的完整头（`SameSite=Strict` + `Path=/`，**不带** HttpOnly）。
 *
 * @param token CSRF 令牌
 * @param maxAgeSec 存活秒数。**登录后必须与 `bah_sid` 一致**（AR-07 陷阱 2）：
 *   会话 cookie 是持久的而 CSRF 是会话 cookie 时，用户第二天打开页面 → 身份还在、CSRF 没了
 *   → 每个写请求 403 `web-csrf-required`，而"刷新一下"未必修得好。
 *   缺省不带 `Max-Age`（= 会话 cookie，与改动前的行为一致）。
 */
export function csrfCookieHeader(token: string, maxAgeSec?: number): string {
  const parts = [`${CSRF_COOKIE}=${token}`, 'Path=/', 'SameSite=Strict']
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${String(Math.max(0, Math.floor(maxAgeSec)))}`)
  return parts.join('; ')
}
