/**
 * `channel:web` 的静态资源 handler（W16 从 `web.ts` 拆出）。
 *
 * 三条安全约束不能因为搬家丢掉：
 * 1. **穿越一律 404，不返回 403**——403 等于告诉探测者"这个路径存在，只是不让看"；
 * 2. **先去掉前导斜杠再规范化**——`path.normalize('/../../x')` 会把 `..` 夹在根上吞掉，
 *    直接 join 反而读到了 staticRoot 里的文件，这是"看起来安全"的穿越。
 * 3. **`password` 模式下页面不再承载口令**（02 TA-28）：`index.html` 仍是 CSRF cookie 的
 *    载体（登录请求要用），但**不注入** `bah-web-token`——那是"任何能连端口的人都能拿到口令"
 *    的缺口 1。`static` / `none` 模式行为不变（快照与截图靠它）。
 */

import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

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

/** `GET/HEAD` 兜底：解析路径、读文件、注入 token（或登录模式标记）与 CSRF cookie。 */
export async function handleStatic(
  _req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const pathname = request.path
  const headOnly = request.method === 'HEAD'

  // `decodeURIComponent` 对畸形百分号序列（如 `%E0%A4%A`）抛 `URIError`。
  // 不接住的话异常冒到 dispatch 的兜底分支，畸形输入就变成 500——探测者能用它区分
  // "服务崩了"和"路径不对"。这里一律 400，且**不回显**原始串以外的任何信息。
  let decoded: string
  try {
    decoded = pathname === '/' ? 'index.html' : decodeURIComponent(pathname)
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

  try {
    const raw = await readFile(target)
    // index 是令牌/模式的唯一载体：注入后必须 no-store，避免浏览器缓存旧值
    const isIndex = target === deps.indexPath
    const html = raw.toString('utf8')
    const content = isIndex
      ? Buffer.from(
          // 顺序：先去 token 标记再注入（`password` 模式下不注入 token，等于把口令从页面拿走）。
          // `bah-auth-mode` 只在 password 模式注入：static/none 的前端启动路径与改动前**逐字一致**
          // （A3 零回归；多一个 meta 虽无害，但"不写 auth 配置就一字不变"是硬门槛）。
          deps.auth.mode === 'password'
            ? injectAuthModeMeta(
                html.replace(/<meta name="bah-web-token"[^>]*>\s*/i, ''),
                deps.auth.mode,
              )
            : injectWebToken(html, deps.webToken),
        )
      : raw
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': content.length,
      'cache-control': isIndex ? 'no-store' : 'no-cache',
      // 不是 HttpOnly：double-submit 需要同源脚本读 cookie 回填请求头。
      // `password` 模式下这条 cookie 仍然要发：**登录请求本身也过 CSRF**，
      // 但它是"登录前"的进程值，登录成功后会被会话值覆盖（TA-26 的轮换）。
      ...(isIndex ? { 'set-cookie': csrfCookieHeader(deps.csrfToken) } : {}),
    })
    res.end(headOnly ? undefined : content)
  } catch {
    sendError(res, 404, 'web-not-found', `没有这个资源：${pathname}`)
  }
}
