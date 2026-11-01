/**
 * 子进程就绪与 CSRF 握手（施工单 02 §2.11）：轮询、超时、cookie 解析。
 *
 * 这两条失败路径在真机上最难查：子进程"看起来起来了"但拿不到 CSRF，
 * 后续每条消息都 403。这里用注入的 fetch / sleep / nowMs 把毫秒级握手钉死。
 */

import { describe, expect, it } from 'vitest'

import {
  awaitChildReady,
  parseCsrfCookie,
  type FetchLike,
  type HttpResponseLike,
} from '../src/session/ready.ts'

const PORT = 4_100

/** 最小 HTTP 响应（只用到状态码与 set-cookie）。 */
function http(status: number, setCookie?: string): HttpResponseLike {
  return {
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'set-cookie' ? (setCookie ?? null) : null),
    },
  }
}

describe('parseCsrfCookie', () => {
  it('缺失 / 空值 / 空 token ⇒ undefined', () => {
    expect(parseCsrfCookie(undefined)).toBeUndefined()
    expect(parseCsrfCookie(null)).toBeUndefined()
    expect(parseCsrfCookie('')).toBeUndefined()
    expect(parseCsrfCookie('bah_csrf=')).toBeUndefined()
    expect(parseCsrfCookie('other=1')).toBeUndefined()
  })

  it('从多 cookie 串里取 bah_csrf，并去掉首尾空白', () => {
    expect(parseCsrfCookie('foo=1; bah_csrf=abc123; Path=/; HttpOnly')).toBe('abc123')
    expect(parseCsrfCookie('bah_csrf=  token-9  ; Path=/')).toBe('token-9')
    expect(parseCsrfCookie('bah_csrf=a=b')).toBe('a=b')
  })
})

describe('awaitChildReady：健康检查 + 入口握手', () => {
  it('拒绝连接 / 503 都继续轮询；200 后取 cookie；握手请求不带凭证', async () => {
    const calls: string[] = []
    const sleeps: number[] = []
    let step = 0
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url)
      step += 1
      if (step === 1) throw new Error('ECONNREFUSED')
      if (step === 2) return http(503)
      if (url.endsWith('/m.html')) return http(200, 'bah_csrf=csrf-1; Path=/; HttpOnly')
      return http(200)
    }

    const result = await awaitChildReady({
      port: PORT,
      timeoutMs: 5_000,
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      nowMs: () => 0,
      pollMs: 20,
    })

    expect(result).toEqual({ csrf: 'csrf-1' })
    expect(calls).toEqual([
      `http://127.0.0.1:${String(PORT)}/api/health`,
      `http://127.0.0.1:${String(PORT)}/api/health`,
      `http://127.0.0.1:${String(PORT)}/api/health`,
      `http://127.0.0.1:${String(PORT)}/m.html`,
    ])
    expect(sleeps).toEqual([20, 20])
  })

  it('健康检查超时 ⇒ im-child-timeout，且不请求入口', async () => {
    let clock = 0
    const calls: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url)
      return http(503)
    }

    await expect(
      awaitChildReady({
        port: PORT,
        timeoutMs: 450,
        fetch: fetchImpl,
        sleep: async (ms) => {
          clock += ms
        },
        nowMs: () => clock,
        pollMs: 200,
      }),
    ).rejects.toMatchObject({
      code: 'im-child-timeout',
      detail: { port: PORT },
    })
    expect(calls).toEqual([
      `http://127.0.0.1:${String(PORT)}/api/health`,
      `http://127.0.0.1:${String(PORT)}/api/health`,
      `http://127.0.0.1:${String(PORT)}/api/health`,
    ])
  })

  it('超时为 0 ⇒ 一次健康检查都不发，直接失败', async () => {
    const calls: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url)
      return http(200)
    }
    await expect(
      awaitChildReady({ port: PORT, timeoutMs: 0, fetch: fetchImpl, nowMs: () => 0 }),
    ).rejects.toMatchObject({ code: 'im-child-timeout' })
    expect(calls).toEqual([])
  })

  it('入口没下发 bah_csrf ⇒ im-child-handshake（拒绝带着必然 403 的状态继续）', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith('/api/health') ? http(200) : http(200, 'other=1; Path=/')

    await expect(
      awaitChildReady({
        port: PORT,
        timeoutMs: 1_000,
        fetch: fetchImpl,
        sleep: async () => undefined,
        nowMs: () => 0,
      }),
    ).rejects.toMatchObject({
      code: 'im-child-handshake',
      detail: { port: PORT },
    })
  })

  it('入口 cookie 为空串 ⇒ 同样按握手失败处理', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith('/api/health') ? http(200) : http(200, 'bah_csrf=; Path=/')

    await expect(
      awaitChildReady({
        port: PORT,
        timeoutMs: 1_000,
        fetch: fetchImpl,
        sleep: async () => undefined,
        nowMs: () => 0,
      }),
    ).rejects.toMatchObject({ code: 'im-child-handshake' })
  })
})
