/**
 * Web 渠道的访问凭证（D5 最小鉴权集）。
 *
 * 三条边界：
 * 1. **默认可用**：没配 `BAH_WEB_TOKEN` 时启动期生成一次性 token，浏览器要能直接打开演示；
 * 2. **不进仓库**：token 只从环境变量读或进程内生成，绝不写死、绝不落审计；
 * 3. **页面即凭证载体**：服务端在 `index.html` 注入 `<meta name="bah-web-token">`，
 *    同源页面读它，跨源页面读不到（没有 CORS）。这是"最小集"的边界，不是完整登录。
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

/** HTML 注释（跨行、惰性匹配）。 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g

/**
 * 把 token 注入 `index.html` / `m.html`。
 *
 * 三条约束：
 * 1. **只在注释之外动手**：页面注释里可能出现 head 结束标记或同名 meta 的示意文本，
 *    按字面量直接定位会把注入点带进注释——送达的 DOM 里根本没有 meta，前端永远 401
 *    （2026-10-29 移动壳走查 P0-1 的真因）。这里先剥除注释，送达的页面不需要开发注释，
 *    顺带让"响应体里出现凭证串 ⇒ 一定是真标签"成为可断言的形态。
 * 2. **同名旧标签全部移除**：进程重启换 token 时，磁盘上的旧标签不能留在响应里；
 *    原实现只移除第一个，多写一个就漏一个。
 * 3. **注入点在真的 head 结束标记前**：剥除注释后第一个 `</head>` 就是它（合法 HTML
 *    不会有两个 head）；没有 head 时放在最前，浏览器仍能解析。
 */
export function injectWebToken(html: string, token: string): string {
  const escaped = token.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const tag = `<meta name="${WEB_TOKEN_META}" content="${escaped}" />`
  const bare = html.replace(HTML_COMMENT, '')
  const without = bare.replace(new RegExp(`<meta name="${WEB_TOKEN_META}"[^>]*>\\s*`, 'gi'), '')
  const at = without.toLowerCase().indexOf('</head>')
  if (at === -1) return `${tag}\n${without}`
  return `${without.slice(0, at)}    ${tag}\n  ${without.slice(at)}`
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
