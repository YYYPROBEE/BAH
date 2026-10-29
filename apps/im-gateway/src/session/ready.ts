/**
 * 子进程就绪与 CSRF 握手（施工单 02 §2.11）。
 *
 * 三步：
 * 1. 每 200ms 轮询 `GET /api/health`（公开路由，不需要凭证），直到 200 或超时；
 * 2. `GET /m.html`（token 入口，`static` 面放行）从 `set-cookie` 里取 `bah_csrf`；
 * 3. 拿不到 cookie 就**启动失败**——没有 CSRF 的 `/api/turn` 会一直 403，
 *    "起来了但发不出消息"比"起不来"难查得多。
 *
 * `fetch` / `sleep` / `nowMs` 全部可注入：握手要能被测试在毫秒级跑完。
 */

import { BahError } from '@bah/util'

/** 轮询间隔（§2.11：200ms）。 */
export const HANDSHAKE_POLL_MS = 200

/** CSRF cookie 名（与 `packages/host/src/boot/plugins/web/csrf.ts` 一致）。 */
const CSRF_COOKIE_NAME = 'bah_csrf'

/** 注入的 HTTP 客户端（只用到状态码与响应头）。 */
export interface HttpResponseLike {
  readonly status: number
  readonly headers: { get(name: string): string | null }
}

/** 注入的 fetch。 */
export type FetchLike = (
  url: string,
  init?: { readonly headers?: Readonly<Record<string, string>> },
) => Promise<HttpResponseLike>

/** 握手依赖。 */
export interface HandshakeDeps {
  /** 子进程监听端口（127.0.0.1）。 */
  readonly port: number
  /** 就绪超时（`BAH_IM_CHILD_TIMEOUT_MS`）。 */
  readonly timeoutMs: number
  readonly fetch?: FetchLike
  readonly sleep?: (ms: number) => Promise<void>
  readonly nowMs?: () => number
  readonly pollMs?: number
}

/** 握手结果。 */
export interface HandshakeResult {
  readonly csrf: string
}

/** 从 `set-cookie` 头里取 CSRF 令牌。 */
export function parseCsrfCookie(setCookie: string | null | undefined): string | undefined {
  if (setCookie === null || setCookie === undefined) return undefined
  const match = new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`).exec(setCookie)
  const token = match?.[1]?.trim()
  return token === undefined || token.length === 0 ? undefined : token
}

/** 默认 sleep。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 默认 fetch（Node 内置）。 */
const defaultFetch: FetchLike = (url, init) => fetch(url, init)

/**
 * 等子进程就绪并完成 CSRF 握手。
 *
 * @throws `BahError('im-child-timeout')` 健康检查超时
 * @throws `BahError('im-child-handshake')` `/m.html` 没下发 CSRF cookie
 */
export async function awaitChildReady(deps: HandshakeDeps): Promise<HandshakeResult> {
  const fetchImpl = deps.fetch ?? defaultFetch
  const sleep = deps.sleep ?? defaultSleep
  const nowMs = deps.nowMs ?? ((): number => Date.now())
  const pollMs = deps.pollMs ?? HANDSHAKE_POLL_MS
  const deadline = nowMs() + deps.timeoutMs
  const base = `http://127.0.0.1:${String(deps.port)}`

  let ready = false
  while (nowMs() < deadline) {
    try {
      const response = await fetchImpl(`${base}/api/health`)
      if (response.status === 200) {
        ready = true
        break
      }
    } catch {
      // 子进程还没 listen：连接被拒是正常中间态，继续轮询
    }
    await sleep(pollMs)
  }
  if (!ready) {
    throw new BahError(
      'im-child-timeout',
      `im: 子进程 ${String(deps.timeoutMs)}ms 内没有就绪（端口 ${String(deps.port)}）`,
      { port: deps.port },
    )
  }

  const entry = await fetchImpl(`${base}/m.html`)
  const csrf = parseCsrfCookie(entry.headers.get('set-cookie'))
  if (csrf === undefined) {
    throw new BahError('im-child-handshake', 'im: 子进程入口没有下发 bah_csrf（拒绝继续）', {
      port: deps.port,
    })
  }
  return { csrf }
}
