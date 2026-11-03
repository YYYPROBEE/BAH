/**
 * 子进程 HTTP 客户端：状态码映射、凭证头、SSE 订阅。
 *
 * WHY 单测这个文件：网关的集成用例都注入假 `ChildClient`，真实实现只在
 * 监督者里被装配——它一旦把 423 当成功、把客户 token 用到运营桥，线上才会发现。
 * 这里用注入的 fetch 钉死每一条出站请求的形状与每一条回包语义。
 */

import { describe, expect, it, vi } from 'vitest'

import type { WebFrame } from '@bah/channels'

import {
  createChildClient,
  type ChildClientDeps,
  type ClientFetch,
  type ClientRequestInit,
  type ClientResponse,
} from '../src/session/client.ts'
import { HEARTBEAT_MS } from '../src/session/overlay.ts'

const PORT = 4_100
const TOKEN = 'child-token/with-slash'
const CSRF = 'csrf-token-1'
const OPERATOR = 'operator-token-1'

interface Call {
  readonly url: string
  readonly init?: ClientRequestInit
}

/** 造一个只带文本的响应。 */
function response(status: number, text = ''): ClientResponse {
  return { status, body: null, text: async () => text }
}

/** 造一个 SSE 流式响应；每个字符串是一块 `Uint8Array`。 */
function streamResponse(chunks: readonly string[], status = 200): ClientResponse {
  let index = 0
  return {
    status,
    body: {
      getReader: () => ({
        read: async () => {
          const chunk = chunks[index]
          index += 1
          if (chunk === undefined) return { done: true, value: undefined }
          return { done: false, value: new TextEncoder().encode(chunk) }
        },
      }),
    } as unknown as NonNullable<ClientResponse['body']>,
    text: async () => '',
  }
}

/** 记录每次 fetch 的入参。 */
function recorder(impl: (call: Call) => Promise<ClientResponse>): {
  readonly fetch: ClientFetch
  readonly calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      const call: Call = { url, ...(init === undefined ? {} : { init }) }
      calls.push(call)
      return impl(call)
    },
  }
}

/** 固定一次性回包。 */
function once(responseValue: ClientResponse): {
  readonly fetch: ClientFetch
  readonly calls: Call[]
} {
  return recorder(async () => responseValue)
}

/** 客户端依赖（默认注入 recorder 的 fetch）。 */
function clientWith(
  fetchImpl: ClientFetch,
  overrides: Partial<ChildClientDeps> = {},
): ReturnType<typeof createChildClient> {
  return createChildClient({
    port: PORT,
    token: TOKEN,
    csrf: CSRF,
    fetch: fetchImpl,
    ...overrides,
  })
}

describe('turn：状态码 → 网关语义', () => {
  it('202 ⇒ accepted；请求带 Bearer + 双提交 CSRF + JSON 文本', async () => {
    const { fetch, calls } = once(response(202))
    await expect(clientWith(fetch).turn('你好')).resolves.toEqual({ kind: 'accepted' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`http://127.0.0.1:${String(PORT)}/api/turn`)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'x-bah-csrf': CSRF,
      cookie: `bah_csrf=${CSRF}`,
      'content-type': 'application/json',
    })
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ text: '你好' }))
  })

  it.each([
    [423, { kind: 'halted' }],
    [401, { kind: 'auth' }],
    [403, { kind: 'auth' }],
    [500, { kind: 'failed', status: 500, code: 'unexpected-status' }],
  ])('%i ⇒ %o', async (status, expected) => {
    const { fetch } = once(response(status))
    await expect(clientWith(fetch).turn('x')).resolves.toEqual(expected)
  })

  it('503 web-inbox-full ⇒ inbox-full；其它 code 原样带回；读不出 code ⇒ unknown', async () => {
    const full = once(response(503, JSON.stringify({ error: { code: 'web-inbox-full' } })))
    await expect(clientWith(full.fetch).turn('x')).resolves.toEqual({ kind: 'inbox-full' })

    const busy = once(response(503, JSON.stringify({ error: { code: 'web-halted' } })))
    await expect(clientWith(busy.fetch).turn('x')).resolves.toEqual({
      kind: 'failed',
      status: 503,
      code: 'web-halted',
    })

    const plain = once(response(503, 'Service Unavailable'))
    await expect(clientWith(plain.fetch).turn('x')).resolves.toEqual({
      kind: 'failed',
      status: 503,
      code: 'unknown',
    })

    const numeric = once(response(503, JSON.stringify({ error: { code: 42 } })))
    await expect(clientWith(numeric.fetch).turn('x')).resolves.toEqual({
      kind: 'failed',
      status: 503,
      code: 'unknown',
    })
  })

  it('网络层失败 ⇒ failed/status:0/code:network（不抛给调用方）', async () => {
    const client = clientWith(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(client.turn('x')).resolves.toEqual({ kind: 'failed', status: 0, code: 'network' })
  })
})

