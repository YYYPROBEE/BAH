import { describe, expect, it } from 'vitest'

import type { PlatformPushResult, PlatformRequest } from '../platform.ts'
import type { ImOutbound } from '../render.ts'
import { computeWechatSignature } from './signature.ts'
import { createWechatAdapter, type WechatAdapterDeps } from './wechat-adapter.ts'
import { WECHAT_TEXT_MAX_BYTES } from './outbound.ts'

const NOW = 1_793_000_000
const NONCE = 'abcdefgh'

/** 造一份带签名的微信回调请求。 */
function request(overrides: Partial<PlatformRequest> = {}): PlatformRequest {
  const timestamp = String(NOW)
  return {
    method: 'POST',
    path: '/im/wechat/default',
    query: {
      signature: computeWechatSignature('cb-token', timestamp, NONCE),
      timestamp,
      nonce: NONCE,
    },
    headers: {},
    body: '',
    ...overrides,
  }
}

/** 微信文本报文。 */
const TEXT_XML = [
  '<xml>',
  '<ToUserName><![CDATA[gh_public]]></ToUserName>',
  '<FromUserName><![CDATA[o_user]]></FromUserName>',
  '<CreateTime>1793000000</CreateTime>',
  '<MsgType><![CDATA[text]]></MsgType>',
  '<Content><![CDATA[查余额]]></Content>',
  '<MsgId>42</MsgId>',
  '</xml>',
].join('')

/** 造一个适配器（push 记录到数组）。 */
function adapter(overrides: Partial<WechatAdapterDeps> = {}): {
  readonly adapter: ReturnType<typeof createWechatAdapter>
  readonly pushed: { userId: string; text: string }[]
  readonly deps: WechatAdapterDeps
} {
  const pushed: { userId: string; text: string }[] = []
  const deps: WechatAdapterDeps = {
    accountKey: 'default',
    token: 'cb-token',
    appId: 'app-id',
    appSecret: 'app-secret',
    apiBase: 'http://127.0.0.1:9',
    nowSec: () => NOW,
    pushText: async (userId, text) => {
      pushed.push({ userId, text })
      return { ok: true }
    },
    ...overrides,
  }
  return { adapter: createWechatAdapter(deps), pushed, deps }
}

describe('能力位与 id（T-IM-023 的适配器面）', () => {
  it('id = wechat，能力位逐字段固定', () => {
    const { adapter: wechat } = adapter()
    expect(wechat.id).toBe('wechat')
    expect(wechat.capabilities).toEqual({
      passiveReply: true,
      asyncPush: true,
      interactiveCards: false,
      threads: false,
      maxTextBytes: WECHAT_TEXT_MAX_BYTES,
    })
  })
})

describe('verify（T-IM-008 的适配器面）', () => {
  it('合法签名 → ok', () => {
    const { adapter: wechat } = adapter()
    expect(wechat.verify(request(), NOW)).toEqual({ ok: true })
  })

  it('签名错 → 401 + 结构化 code（不回显期望值）', () => {
    const { adapter: wechat } = adapter()
    expect(wechat.verify(request({ query: { signature: 'wrong', timestamp: String(NOW), nonce: NONCE } }), NOW)).toEqual({
      ok: false,
      status: 401,
      code: 'im-sig-mismatch',
    })
  })

  it('缺参数 → 401 + im-sig-missing', () => {
    const { adapter: wechat } = adapter()
    expect(wechat.verify(request({ query: {} }), NOW)).toEqual({
      ok: false,
      status: 401,
      code: 'im-sig-missing',
    })
  })
})

