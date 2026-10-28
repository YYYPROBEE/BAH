/**
 * 静态资源 handler（W16 从 `web.ts` 拆出）。
 *
 * 两条安全约束不能因为搬家丢掉：
 * 1. **穿越一律 404，不返回 403**——403 等于告诉探测者"这个路径存在，只是不让看"；
 * 2. **先去掉前导斜杠再规范化**——`path.normalize('/../../x')` 会把 `..` 夹在根上吞掉，
 *    直接 join 反而读到了 staticRoot 里的文件，这是"看起来安全"的穿越。
 */

import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import type { IncomingMessage, ServerResponse } from 'node:http'

import { csrfCookieHeader } from '../csrf.ts'
import type { WebDeps, WebRequest } from '../deps.ts'
import { SECURITY_HEADERS, sendError } from '../http.ts'
import { injectWebToken } from '../../web-auth.ts'

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

/** `GET/HEAD` 兜底：解析路径、读文件、注入 token 与 CSRF cookie。 */
export async function handleStatic(
  _req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  // 坐席入口默认不存在：未配 BAH_OPERATOR_TOKEN 时 /operator 与 /operator.html
  // 都 404（不暴露"这系统有坐席台"）。页面里没有任何凭证，但存在性本身也不该白给。
  const isOperatorEntry = request.path === '/operator' || request.path === '/operator.html'
  if (isOperatorEntry && deps.operatorToken === undefined) {
    sendError(res, 404, 'web-not-found', `没有这个资源：${request.path}`)
    return
  }
  // 路径映射必须在 decodeURIComponent 之前：走同一条解码/规范化/越界判定。
  // `operator.html` 不等于 `deps.indexPath`，所以天然不注入 token、不带 set-cookie。
  const pathname = request.path === '/operator' ? '/operator.html' : request.path
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
    // index 是 token 的唯一载体：注入后必须 no-store，避免浏览器缓存旧 token
    const isIndex = target === deps.indexPath
    const content = isIndex
      ? Buffer.from(injectWebToken(raw.toString('utf8'), deps.webToken))
      : raw
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': content.length,
      'cache-control': isIndex ? 'no-store' : 'no-cache',
      // 不是 HttpOnly：double-submit 需要同源脚本读 cookie 回填请求头
      ...(isIndex ? { 'set-cookie': csrfCookieHeader(deps.csrfToken) } : {}),
    })
    res.end(headOnly ? undefined : content)
  } catch {
    sendError(res, 404, 'web-not-found', `没有这个资源：${pathname}`)
  }
}
