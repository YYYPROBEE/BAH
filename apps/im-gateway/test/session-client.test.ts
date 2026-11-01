/**
 * 子进程 HTTP 客户端（施工单 02 §2.12）：状态码映射、凭证头、SSE 订阅。
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
