/**
 * 传输层的观测两个方法（03 §4.4）：只加不改——既有 6 个方法仍在。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHttpApi } from './transport.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/** 捕获 fetch 调用并返回 JSON。 */
function stubFetch(body = { ok: true }) {
  const calls = []
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => body }
  })
  return calls
}

describe('transport · 观测方法', () => {
  it('metrics() 走 GET /api/metrics 且带 Bearer', async () => {
    const calls = stubFetch({ turns: 1 })
    const api = createHttpApi({ token: 'web-token' })
    const result = await api.metrics()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/metrics')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.headers.authorization).toBe('Bearer web-token')
    expect(result.data.turns).toBe(1)
  })

  it('trace() 缺省 limit=2000', async () => {
    const calls = stubFetch({ roots: [] })
    const api = createHttpApi({ token: 't' })
    await api.trace()
    expect(calls[0].url).toBe('/api/trace?limit=2000')
  })

  it('trace() 透传 limit 与 format', async () => {
    const calls = stubFetch({ roots: [] })
    const api = createHttpApi({ token: 't' })
    await api.trace({ limit: 50, format: 'chrome' })
    expect(calls[0].url).toBe('/api/trace?limit=50&format=chrome')
  })

  it('既有 6 个方法一个不少（只加不改）', () => {
    const api = createHttpApi({ token: 't' })
    for (const name of ['session', 'health', 'turn', 'interrupt', 'decide', 'verify', 'metrics', 'trace']) {
      expect(typeof api[name]).toBe('function')
    }
  })
})
