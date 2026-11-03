/**
 * W09 · 前端 CSRF double-submit（与宿主 `web.csrf` 同批）。
 *
 * 只验传输层的两件事：cookie 存在时回填 `x-bah-csrf`；没有 cookie 时不伪造。
 * 浏览器行为（cookie 是否可读、同源策略）由宿主用例与真实浏览器验收，不在 jsdom 里假装。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { connectEvents, createHttpApi, createSessionControlClient } from './transport.js'

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

  it('password 模式断线 401 探测：会话失效 → 不再重连并交回登录门', async () => {
    vi.useFakeTimers()
    document.head.innerHTML = '<meta name="bah-auth-mode" content="password" />'
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))
    const received = []
    const listener = () => received.push('unauthorized')
    window.addEventListener('bah:unauthorized', listener)
    const transport = connect()
    try {
      FakeEventSource.instances[0].emit('error')
      await vi.runAllTimersAsync()
      expect(received).toEqual(['unauthorized'])
      expect(FakeEventSource.instances).toHaveLength(1)
    } finally {
      window.removeEventListener('bah:unauthorized', listener)
      transport.close()
      document.head.innerHTML = ''
    }
  })

  it('M-01 命名心跳事件派发给宿主（注释行不会被 EventSource 派发）', async () => {
    globalThis.EventSource = FakeEventSource
    let beats = 0
    const transport = connect({ onHeartbeat: () => { beats += 1 } })
    try {
      FakeEventSource.instances[0].emit('heartbeat', {})
      expect(beats).toBe(1)
    } finally {
      transport.close()
    }
  })

  it('password 模式断线探测仍有效（/api/auth/me 200）→ 照常退避重连', async () => {
    vi.useFakeTimers()
    document.head.innerHTML = '<meta name="bah-auth-mode" content="password" />'
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    const transport = connect()
    try {
      FakeEventSource.instances[0].emit('error')
      await vi.runAllTimersAsync()
      expect(FakeEventSource.instances).toHaveLength(2)
    } finally {
      transport.close()
      document.head.innerHTML = ''
    }
  })
})

describe('transport · 02 TA-31 会话失效收敛', () => {
  it('任何 API 返回 401 → 派发 bah:unauthorized（登录门负责回登录卡片）', async () => {
    const received = []
    const listener = () => received.push('unauthorized')
    window.addEventListener('bah:unauthorized', listener)
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'web-unauthorized', reason: '缺少或失效的登录状态' } }),
    }))
    try {
      const api = createHttpApi({ token: '' })
      const result = await api.session()
      expect(result.ok).toBe(false)
      expect(result.status).toBe(401)
      expect(received).toEqual(['unauthorized'])
    } finally {
      window.removeEventListener('bah:unauthorized', listener)
    }
  })

  it('会话控制端点 401 同样交回登录门（转人工不是例外）', async () => {
    const received = []
    const listener = () => received.push('unauthorized')
    window.addEventListener('bah:unauthorized', listener)
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'web-unauthorized', reason: '缺少或失效的登录状态' } }),
    }))
    try {
      const control = createSessionControlClient({ token: '' })
      const result = await control.handoff('客户请求人工')
      expect(result.ok).toBe(false)
      expect(result.status).toBe(401)
      expect(received).toEqual(['unauthorized'])
    } finally {
      window.removeEventListener('bah:unauthorized', listener)
    }
  })

  it('M-08 429 的 retry-after 透出为 retryAfterSeconds（界面不再白等 60 秒）', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name === 'retry-after' ? '5' : null) },
      json: async () => ({ error: { code: 'turn-rate-limited', reason: '太频繁' } }),
    }))
    const api = createHttpApi({ token: 'web-token' })
    const result = await api.turn('查余额')
    expect(result.ok).toBe(false)
    expect(result.retryAfterSeconds).toBe(5)
  })

  it('非 401 的失败不触发登录门（403/500 是单次操作失败，不是会话失效）', async () => {
    const received = []
    const listener = () => received.push('unauthorized')
    window.addEventListener('bah:unauthorized', listener)
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: 'web-csrf-required', reason: '缺少 CSRF' } }),
    }))
    try {
      const api = createHttpApi({ token: 'web-token' })
      await api.turn('查余额')
      expect(received).toEqual([])
    } finally {
      window.removeEventListener('bah:unauthorized', listener)
    }
  })
})
