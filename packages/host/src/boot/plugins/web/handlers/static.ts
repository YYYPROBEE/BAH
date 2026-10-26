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
  const pathname = request.path
  const headOnly = request.method === 'HEAD'

  const decoded = pathname === '/' ? 'index.html' : decodeURIComponent(pathname)
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
