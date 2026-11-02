/**
 * 生产 HTTP 传输（`createNodeFetchJson`）。
 *
 * 现有用例都注入假 `fetchJson`，绕过了微信客服消息唯一的生产网络层；
 * 这里把全局 `fetch` 换成探针，钉住：POST 的 JSON 头与序列化、GET 不带 body、
 * 非 JSON 响应保留原文（异常时微信会回 HTML/空体）、以及网络错误照常上抛
 * （由 `createWechatPushText` 决定落拉取式，传输层不吞错）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createNodeFetchJson } from '../src/platform/wechat/transport.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createNodeFetchJson', () => {
  it('POST：content-type=application/json，body 序列化，返回状态与解析后的 JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createNodeFetchJson()('https://api.example.test/send', {
      method: 'POST',
      body: { touser: 'u-1', msgtype: 'text' },
    })

    expect(result).toEqual({ status: 200, body: { errcode: 0 } })
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('https://api.example.test/send')
    expect(call[1].method).toBe('POST')
    expect(call[1].headers).toEqual({ 'content-type': 'application/json' })
    expect(call[1].body).toBe('{"touser":"u-1","msgtype":"text"}')
  })

  it('GET（缺省）：不塞 body / headers', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await createNodeFetchJson()('https://api.example.test/health')

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[1].method).toBe('GET')
    expect(call[1].body).toBeUndefined()
    expect(call[1].headers).toBeUndefined()
  })

  it('非 JSON 响应：保留原文且不丢状态码（交给 errcodeOf 判 undefined）', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('<html>bad gateway</html>', { status: 502 }),
    )

    expect(await createNodeFetchJson()('https://api.example.test/send')).toEqual({
      status: 502,
      body: '<html>bad gateway</html>',
    })
  })

  it('网络错误照常上抛（失败语义由推送层决定，不在传输层吞掉）', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNRESET')
    })

    await expect(createNodeFetchJson()('https://api.example.test/send')).rejects.toThrow(
      'ECONNRESET',
    )
  })
})
