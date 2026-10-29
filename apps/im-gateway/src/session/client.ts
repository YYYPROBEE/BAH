/**
 * 子进程 HTTP 客户端（施工单 02 §2.12）。
 *
 * 与子进程的三次交互：
 * - `POST /api/turn`：带 Bearer + CSRF（cookie + 头都要，double-submit）；
 * - `GET /api/events`（SSE）：`?token=` 在 static 模式可用，但仍带 Bearer —— 两条路径都走同一身份；
 * - `GET /api/health`：探活（公开路由）。
 *
 * 状态映射（§2.12 原文）：202 已入队；423 停机；503 分 `inbox-full` 与其它；
 * 401/403 凭证失效（由监督者重启一次）；其余"处理失败"。
 */

import type { WebFrame } from '@bah/channels'

import { parseSseBuffer, frameOfEvent } from '../bridge/sse.ts'

/** 一次请求的最小响应面（测试注入假实现用）。 */
export interface ClientResponse {
  readonly status: number
  readonly body: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null
  text(): Promise<string>
}

/** 最小请求面。 */
export interface ClientRequestInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly signal?: AbortSignal
}

/** 注入的 fetch。 */
export type ClientFetch = (url: string, init?: ClientRequestInit) => Promise<ClientResponse>

/** turn 的结论。 */
export type TurnOutcome =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'inbox-full' }
  | { readonly kind: 'halted' }
  | { readonly kind: 'auth' }
  | { readonly kind: 'failed'; readonly status: number; readonly code: string }

/** SSE 订阅回调。 */
export interface SubscribeHandlers {
  readonly onFrame: (frame: WebFrame) => void
  /** 连接建立（`deliverTurn` 用它决定"订阅已就绪"）。 */
  readonly onOpen?: () => void
  readonly onError?: (error: unknown) => void
}

/** 子进程客户端。 */
export interface ChildClient {
  turn(text: string): Promise<TurnOutcome>
  /** 建立 SSE 订阅；返回断开函数（幂等）。 */
  subscribe(handlers: SubscribeHandlers): () => void
  health(): Promise<boolean>
}

/** 客户端依赖。 */
export interface ChildClientDeps {
  readonly port: number
  readonly token: string
  readonly csrf: string
  readonly fetch?: ClientFetch
}

/** 默认 fetch（Node 内置）。 */
const defaultFetch: ClientFetch = async (url, init) => {
  const response = await fetch(url, init)
  return {
    status: response.status,
    body: response.body as ClientResponse['body'],
    text: () => response.text(),
  }
}

/** 读错误体里的结构化 code（读不出来就按 503 语义当"忙"）。 */
async function codeOf(response: ClientResponse): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await response.text())
    if (typeof parsed !== 'object' || parsed === null) return ''
    const error = (parsed as { error?: unknown }).error
    if (typeof error !== 'object' || error === null) return ''
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : ''
  } catch {
    return ''
  }
}

/**
 * 造一个子进程客户端。
 *
 * @param deps 见 {@link ChildClientDeps}
 */
export function createChildClient(deps: ChildClientDeps): ChildClient {
  const fetchImpl = deps.fetch ?? defaultFetch
  const base = `http://127.0.0.1:${String(deps.port)}`
  const authHeaders: Readonly<Record<string, string>> = {
    authorization: `Bearer ${deps.token}`,
  }

  return {
    async turn(text: string): Promise<TurnOutcome> {
      let response: ClientResponse
      try {
        response = await fetchImpl(`${base}/api/turn`, {
          method: 'POST',
          headers: {
            ...authHeaders,
            'x-bah-csrf': deps.csrf,
            cookie: `bah_csrf=${deps.csrf}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text }),
        })
      } catch {
        return { kind: 'failed', status: 0, code: 'network' }
      }

      switch (response.status) {
        case 202:
          return { kind: 'accepted' }
        case 423:
          return { kind: 'halted' }
        case 401:
        case 403:
          return { kind: 'auth' }
        case 503: {
          const code = await codeOf(response)
          if (code === 'web-inbox-full') return { kind: 'inbox-full' }
          return { kind: 'failed', status: 503, code: code === '' ? 'unknown' : code }
        }
        default:
          return { kind: 'failed', status: response.status, code: 'unexpected-status' }
      }
    },

    subscribe(handlers: SubscribeHandlers): () => void {
      const controller = new AbortController()
      void (async () => {
        try {
          const response = await fetchImpl(`${base}/api/events?token=${encodeURIComponent(deps.token)}&since=0`, {
            headers: { ...authHeaders, accept: 'text/event-stream' },
            signal: controller.signal,
          })
          if (response.status !== 200 || response.body === null) {
            throw new Error(`im-gateway: SSE 连接失败（状态 ${String(response.status)}）`)
          }
          handlers.onOpen?.()
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (!controller.signal.aborted) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffer += decoder.decode(chunk.value, { stream: true })
            const parsed = parseSseBuffer(buffer)
            buffer = parsed.rest
            for (const event of parsed.events) {
              const frame = frameOfEvent(event)
              if (frame !== undefined) handlers.onFrame(frame)
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) handlers.onError?.(error)
        }
      })()
      return () => {
        controller.abort()
      }
    },

    async health(): Promise<boolean> {
      try {
        const response = await fetchImpl(`${base}/api/health`)
        return response.status === 200
      } catch {
        return false
      }
    },
  }
}
