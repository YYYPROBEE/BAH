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
