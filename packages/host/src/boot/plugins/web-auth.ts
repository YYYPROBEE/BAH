/**
 * Web 渠道的访问凭证（D5 最小鉴权集）。
 *
 * 三条边界：
 * 1. **默认可用**：没配 `BAH_WEB_TOKEN` 时启动期生成一次性 token，浏览器要能直接打开演示；
 * 2. **不进仓库**：token 只从环境变量读或进程内生成，绝不写死、绝不落审计；
 * 3. **页面即凭证载体**：服务端在 `index.html` 注入 `<meta name="bah-web-token">`，
 *    同源页面读它，跨源页面读不到（没有 CORS）。这是"最小集"的边界，不是完整登录。
 *    **`auth.mode: password` 下不得调用 `injectWebToken`**——调用等于把口令写进 HTML
 *    （02 TA-28 的缺口 1）；那条路改用 HttpOnly 会话 cookie。
 *
 * SSE 的 `EventSource` 不能设请求头，所以 `GET /api/events` 额外接受 `?token=`；
 * 其余接口只认 `Authorization: Bearer`。这条差异写进 `docs/web-frontend.md`。
 */

import { randomBytes } from 'node:crypto'

/** Web 访问 token 的环境变量名（只此一处）。 */
export const WEB_TOKEN_ENV = 'BAH_WEB_TOKEN'

/** 页面里承载 token 的 meta 名（前端按它读取）。 */
export const WEB_TOKEN_META = 'bah-web-token'

/**
 * 读环境里的 Web token。
 *
 * @returns 非空则返回；未设置或全空白返回 `undefined`（调用方据此生成一次性 token）
 */
export function readWebToken(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = env[WEB_TOKEN_ENV]
  if (raw === undefined) return undefined
  const token = raw.trim()
  return token === '' ? undefined : token
}

/** 生成一次性 token（每次启动都不同；`base64url` 可直接放进 URL 与 HTML 属性）。 */
export function generateWebToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * 把 token 注入 `index.html`。
 *
 * 先移除同名 meta 再插入：进程重启换 token 时，磁盘上的旧标签不能留在响应里。
 */
export function injectWebToken(html: string, token: string): string {
  const escaped = token.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const tag = `<meta name="${WEB_TOKEN_META}" content="${escaped}" />`
  const without = html.replace(new RegExp(`<meta name="${WEB_TOKEN_META}"[^>]*>\\s*`, 'i'), '')
  if (!/<\/head>/i.test(without)) return `${tag}\n${without}`
  return without.replace(/<\/head>/i, `    ${tag}\n  </head>`)
}

/** 页面里承载认证模式 的 meta 名（前端据此决定启动路径）。 */
export const AUTH_MODE_META = 'bah-auth-mode'

/**
 * 注入认证模式标记（02 TA-31）。
 *
 * 为什么必须由服务端注入而不是前端探测：前端要知道"该不该先弹登录卡片"只能靠一个
 * 明确的信号；靠"401 了就弹"会让静态模式多一次失败请求，也会把真正的鉴权错误
 * 误当成"未登录"。**模式是服务端事实，别让客户端猜。**
 */
export function injectAuthModeMeta(html: string, mode: string): string {
  const tag = `<meta name="${AUTH_MODE_META}" content="${mode}" />`
  const without = html.replace(new RegExp(`<meta name="${AUTH_MODE_META}"[^>]*>\\s*`, 'i'), '')
  if (!/<\/head>/i.test(without)) return `${tag}\n${without}`
  return without.replace(/<\/head>/i, `    ${tag}\n  </head>`)
}

/**
 * 从 HTTP 请求里取"出示的凭证"。
 *
 * @param headers 请求头
 * @param queryToken 仅 SSE 允许的查询参数（`EventSource` 不能自定义请求头）
 * @returns `Bearer` 形式的凭证串；什么都没带时 `undefined`
 */
export function presentedWebToken(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  queryToken?: string | null,
): string | undefined {
  const authorization = headers['authorization']
  if (typeof authorization === 'string') return authorization
  if (typeof queryToken === 'string' && queryToken !== '') return `Bearer ${queryToken}`
  return undefined
}
