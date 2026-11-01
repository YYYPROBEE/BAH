/**
 * 传输层 · 打字确认字段（ADR-0008）。
 *
 * 服务端按 `confirmText` 逐字校验；前端若在 POST body 里漏掉它，
 * 删除/撤销类操作会以 `approval-confirm-mismatch` 恒失败——这是链路里最容易断的一环。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHttpApi } from './transport.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch() {
  const calls = []
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })
  return calls
}

describe('传输层 · confirmText', () => {
  it('decide 第 4 参进 POST body；缺省时 body 里没有该键（不伪造空串）', async () => {
    const calls = stubFetch()
    const api = createHttpApi({ base: '' })

    await api.decide('ticket:call-1', 'allowed-once', undefined, '删除')
    await api.decide('ticket:call-1', 'allowed-once')

    const bodies = calls.map((call) => JSON.parse(call.init.body))
    expect(calls[0].url).toBe('/api/approval/ticket%3Acall-1')
    expect(bodies[0]).toEqual({ decision: 'allowed-once', confirmText: '删除' })
    expect(bodies[1]).toEqual({ decision: 'allowed-once' })
  })
})
