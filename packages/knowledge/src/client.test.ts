import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHttpKnowledgePort } from './client.ts'
import { answerResponse, healthResponse, queryResponse } from './testing.ts'
import type { KnowledgeAnswerRequest, KnowledgeQueryRequest } from './port.ts'

const PRINCIPAL = {
  role: 'retail',
  audience: 'standard',
  channel: 'headless',
  region: 'CN-SH',
  now: '2026-10-19T12:00:00+08:00',
} as const

const ANSWER_REQUEST: KnowledgeAnswerRequest = {
  schemaVersion: 'knowledge.v1',
  sessionId: 's-1',
  query: '稳盈90天赎回费率',
  principal: PRINCIPAL,
}

const QUERY_REQUEST: KnowledgeQueryRequest = {
  schemaVersion: 'knowledge.v1',
  sessionId: 's-1',
  query: '稳盈90天赎回费率',
  principal: PRINCIPAL,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('http knowledge port', () => {
  it('posts answer / query and reads health', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/answer')) return jsonResponse(answerResponse())
      if (url.endsWith('/v1/query')) return jsonResponse(queryResponse())
      return jsonResponse(healthResponse())
    })
    vi.stubGlobal('fetch', fetchMock)
    const port = createHttpKnowledgePort({
      baseUrl: 'http://127.0.0.1:7801/',
      token: 'secret',
    })

    const answer = await port.answer(ANSWER_REQUEST)
    expect(answer.verdict).toBe('GREEN')
    expect((await port.query(QUERY_REQUEST)).kind).toBe('evidence')
    expect((await port.health()).status).toBe('ok')

    const first = fetchMock.mock.calls[0]!
    expect(first[0]).toBe('http://127.0.0.1:7801/v1/answer')
    expect((first[1] as RequestInit).method).toBe('POST')
    expect((first[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    })
  })

  /**
   * 回归守卫：线上请求体**不得**带 `principal` / `sessionId` / `traceId`。
   *
   * 服务端 `ApiModel` 是 `extra="forbid"`（`services/rag/src/banking_rag/contract.py:19-26`），
   * 多带一个字段就是 422。这条曾经悄悄坏了整条检索链：403/422 被映射成
   * `knowledge-internal`，看上去像"服务内部错误"，而不是"我们在请求体里自证身份"。
   */
  it('strips self-asserted identity from the wire body', async () => {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) =>
      url.endsWith('/v1/answer') ? jsonResponse(answerResponse()) : jsonResponse(queryResponse()),
    )
    vi.stubGlobal('fetch', fetchMock)
    const port = createHttpKnowledgePort({ baseUrl: 'http://127.0.0.1:7801' })

    await port.answer({
      ...ANSWER_REQUEST,
      traceId: 't-1',
      answerOptions: { style: 'detailed', maxChars: 800, requireCitations: false },
    })
    await port.query(QUERY_REQUEST)

    const answerBody = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
    expect(answerBody).toEqual({
      schemaVersion: 'knowledge.v1',
      query: '稳盈90天赎回费率',
      answerOptions: { style: 'detailed', maxChars: 800, requireCitations: false },
    })
    const queryBody = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))
    expect(queryBody).toEqual({ schemaVersion: 'knowledge.v1', query: '稳盈90天赎回费率' })
  })

  it.each([
    [401, 'knowledge-denied'],
    [400, 'knowledge-bad-request'],
    [503, 'knowledge-unavailable'],
    [504, 'knowledge-timeout'],
    [500, 'knowledge-internal'],
  ])('maps HTTP %i to %s', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'X' }, status)))
    const port = createHttpKnowledgePort({ baseUrl: 'http://127.0.0.1:7801' })
    await expect(port.answer(ANSWER_REQUEST)).rejects.toMatchObject({ code })
  })

  it('maps a non-JSON error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not-json', { status: 503 })),
    )
    const port = createHttpKnowledgePort({ baseUrl: 'http://127.0.0.1:7801' })
    await expect(port.health()).rejects.toMatchObject({ code: 'knowledge-unavailable' })
  })

  it('rejects a non-JSON success body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })))
    const port = createHttpKnowledgePort({ baseUrl: 'http://127.0.0.1:7801' })
    await expect(port.health()).rejects.toMatchObject({ code: 'knowledge-contract' })
  })

  it('maps network errors to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))
    const port = createHttpKnowledgePort({ baseUrl: 'http://127.0.0.1:7801' })
    await expect(port.health()).rejects.toMatchObject({ code: 'knowledge-unavailable' })
  })

  it('maps AbortError to timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }),
    )
    const port = createHttpKnowledgePort({ baseUrl: 'http://127.0.0.1:7801' })
    await expect(port.health()).rejects.toMatchObject({ code: 'knowledge-timeout' })
  })

  it('times out via AbortController', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          }),
      ),
    )
    const port = createHttpKnowledgePort({
      baseUrl: 'http://127.0.0.1:7801',
      timeoutMs: { answer: 10 },
    })
    const expectation = expect(port.answer(ANSWER_REQUEST)).rejects.toMatchObject({
      code: 'knowledge-timeout',
    })
    await vi.advanceTimersByTimeAsync(20)
    await expectation
  })

  it('propagates an already-aborted external signal', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            if (init.signal?.aborted === true) {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
              return
            }
            init.signal?.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          }),
      ),
    )
    const port = createHttpKnowledgePort({ baseUrl: 'http://127.0.0.1:7801' })
    await expect(port.health(controller.signal)).rejects.toMatchObject({
      code: 'knowledge-timeout',
    })
  })

  it('propagates an external abort during the request', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          }),
      ),
    )
    const port = createHttpKnowledgePort({ baseUrl: 'http://127.0.0.1:7801' })
    const expectation = expect(port.health(controller.signal)).rejects.toMatchObject({
      code: 'knowledge-timeout',
    })
    controller.abort()
    await expectation
  })
})
