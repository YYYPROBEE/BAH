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

/** 写请求的 CSRF 结论（同源 `Origin` 直接放行；否则要求 double-submit 一致）。 */
export function csrfVerdict(req: IncomingMessage, expected: string): CsrfVerdict {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    return origin === `http://${req.headers.host ?? ''}` ? 'pass' : 'mismatch'
  }
  const cookie = readCookie(req.headers.cookie, CSRF_COOKIE)
  const header = req.headers[CSRF_HEADER]
  const presented = typeof header === 'string' ? header : undefined
  if (cookie === undefined && presented === undefined) return 'missing'
  if (cookie === undefined || presented === undefined) return 'mismatch'
  return cookie === presented && presented === expected ? 'pass' : 'mismatch'
}

/** index 页面下发 cookie 的完整头（`SameSite=Strict` + `Path=/`，不带 HttpOnly）。 */
export function csrfCookieHeader(token: string): string {
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict`
}
