/**
 * 认证 cookie 的两个头（租户与鉴权 02 · TA-26）。
 *
 * ## A1：会话令牌只走 `HttpOnly` Cookie
 *
 * 页面里可读的东西 XSS 就能读；URL 里的东西代理与历史记录能读。
 * 所以 `bah_sid` 带 `HttpOnly`，且**永远不出现**在响应体里（`/api/auth/me` 也不回 `sid`）。
 *
 * ## 为什么 `SameSite=Strict` 而不是 `Lax`
 *
 * 银行场景不需要"从外站点进来还保持登录态"的体验；`Strict` 让跨站发起的请求根本不带 cookie，
 * 等于在 CSRF 之外多一道。代价是外部链接点进来要重新登录一次——可接受。
 *
 * ## 为什么 CSRF cookie 不带 `HttpOnly`
 *
 * double-submit 要求同源脚本能读出来回填请求头（`csrf.ts` 的注释写了这条权衡）。
 */

/** 会话 cookie 的属性拼装（`Max-Age` 与绝对寿命一致）。 */
function attributes(maxAgeSec: number, secure: boolean, httpOnly: boolean): string {
  return [
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${String(Math.max(0, Math.floor(maxAgeSec)))}`,
    ...(httpOnly ? ['HttpOnly'] : []),
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

/**
 * 会话 cookie（`HttpOnly`）。
 *
 * @param name cookie 名（配置 `auth.cookie.name`，缺省 `bah_sid`）
 * @param sid 会话 ID（`randomBytes(32).toString('base64url')`，字符集安全，无需转义）
 * @param maxAgeSec 存活秒数（= `absoluteMs / 1000`）
 * @param secure HTTPS 部署必须 true
 */
export function sessionCookieHeader(
  name: string,
  sid: string,
  maxAgeSec: number,
  secure: boolean,
): string {
  return `${name}=${sid}; ${attributes(maxAgeSec, secure, true)}`
}

/** 清会话 cookie（登出；`Max-Age=0` 让浏览器立即丢弃）。 */
export function clearSessionCookieHeader(name: string, secure: boolean): string {
  return `${name}=; ${attributes(0, secure, true)}`
}
