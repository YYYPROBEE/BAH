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

/** 一次子进程 JSON 调用（审批 / 转人工 / 运营桥共用）。 */
export interface ChildCallResult {
  /** 0 = 网络层失败（没拿到响应）。 */
  readonly status: number
  /** 解析后的 JSON；非 JSON 或网络失败为 `undefined`。 */
  readonly json: unknown
  /** 原始响应文本（排障用，不直接回用户）。 */
  readonly text: string
}

/** 子进程客户端。 */
export interface ChildClient {
  turn(text: string): Promise<TurnOutcome>
  /** 建立 SSE 订阅；返回断开函数（幂等）。 */
  subscribe(handlers: SubscribeHandlers): () => void
  health(): Promise<boolean>
  /** 提交审批结论（客户凭证 + CSRF）。 */
  decide(
    ticketId: string,
    body: { readonly decision: 'allowed-once' | 'rejected'; readonly reason?: string },
  ): Promise<ChildCallResult>
  /** 红级强验证（客户凭证）。 */
  verify(ticketId: string): Promise<ChildCallResult>
  /** 客户侧转人工（`POST /api/handoff`）。 */
  requestHandoff(reason?: string): Promise<ChildCallResult>
  /**
   * 运营桥转发（**子进程 operator token**，不是公网运营 token）。
   *
   * `path` 只允许 `/api/handoff*`（调用方 `handoff/operator.ts` 已按白名单构造）。
   */
  seat(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ChildCallResult>
}

/** 客户端依赖。 */
export interface ChildClientDeps {
  readonly port: number
  readonly token: string
  readonly csrf: string
  /** 子进程运营凭证（监督者按会话生成；未配置时 `seat` 返回 503）。 */
  readonly operatorToken?: string
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
  const csrfHeaders: Readonly<Record<string, string>> = {
    'x-bah-csrf': deps.csrf,
    cookie: `bah_csrf=${deps.csrf}`,
  }
  const operatorHeaders: Readonly<Record<string, string>> | undefined =
    deps.operatorToken === undefined
      ? undefined
      : {
          authorization: `Bearer ${deps.operatorToken}`,
          ...csrfHeaders,
        }

  /** 发一次 JSON 调用（网络失败 → `status: 0`，不抛）。 */
  const callJson = async (
    method: 'GET' | 'POST',
    path: string,
    headers: Readonly<Record<string, string>>,
    body?: unknown,
  ): Promise<ChildCallResult> => {
    let response: ClientResponse
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      return { status: 0, json: undefined, text: '' }
    }
    const text = await response.text()
    let json: unknown
    try {
      json = JSON.parse(text) as unknown
    } catch {
      json = undefined
    }
    return { status: response.status, json, text }
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

    decide(ticketId, body): Promise<ChildCallResult> {
      return callJson('POST', `/api/approval/${encodeURIComponent(ticketId)}`, { ...authHeaders, ...csrfHeaders }, body)
    },

    verify(ticketId): Promise<ChildCallResult> {
      return callJson('POST', `/api/verify/${encodeURIComponent(ticketId)}`, { ...authHeaders, ...csrfHeaders }, {})
    },

    requestHandoff(reason): Promise<ChildCallResult> {
      return callJson(
        'POST',
        '/api/handoff',
        { ...authHeaders, ...csrfHeaders },
        reason === undefined ? {} : { reason },
      )
    },

    seat(method, path, body): Promise<ChildCallResult> {
      if (operatorHeaders === undefined) {
        return Promise.resolve({
          status: 503,
          json: { error: { code: 'im-seat-unconfigured', reason: '子进程未配置运营凭证' } },
          text: '',
        })
      }
      return callJson(method, path, operatorHeaders, body)
    },
  }
}
