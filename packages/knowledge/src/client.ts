/**
 * HTTP 端口：唯一出网点。
 *
 * 纪律：
 * - 只连 127.0.0.1（回环），不跟随重定向到其他 host；
 * - 超时用 AbortController，外部 signal 透传；
 * - 非 2xx 一律映射为结构化 `BahError`，不把原始响应拼进用户文案；
 * - 不做自动重试（避免重复审计与熔断计数）。
 */

import { BahError } from '@bah/util'

import { asKnowledgeAnswer, asKnowledgeHealth, asKnowledgeQuery } from './contract.ts'
import type {
  KnowledgeAnswerRequest,
  KnowledgeAnswerResponse,
  KnowledgeHealth,
  KnowledgePort,
  KnowledgeQueryRequest,
  KnowledgeQueryResponse,
} from './port.ts'

export interface KnowledgeTimeouts {
  readonly answer: number
  readonly query: number
  readonly health: number
}

export interface HttpKnowledgePortOptions {
  /** 形如 `http://127.0.0.1:7801`；末尾斜杠会被去掉。 */
  readonly baseUrl: string
  /** Bearer token；缺省不带头（本机演示）。 */
  readonly token?: string
  readonly timeoutMs?: Partial<KnowledgeTimeouts>
}

const DEFAULT_TIMEOUTS: KnowledgeTimeouts = {
  answer: 8_000,
  query: 1_500,
  health: 1_000,
}

function mapStatus(status: number, body: unknown): BahError {
  const code =
    typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : undefined
  if (status === 401) return new BahError('knowledge-denied', '知识服务鉴权失败', { status, code })
  if (status === 503)
    return new BahError('knowledge-unavailable', '知识服务暂不可用', { status, code })
  if (status === 504) return new BahError('knowledge-timeout', '知识服务超时', { status, code })
  if (status === 400)
    return new BahError('knowledge-bad-request', '知识请求不合法', { status, code })
  return new BahError('knowledge-internal', '知识服务内部错误', { status, code })
}

export function createHttpKnowledgePort(options: HttpKnowledgePortOptions): KnowledgePort {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const timeouts: KnowledgeTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeoutMs }

  async function request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = (): void => controller.abort()
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
      })
      if (!response.ok) {
        let body: unknown
        try {
          body = await response.json()
        } catch {
          body = undefined
        }
        throw mapStatus(response.status, body)
      }
      try {
        return await response.json()
      } catch {
        throw new BahError('knowledge-contract', '知识服务返回非 JSON', { path })
      }
    } catch (error) {
      if (error instanceof BahError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BahError('knowledge-timeout', '知识服务超时', { path, timeoutMs })
      }
      throw new BahError('knowledge-unavailable', '知识服务不可达', { path })
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  return {
    async answer(
      requestBody: KnowledgeAnswerRequest,
      signal?: AbortSignal,
    ): Promise<KnowledgeAnswerResponse> {
      const raw = await request(
        '/v1/answer',
        { method: 'POST', body: JSON.stringify(requestBody) },
        timeouts.answer,
        signal,
      )
      return asKnowledgeAnswer(raw)
    },

    async query(
      requestBody: KnowledgeQueryRequest,
      signal?: AbortSignal,
    ): Promise<KnowledgeQueryResponse> {
      const raw = await request(
        '/v1/query',
        { method: 'POST', body: JSON.stringify(requestBody) },
        timeouts.query,
        signal,
      )
      return asKnowledgeQuery(raw)
    },

    async health(signal?: AbortSignal): Promise<KnowledgeHealth> {
      const raw = await request('/healthz', { method: 'GET' }, timeouts.health, signal)
      return asKnowledgeHealth(raw)
    },
  }
}