describe('parse：握手与消息（T-IM-009）', () => {
  it('GET + echostr + 合法签名 → challenge 原样回显', () => {
    const { adapter: wechat } = adapter()
    const result = wechat.parse(request({ method: 'GET', query: { ...request().query, echostr: 'echo-123' } }), NOW)
    expect(result).toEqual({
      kind: 'challenge',
      response: {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'echo-123',
      },
    })
  })

  it('GET 没有 echostr → reject im-challenge-missing', () => {
    const { adapter: wechat } = adapter()
    expect(wechat.parse(request({ method: 'GET' }), NOW)).toEqual({
      kind: 'reject',
      status: 400,
      code: 'im-challenge-missing',
    })
  })

  it('GET 挑战前自己验签：失败 → reject 401（不依赖网关是否先验）', () => {
    const { adapter: wechat } = adapter()
    const result = wechat.parse(
      request({ method: 'GET', query: { signature: 'bad', timestamp: String(NOW), nonce: NONCE, echostr: 'x' } }),
      NOW,
    )
    expect(result).toEqual({ kind: 'reject', status: 401, code: 'im-sig-mismatch' })
  })

  it('POST 文本 → message，inbound 字段齐全', () => {
    const { adapter: wechat } = adapter()
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    expect(result.kind).toBe('message')
    if (result.kind !== 'message') return
    expect(result.inbound).toEqual({
      platform: 'wechat',
      accountKey: 'default',
      userId: 'o_user',
      text: '查余额',
      messageId: '42',
      at: 1793000000 * 1000,
    })
  })

  it('POST 事件 → unsupported，回 success（不跑 turn）', () => {
    const { adapter: wechat } = adapter()
    const result = wechat.parse(
      request({
        body:
          '<xml><ToUserName>gh</ToUserName><FromUserName>o</FromUserName><CreateTime>1793000000</CreateTime>' +
          '<MsgType>event</MsgType><Event>subscribe</Event></xml>',
      }),
      NOW,
    )
    expect(result).toEqual({
      kind: 'unsupported',
      response: {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'success',
      },
    })
  })

  it('POST 坏 XML → reject 400，code 透出 im-xml-*', () => {
    const { adapter: wechat } = adapter()
    expect(wechat.parse(request({ body: '<!DOCTYPE xml><xml></xml>' }), NOW)).toEqual({
      kind: 'reject',
      status: 400,
      code: 'im-xml-rejected',
    })
  })

  it('POST 超长 → reject 413（与"不合法"分开，便于运维定位）', () => {
    const { adapter: wechat } = adapter()
    const big = `<xml><Content>${'x'.repeat(20 * 1024)}</Content></xml>`
    expect(wechat.parse(request({ body: big }), NOW)).toEqual({
      kind: 'reject',
      status: 413,
      code: 'im-xml-too-large',
    })
  })

  it('POST 不是 BahError 的异常也收敛成 im-xml-invalid', () => {
    const { adapter: wechat } = adapter()
    // 空 body 让解析器抛的是 BahError；这里用结构性非法报文覆盖"兜底分支"的语义
    expect(wechat.parse(request({ body: '<xml><FromUserName>o</FromUserName></xml>' }), NOW)).toEqual({
      kind: 'reject',
      status: 400,
      code: 'im-xml-invalid',
    })
  })
})

