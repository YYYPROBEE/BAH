/**
 * `channel:web` 的静态资源 handler（W16 从 `web.ts` 拆出；合流 2026-10-29 重写入口判定）。
 *
 * 四条安全约束不能因为搬家丢掉：
 * 1. **穿越一律 404，不返回 403**——403 等于告诉探测者"这个路径存在，只是不让看"；
 * 2. **先去掉前导斜杠再规范化**——`path.normalize('/../../x')` 会把 `..` 夹在根上吞掉，
 *    直接 join 反而读到了 staticRoot 里的文件，这是"看起来安全"的穿越。
 * 3. **`password` 模式下页面不再承载口令**（02 TA-28）：所有 token 入口都不注入
 *    `bah-web-token`，改为注入 `bah-auth-mode` + 下发 CSRF cookie（登录请求本身也过 CSRF）。
 * 4. **坐席页零注入**（人机接管 01）：`operator.html` 永不注入任何凭证；坐席未启用时
 *    页面本身 404（存在性也不白给）。
 *
 * 入口判定按**规范化后的绝对路径**做（token 白名单 / 坐席入口），不做字面量路径比较：
 * `//operator.html`、`/./operator.html`、`/operator%2ehtml` 都会先规范化成同一个目标
 * （施工单 01 对抗式复审 P1-1）。
 */

import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

import type { IncomingMessage, ServerResponse } from 'node:http'

import { csrfCookieHeader } from '../csrf.ts'
import type { WebDeps, WebRequest } from '../deps.ts'
import { SECURITY_HEADERS, sendError } from '../http.ts'
import { injectAuthModeMeta, injectWebToken } from '../../web-auth.ts'

/** 静态资源 MIME（不引第三方库；未知类型一律 `application/octet-stream`）。 */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** 去掉页面里可能残留的 token meta（`injectAuthModeMeta` 不会自动清理）。 */
function stripTokenMeta(html: string): string {
  return html.replace(/<meta name="bah-web-token"[^>]*>\s*/i, '')
}

/** `GET/HEAD` 兜底：解析路径、读文件、按入口注入 token / 登录模式标记 / CSRF cookie。 */
export async function handleStatic(
  _req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  // `/operator` 是坐席页的别名；映射在 decode 之前，走同一条解码/规范化/越界判定。
  const pathname = request.path === '/operator' ? '/operator.html' : request.path
  const headOnly = request.method === 'HEAD'

  // `decodeURIComponent` 对畸形百分号序列（如 `%E0%A4%A`）抛 `URIError`。
  // 不接住的话异常冒到 dispatch 的兜底分支，畸形输入就变成 500——探测者能用它区分
  // "服务崩了"和"路径不对"。这里一律 400，且**不回显**原始串以外的任何信息。
  let decoded: string
  try {
    // 施工单 01 / 00 D3：`/` 的落点由配置的 `defaultEntry` 决定（移动壳是第二个 HTML 壳），
    // 这里只换成相对名——后面的 normalize + join + 穿越校验逐字不动。
    decoded = pathname === '/' ? relative(deps.staticRoot, deps.defaultEntry) : decodeURIComponent(pathname)
  } catch {
    sendError(res, 400, 'web-invalid-path', '请求路径不是合法的百分号编码')
    return
  }
  const relativePath = normalize(decoded.replace(/^[\\/]+/, ''))
  const escaped =
    relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
  const target = resolve(join(deps.staticRoot, relativePath))
  if (escaped || (target !== deps.staticRoot && !target.startsWith(deps.staticRoot + sep))) {
    sendError(res, 404, 'web-not-found', `没有这个资源：${pathname}`)
    return
  }

  // 坐席入口的判定用**规范化后的目标**：`//operator.html` / `/./operator.html` /
  // `/operator%2ehtml` 都落在同一个 target 上，字面量比较会漏掉别名（复审 P1-1）。
  const isOperatorEntry = target === deps.operatorEntry
  if (isOperatorEntry && !deps.seatEnabled) {
    sendError(res, 404, 'web-not-found', `没有这个资源：${pathname}`)
    return
  }

  try {
    const raw = await readFile(target)
    const html = raw.toString('utf8')
    // 坐席页是第二层硬排除：即便部署把 operator.html 误配进 entries，也不许它带凭证。
    const isTokenEntry = deps.tokenEntries.includes(target) && !isOperatorEntry
    const passwordMode = deps.auth.mode === 'password'

    let content: Buffer
    if (isTokenEntry) {
      // 顺序：先去 token 标记再注入。`bah-auth-mode` 只在 password 模式注入：
      // static/none 的前端启动路径与改动前**逐字一致**（A3 零回归）。
      content = Buffer.from(
        passwordMode
          ? injectAuthModeMeta(stripTokenMeta(html), deps.auth.mode)
          : injectWebToken(html, deps.webToken),
      )
    } else if (isOperatorEntry && passwordMode) {
      // 坐席登录（D2 未做）：页面只拿到"这是 password 模式"与 CSRF cookie；
      // password 模式坐席本轮整体 404（seatEnabled=false），这条分支留给后续 D2 开启。
      content = Buffer.from(injectAuthModeMeta(stripTokenMeta(html), deps.auth.mode))
    } else {
      content = raw
    }

    // 入口页（token 入口 / 坐席入口）统一 no-store：注入值随进程变化，缓存旧值等于缓存旧凭证。
    const isEntryPage = isTokenEntry || isOperatorEntry
    const needsCsrfCookie = isTokenEntry || (isOperatorEntry && passwordMode)
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': content.length,
      'cache-control': isEntryPage ? 'no-store' : 'no-cache',
      // 不是 HttpOnly：double-submit 需要同源脚本读 cookie 回填请求头。
      ...(needsCsrfCookie ? { 'set-cookie': csrfCookieHeader(deps.csrfToken) } : {}),
    })
    res.end(headOnly ? undefined : content)
  } catch {
    sendError(res, 404, 'web-not-found', `没有这个资源：${pathname}`)
  }
}