describe('health：探活只认 200', () => {
  it('200 ⇒ true；非 200 ⇒ false；网络失败 ⇒ false', async () => {
    const ok = once(response(200))
    await expect(clientWith(ok.fetch).health()).resolves.toBe(true)

    const degraded = once(response(503))
    await expect(clientWith(degraded.fetch).health()).resolves.toBe(false)

    const down = clientWith(async () => {
      throw new Error('connect refused')
    })
    await expect(down.health()).resolves.toBe(false)
  })

  it('探活不带任何凭证（公开路由）', async () => {
    const { fetch, calls } = once(response(200))
    await clientWith(fetch).health()
    expect(calls[0]?.url).toBe(`http://127.0.0.1:${String(PORT)}/api/health`)
    expect(calls[0]?.init).toBeUndefined()
  })
})

describe('审批 / 转人工 JSON 调用', () => {
  it('decide：票号编码进路径，带客户凭证与双提交 CSRF', async () => {
    const { fetch, calls } = once(response(200, JSON.stringify({ ok: true })))
    const result = await clientWith(fetch).decide('t/1', {
      decision: 'rejected',
      reason: '金额不对',
    })
    expect(result).toEqual({ status: 200, json: { ok: true }, text: '{"ok":true}' })
    expect(calls[0]?.url).toBe(`http://127.0.0.1:${String(PORT)}/api/approval/t%2F1`)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'x-bah-csrf': CSRF,
      cookie: `bah_csrf=${CSRF}`,
      'content-type': 'application/json',
    })
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ decision: 'rejected', reason: '金额不对' }),
    )
  })

  it('verify：空对象入参；requestHandoff 省略理由时不注入 reason 字段', async () => {
    const verified = once(response(200, '{}'))
    await clientWith(verified.fetch).verify('t-1')
    expect(verified.calls[0]?.url).toContain('/api/verify/t-1')
    expect(verified.calls[0]?.init?.body).toBe('{}')

    const handoff = once(response(202, '{}'))
    await clientWith(handoff.fetch).requestHandoff()
    expect(handoff.calls[0]?.url).toContain('/api/handoff')
    expect(handoff.calls[0]?.init?.body).toBe('{}')

    const withReason = once(response(202, '{}'))
    await clientWith(withReason.fetch).requestHandoff('客户要求')
    expect(withReason.calls[0]?.init?.body).toBe(JSON.stringify({ reason: '客户要求' }))
  })

  it('网络失败 ⇒ status:0 且不抛；非 JSON 正文 ⇒ json 为空但保留原文与状态', async () => {
    const down = clientWith(async () => {
      throw new Error('socket hang up')
    })
    await expect(down.decide('t-1', { decision: 'allowed-once' })).resolves.toEqual({
      status: 0,
      json: undefined,
      text: '',
    })

    const html = once(response(502, '<html>bad gateway</html>'))
    await expect(clientWith(html.fetch).verify('t-1')).resolves.toEqual({
      status: 502,
      json: undefined,
      text: '<html>bad gateway</html>',
    })
  })
})

