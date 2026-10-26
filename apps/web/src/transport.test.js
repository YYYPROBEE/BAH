/**
 * W09 · 前端 CSRF double-submit（与宿主 `web.csrf` 同批）。
 *
 * 只验传输层的两件事：cookie 存在时回填 `x-bah-csrf`；没有 cookie 时不伪造。
 * 浏览器行为（cookie 是否可读、同源策略）由宿主用例与真实浏览器验收，不在 jsdom 里假装。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHttpApi } from './transport.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  document.cookie = 'bah_csrf=; Max-Age=0; path=/'
})

/** 捕获一次 fetch 调用，返回成功响应。 */
function stubFetch() {
  const calls = []
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 202, json: async () => ({ ok: true }) }
  })
  return calls
}

describe('transport · W09 CSRF', () => {
  it('写请求回填 cookie 里的令牌；GET 不带', async () => {
    document.cookie = 'bah_csrf=csrf-token-1; path=/'
    const calls = stubFetch()
    const api = createHttpApi({ token: 'web-token' })

    await api.turn('查余额')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['x-bah-csrf']).toBe('csrf-token-1')
    expect(calls[0].init.headers.authorization).toBe('Bearer web-token')

    await api.session()
    expect(calls[1].init.headers['x-bah-csrf']).toBeUndefined()
  })

  it('没有 cookie 时不伪造请求头（由服务端 403 web-csrf-required 兜底）', async () => {
    const calls = stubFetch()
    const api = createHttpApi({ token: 'web-token' })
    await api.interrupt('算了')
    expect(calls[0].init.headers['x-bah-csrf']).toBeUndefined()
  })

  it('显式 csrfToken 选项优先（桌面壳/测试注入）', async () => {
    const calls = stubFetch()
    const api = createHttpApi({ token: 'web-token', csrfToken: 'injected-token' })
    await api.decide('t-1', 'allowed-once')
    expect(calls[0].init.headers['x-bah-csrf']).toBe('injected-token')
  })
})
