/**
 * W09 · 前端 CSRF double-submit（与宿主 `web.csrf` 同批）。
 *
 * 只验传输层的两件事：cookie 存在时回填 `x-bah-csrf`；没有 cookie 时不伪造。
 * 浏览器行为（cookie 是否可读、同源策略）由宿主用例与真实浏览器验收，不在 jsdom 里假装。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { connectEvents, createHttpApi } from './transport.js'

const originalFetch = globalThis.fetch
const originalEventSource = globalThis.EventSource

/** 假 EventSource：记录 URL / 监听，供用例手动触发事件。 */
class FakeEventSource {
  static instances = []

  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
    FakeEventSource.instances.push(this)
  }

  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler])
  }

  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== handler))
  }

  close() {
    this.closed = true
  }

  emit(type, payload = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(payload)
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.EventSource = originalEventSource
  FakeEventSource.instances = []
  vi.useRealTimers()
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

describe('transport · SSE 续订（§8）', () => {
  /** 起一条连接（假 EventSource 已装到全局）。 */
  function connect(options = {}) {
    globalThis.EventSource = FakeEventSource
    return connectEvents({ onFrame: () => undefined, token: 'web-token', retryDelayMs: 1000, ...options })
  }

  it('基址与初始 since 都进 URL（与 REST 同源）', () => {
    connect({ base: 'https://bank.example', since: 7 })
    expect(FakeEventSource.instances[0].url).toBe('https://bank.example/api/events?since=7&token=web-token')
  })

  it('断线后按已收帧的最大 seq 续订，而不是回到 since=0', () => {
    vi.useFakeTimers()
    const transport = connect()
    const first = FakeEventSource.instances[0]
    first.emit('frame', { data: JSON.stringify({ kind: 'snapshot', maxSeq: 12, frames: [] }) })
    expect(first.closed).toBe(false)

    first.emit('error')
    expect(first.closed).toBe(true)
    vi.advanceTimersByTime(999)
    expect(FakeEventSource.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1].url).toBe('/api/events?since=12&token=web-token')

    transport.close()
  })

  it('close() 取消待重连，不再新建连接', () => {
    vi.useFakeTimers()
    const transport = connect()
    FakeEventSource.instances[0].emit('error')
    transport.close()
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('重连有上限（1s × 10 次后停在"已断开"）', () => {
    vi.useFakeTimers()
    const transport = connect()
    for (let index = 0; index < 12; index += 1) {
      FakeEventSource.instances.at(-1).emit('error')
      vi.advanceTimersByTime(1000)
    }
    expect(FakeEventSource.instances).toHaveLength(11)
    transport.close()
  })
})