describe('seat：运营桥凭证隔离', () => {
  it('未配置运营凭证 ⇒ 503 im-seat-unconfigured，且不发任何请求', async () => {
    const { fetch, calls } = once(response(200, '{}'))
    await expect(clientWith(fetch).seat('GET', '/api/handoff')).resolves.toEqual({
      status: 503,
      json: { error: { code: 'im-seat-unconfigured', reason: '子进程未配置运营凭证' } },
      text: '',
    })
    expect(calls).toHaveLength(0)
  })

  it('配置后只用运营 token（不得回落到客户 token），CSRF 仍双提交', async () => {
    const { fetch, calls } = once(response(200, '{"ok":true}'))
    const client = clientWith(fetch, { operatorToken: OPERATOR })
    await client.seat('POST', '/api/handoff/takeover', { sessionKey: 's-1' })

    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:${String(PORT)}/api/handoff/takeover`,
    )
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toEqual({
      authorization: `Bearer ${OPERATOR}`,
      'x-bah-csrf': CSRF,
      cookie: `bah_csrf=${CSRF}`,
      'content-type': 'application/json',
    })
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ sessionKey: 's-1' }))
  })
})

describe('subscribe：SSE 订阅', () => {
  it('携带 bearer 与 token 查询参数；跨块拼帧、忽略非 frame 事件', async () => {
    const { fetch, calls } = recorder(async () =>
      streamResponse([
        ': connected\n\nevent: frame\ndata: {"kind":"notice","seq":1',
        '}\n\ndata: {"kind":"message","seq":2}\n\n',
      ]),
    )
    const onFrame = vi.fn<(frame: WebFrame) => void>()
    const onOpen = vi.fn()
    const onError = vi.fn()
    const unsubscribe = clientWith(fetch).subscribe({ onFrame, onOpen, onError })

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    expect(onFrame.mock.calls[0]?.[0]).toEqual({ kind: 'notice', seq: 1 })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()

    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:${String(PORT)}/api/events?token=${encodeURIComponent(TOKEN)}&since=0`,
    )
    expect(calls[0]?.init?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      accept: 'text/event-stream',
    })

    unsubscribe()
    expect(calls[0]?.init?.signal?.aborted).toBe(true)
  })

  it.each([
    ['非 200', () => streamResponse([], 503)],
    ['没有响应体', () => response(200)],
    ['网络失败', null],
  ])('%s ⇒ onError（onOpen 不触发）', async (_label, makeResponse) => {
    const fetch: ClientFetch =
      makeResponse === null
        ? async () => {
            throw new Error('connect refused')
          }
        : async () => makeResponse()
    const onFrame = vi.fn()
    const onOpen = vi.fn()
    const onError = vi.fn()
    clientWith(fetch).subscribe({ onFrame, onOpen, onError })

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onOpen).not.toHaveBeenCalled()
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('取消订阅后不再上报后续读取错误', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetch: ClientFetch = async (_url, init) => ({
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            await blocked
            throw new Error('stream reset')
          },
        }),
      } as unknown as NonNullable<ClientResponse['body']>,
      text: async () => '',
    })
    const onError = vi.fn()
    const unsubscribe = clientWith(fetch).subscribe({ onFrame: vi.fn(), onError })

    unsubscribe()
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onError).not.toHaveBeenCalled()
  })
})

/**
 * 心跳看门狗（M-01 的网关侧等价物）。
 *
 * 为什么要钉：TCP 被中间设备黑洞掉时 `reader.read()` 只是**一直挂着**，既不报错也不结束。
 * 没有看门狗，IM 子进程会停在"看起来还连着"的状态，用户发的话永远进不去、也没有任何故障信号。
 * 心跳本身是宿主 `sse.ts` 的命名事件（`event: heartbeat`），所以这里同时钉两件事：
 * 心跳块**当作活跃度**续命，但**不能被当成帧**上报。
 */
