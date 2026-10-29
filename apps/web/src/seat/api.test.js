/**
 * 坐席台 HTTP 客户端（B2）：路径、方法、请求体、401 透传。
 */

import { describe, expect, it } from 'vitest'

import { createSeatApi } from './api.js'

/** 假 fetch：记录调用，返回固定 JSON。 */
function fakeFetch(responder = () => ({ ok: true, status: 200, data: { ok: true } })) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const result = responder(url, init)
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => result.data ?? {},
    }
  }
  return { calls, impl }
}

describe('seat api', () => {
  it('GET /api/handoff 带坐席 Bearer', async () => {
    const fake = fakeFetch()
    const api = createSeatApi({ token: 'op-1', fetchImpl: fake.impl })
    await api.handoff()
    expect(fake.calls[0]?.url).toBe('/api/handoff')
    expect(fake.calls[0]?.init.method).toBe('GET')
    expect(fake.calls[0]?.init.headers.authorization).toBe('Bearer op-1')
    expect(fake.calls[0]?.init.body).toBeUndefined()
  })

  it('say → POST /api/handoff/message，body 只含 text', async () => {
    const fake = fakeFetch(() => ({ ok: true, status: 200, data: { ok: true, seq: 7 } }))
    const api = createSeatApi({ token: 'op', fetchImpl: fake.impl })
    const result = await api.say('您好')
    expect(result).toMatchObject({ ok: true, status: 200, data: { seq: 7 } })
    expect(fake.calls[0]?.url).toBe('/api/handoff/message')
    expect(JSON.parse(fake.calls[0]?.init.body)).toEqual({ text: '您好' })
  })

  it('claim → POST /api/handoff/claim，无 body', async () => {
    const fake = fakeFetch()
    const api = createSeatApi({ token: 'op', fetchImpl: fake.impl })
    await api.claim()
    expect(fake.calls[0]?.url).toBe('/api/handoff/claim')
    expect(fake.calls[0]?.init.method).toBe('POST')
    expect(fake.calls[0]?.init.body).toBeUndefined()
  })

  it('resume：有交接语带 handover；空串 / undefined 只发 {}', async () => {
    const fake = fakeFetch()
    const api = createSeatApi({ token: 'op', fetchImpl: fake.impl })
    await api.resume('已核对')
    await api.resume('   ')
    await api.resume(undefined)
    expect(JSON.parse(fake.calls[0]?.init.body)).toEqual({ handover: '已核对' })
    expect(JSON.parse(fake.calls[1]?.init.body)).toEqual({})
    expect(JSON.parse(fake.calls[2]?.init.body)).toEqual({})
  })

  it('heartbeat / queue 的路径正确', async () => {
    const fake = fakeFetch()
    const api = createSeatApi({ token: 'op', fetchImpl: fake.impl })
    await api.heartbeat()
    await api.queue()
    expect(fake.calls.map((call) => call.url)).toEqual(['/api/handoff/heartbeat', '/api/handoff/queue'])
    expect(fake.calls[1]?.init.method).toBe('GET')
  })

  it('401 透传 status 与 code；网络异常 status 0', async () => {
    const unauthorized = fakeFetch(() => ({
      ok: false,
      status: 401,
      data: { error: { code: 'web-unauthorized', reason: '凭证无效' } },
    }))
    const api = createSeatApi({ token: 'bad', fetchImpl: unauthorized.impl })
    expect(await api.handoff()).toMatchObject({ ok: false, status: 401, code: 'web-unauthorized' })

    const broken = createSeatApi({
      token: 'op',
      fetchImpl: async () => {
        throw new Error('boom')
      },
    })
    expect(await broken.handoff()).toMatchObject({ ok: false, status: 0, code: 'network-error' })
  })
})