describe('reply.passive：被动回复只能承载一条文本（§2.2）', () => {
  const outbound = (text: string): ImOutbound => ({ kind: 'text', text })

  /** 取出 XML 里的 Content 文本（用于字节断言）。 */
  function contentOf(body: string): string {
    const match = /<Content><!\[CDATA\[([\s\S]*?)\]\]><\/Content>/.exec(body)
    return match?.[1] ?? ''
  }

  it('空出站 → success（不编造空内容）', () => {
    const { adapter: wechat } = adapter()
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    if (result.kind !== 'message') throw new Error('应为 message')
    expect(result.reply.passive([])).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'success',
    })
  })

  it('只有空白文本 → success', () => {
    const { adapter: wechat } = adapter()
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    if (result.kind !== 'message') throw new Error('应为 message')
    expect(result.reply.passive([outbound('   ')])).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'success',
    })
  })

  it('单条文本 → XML 被动回复（收发件人对调 + 注入时间）', () => {
    const { adapter: wechat } = adapter()
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    if (result.kind !== 'message') throw new Error('应为 message')
    const response = result.reply.passive([outbound('您好，余额 1000 元')])
    expect(response.headers['content-type']).toBe('application/xml; charset=utf-8')
    expect(response.body).toContain('<ToUserName><![CDATA[o_user]]></ToUserName>')
    expect(response.body).toContain('<FromUserName><![CDATA[gh_public]]></FromUserName>')
    expect(response.body).toContain(`<CreateTime>${String(NOW)}</CreateTime>`)
    expect(contentOf(response.body)).toBe('您好，余额 1000 元')
  })

  it('多条短文本用 \\n 合并（用户看到一条消息里的多行）', () => {
    const { adapter: wechat } = adapter()
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    if (result.kind !== 'message') throw new Error('应为 message')
    expect(contentOf(result.reply.passive([outbound('第一行'), outbound('第二行')]).body)).toBe(
      '第一行\n第二行',
    )
  })

  it('合并后超过 maxTextBytes → 只回第一片，其余留给 push', () => {
    const { adapter: wechat } = adapter()
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    if (result.kind !== 'message') throw new Error('应为 message')
    const content = contentOf(result.reply.passive([outbound('A'.repeat(2048)), outbound('B'.repeat(64))]).body)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(WECHAT_TEXT_MAX_BYTES)
    expect(content).not.toContain('B')
  })
})

describe('reply.push：客服消息逐条分片（T-IM-012 / T-IM-021）', () => {
  const outbound = (text: string): ImOutbound => ({ kind: 'text', text })

  it('空出站不发请求 → ok', async () => {
    const { adapter: wechat, pushed } = adapter()
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    if (result.kind !== 'message') throw new Error('应为 message')
    await expect(result.reply.push([])).resolves.toEqual({ ok: true })
    expect(pushed).toEqual([])
  })

  it('空白文本跳过（不打扰用户）', async () => {
    const { adapter: wechat, pushed } = adapter()
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    if (result.kind !== 'message') throw new Error('应为 message')
    await expect(result.reply.push([outbound('  ')])).resolves.toEqual({ ok: true })
    expect(pushed).toEqual([])
  })

  it('成功逐条发送，userId 是 openid', async () => {
    const { adapter: wechat, pushed } = adapter()
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    if (result.kind !== 'message') throw new Error('应为 message')
    await result.reply.push([outbound('一'), outbound('二')])
    expect(pushed).toEqual([
      { userId: 'o_user', text: '一' },
      { userId: 'o_user', text: '二' },
    ])
  })

  it('长文本分片发送，每片带 (i/n) 前缀且 ≤ maxTextBytes', async () => {
    const { adapter: wechat, pushed } = adapter()
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    if (result.kind !== 'message') throw new Error('应为 message')
    const long = '查'.repeat(1500) // 4500 字节
    await result.reply.push([outbound(long)])
    expect(pushed.length).toBeGreaterThan(1)
    pushed.forEach((item, index) => {
      expect(item.text.startsWith(`(${String(index + 1)}/`)).toBe(true)
      expect(Buffer.byteLength(item.text, 'utf8')).toBeLessThanOrEqual(WECHAT_TEXT_MAX_BYTES)
    })
  })

  it('任一片失败立即返回该失败（不把半截结果继续发完）', async () => {
    const failure: PlatformPushResult = { ok: false, code: 'expired-window', reason: '45015' }
    const sent: string[] = []
    const { adapter: wechat } = adapter({
      pushText: async (_userId, text) => {
        sent.push(text)
        return text.startsWith('(2/') ? failure : { ok: true }
      },
    })
    const result = wechat.parse(request({ body: TEXT_XML }), NOW)
    if (result.kind !== 'message') throw new Error('应为 message')
    const long = '查'.repeat(1500)
    await expect(result.reply.push([outbound(long)])).resolves.toEqual(failure)
    expect(sent.length).toBe(2)
  })
})