describe('subscribe：心跳空闲看门狗', () => {
  /** 空闲判死阈值 = 1.5 个心跳周期；看门狗自身的轮询间隔。 */
  const IDLE_LIMIT_MS = HEARTBEAT_MS * 1.5
  const POLL_MS = Math.min(HEARTBEAT_MS, 5_000)

  /**
   * 一条"发完给定块就再也不动"的流。
   *
   * `gapMs > 0` 时每块之间按假计时器等待（模拟宿主按心跳节拍出话）；
   * 块用完之后 `read()` 返回一个**永不 settle** 的 promise —— 这正是黑洞。
   */
  function pacedStream(chunks: readonly string[], gapMs: number): ClientResponse {
    const encoder = new TextEncoder()
    let index = 0
    return {
      status: 200,
      body: {
        getReader: () => ({
          read: () => {
            const chunk = chunks[index]
            if (chunk === undefined) return new Promise(() => undefined)
            index += 1
            return new Promise((resolve) => {
              setTimeout(
                () => resolve({ done: false, value: encoder.encode(chunk) }),
                gapMs,
              )
            })
          },
        }),
      } as unknown as NonNullable<ClientResponse['body']>,
      text: async () => '',
    }
  }

  const heartbeatBlock = (at: number) => `event: heartbeat\ndata: ${String(at)}\n\n`

  it('1.5 个心跳周期没有任何字节 ⇒ 主动 abort 并按 onError 上报（浏览器不会替我们报）', async () => {
    vi.useFakeTimers()
    try {
      const { fetch, calls } = recorder(async () => pacedStream([], 0))
      const onFrame = vi.fn()
      const onOpen = vi.fn()
      const onError = vi.fn()
      const unsubscribe = clientWith(fetch).subscribe({ onFrame, onOpen, onError })

      await vi.advanceTimersByTimeAsync(0)
      expect(onOpen).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(IDLE_LIMIT_MS + POLL_MS)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(String(onError.mock.calls[0]?.[0])).toContain('心跳超时')
      // 判死必须把连接关掉：否则同一条僵尸连接还占着宿主的并发额度
      expect(calls[0]?.init?.signal?.aborted).toBe(true)

      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it('心跳持续到达 ⇒ 不误判离线；心跳停了才判死，且心跳不被当成帧上报', async () => {
    vi.useFakeTimers()
    try {
      const chunks = [heartbeatBlock(1), heartbeatBlock(2), heartbeatBlock(3), heartbeatBlock(4)]
      const { fetch } = recorder(async () => pacedStream(chunks, 10_000))
      const onFrame = vi.fn()
      const onError = vi.fn()
      const unsubscribe = clientWith(fetch).subscribe({ onFrame, onError })

      // 4 个心跳 × 10s：每次都在 22.5s 的空闲阈值之内 ⇒ 一次都不该判死
      await vi.advanceTimersByTimeAsync(4 * 10_000 + POLL_MS)
      expect(onError).not.toHaveBeenCalled()
      // 心跳只证明"连接还活着"，不是业务帧
      expect(onFrame).not.toHaveBeenCalled()

      // 心跳停了：从最后一个字节起再空转 1.5 个周期 ⇒ 判死
      await vi.advanceTimersByTimeAsync(IDLE_LIMIT_MS + POLL_MS)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(String(onError.mock.calls[0]?.[0])).toContain('心跳超时')

      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it('取消订阅 ⇒ 看门狗计时器一并撤掉（不留一个会给已关闭连接报障的定时器）', async () => {
    vi.useFakeTimers()
    try {
      const { fetch } = recorder(async () => pacedStream([heartbeatBlock(1)], 10_000))
      const onError = vi.fn()
      const unsubscribe = clientWith(fetch).subscribe({ onFrame: vi.fn(), onError })

      await vi.advanceTimersByTimeAsync(0)
      unsubscribe()
      await vi.advanceTimersByTimeAsync(IDLE_LIMIT_MS * 2)
      expect(onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
