/**
 * `PlatformAdapter` 契约测试。
 *
 * 同一套断言跑**两个实现**（微信与 Mock）。只有一个实现时，"契约"会退化成
 * "微信的形状"；两个实现跑同一套断言，契约才是真的契约。
 */

import { describe, expect, it } from 'vitest'

import type {
  PlatformAdapter,
  PlatformPushResult,
  PlatformRequest,
  PlatformResponse,
} from '@bah/channels'
import { computeWechatSignature, createWechatAdapter } from '@bah/channels'

import { createMockAdapter } from './mock-platform.ts'

/** 契约 fixture：把两个平台的差异全部收在构造器里。 */
interface Fixture {
  readonly name: string
  readonly adapter: PlatformAdapter
  readonly nowSec: number
  readonly verifyOk: PlatformRequest
  readonly verifyBad: PlatformRequest
  readonly textRequest: PlatformRequest
  readonly expectedText: string
  readonly challengeRequest: PlatformRequest
  readonly challengeEcho: string
  readonly unsupportedRequest: PlatformRequest
  readonly contentOf: (response: PlatformResponse) => string
  readonly pushed: () => readonly string[]
  readonly failNextPush: () => void
}

const NOW = 1_793_000_000

/** 微信 fixture（签名自算；不写死十六进制）。 */
function wechatFixture(): Fixture {
  const pushed: string[] = []
  let fail = false
  const token = 'cb-token'
  const nonce = 'nonce-1'
  const signed = (echo?: string): PlatformRequest => ({
    method: echo === undefined ? 'POST' : 'GET',
    path: '/im/wechat/default',
    query: {
      signature: computeWechatSignature(token, String(NOW), nonce),
      timestamp: String(NOW),
      nonce,
      ...(echo === undefined ? {} : { echostr: echo }),
    },
    headers: {},
    body: '',
  })

  const adapter = createWechatAdapter({
    accountKey: 'default',
    token,
    appId: 'app-id',
    appSecret: 'app-secret',
    apiBase: 'http://127.0.0.1:9',
    nowSec: () => NOW,
    pushText: async (_userId, text): Promise<PlatformPushResult> => {
      if (fail) {
        fail = false
        return { ok: false, code: 'unavailable', reason: 'fake' }
      }
      pushed.push(text)
      return { ok: true }
    },
  })

  return {
    name: 'wechat',
    adapter,
    nowSec: NOW,
    verifyOk: signed(),
    verifyBad: { ...signed(), query: { signature: 'bad', timestamp: String(NOW), nonce } },
    textRequest: {
      ...signed(),
      body:
        '<xml><ToUserName><![CDATA[gh]]></ToUserName><FromUserName><![CDATA[o]]></FromUserName>' +
        '<CreateTime>1793000000</CreateTime><MsgType><![CDATA[text]]></MsgType>' +
        '<Content><![CDATA[查余额]]></Content></xml>',
    },
    expectedText: '查余额',
    challengeRequest: signed('echo-1'),
    challengeEcho: 'echo-1',
    unsupportedRequest: {
      ...signed(),
      body:
        '<xml><ToUserName>gh</ToUserName><FromUserName>o</FromUserName>' +
        '<CreateTime>1793000000</CreateTime><MsgType>event</MsgType><Event>CLICK</Event></xml>',
    },
    contentOf: (response) => /<Content><!\[CDATA\[([\s\S]*?)\]\]><\/Content>/.exec(response.body)?.[1] ?? '',
    pushed: () => pushed,
    failNextPush: () => {
      fail = true
    },
  }
}

/** Mock fixture。 */
function mockFixture(): Fixture {
  const adapter = createMockAdapter({ nowMs: () => NOW * 1000 })
  const auth = { token: 'mock-token' }
  const post = (body: unknown): PlatformRequest => ({
    method: 'POST',
    path: '/im/mock/default',
    query: auth,
    headers: {},
    body: JSON.stringify(body),
  })

  return {
    name: 'mock',
    adapter,
    nowSec: NOW,
    verifyOk: post({ userId: 'u-1', text: '查余额' }),
    verifyBad: { ...post({}), query: { token: 'bad' } },
    textRequest: post({ userId: 'u-1', text: '查余额' }),
    expectedText: '查余额',
    challengeRequest: { ...post({}), method: 'GET', query: { ...auth, echostr: 'echo-1' } },
    challengeEcho: 'echo-1',
    unsupportedRequest: post({ kind: 'event' }),
    contentOf: (response) => {
      const parsed = JSON.parse(response.body) as { outbounds: unknown[] }
      return parsed.outbounds.map((item) => String(item)).join('\n')
    },
    pushed: () => adapter.state.pushes.map((item) => item.text),
    failNextPush: () => {
      adapter.state.failNextPush = true
    },
  }
}

const FIXTURES: readonly Fixture[] = [wechatFixture(), mockFixture()]

describe.each(FIXTURES)('契约 · $name', (fixture) => {
  const { adapter } = fixture

  it('id 非空；能力位五字段齐全且取值为布尔/正整数', () => {
    expect(adapter.id.length).toBeGreaterThan(0)
    expect(typeof adapter.capabilities.passiveReply).toBe('boolean')
    expect(typeof adapter.capabilities.asyncPush).toBe('boolean')
    expect(typeof adapter.capabilities.interactiveCards).toBe('boolean')
    expect(typeof adapter.capabilities.threads).toBe('boolean')
    expect(Number.isInteger(adapter.capabilities.maxTextBytes)).toBe(true)
    expect(adapter.capabilities.maxTextBytes).toBeGreaterThan(0)
  })

  it('verify：合法请求 → ok；伪造凭证 → 401 结构化失败', () => {
    expect(adapter.verify(fixture.verifyOk, fixture.nowSec)).toEqual({ ok: true })
    const bad = adapter.verify(fixture.verifyBad, fixture.nowSec)
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.status).toBe(401)
    expect(bad.code.length).toBeGreaterThan(0)
  })

  it('parse 文本消息 → message；platform 是适配器 id，text 是原文', () => {
    const parsed = adapter.parse(fixture.textRequest, fixture.nowSec)
    expect(parsed.kind).toBe('message')
    if (parsed.kind !== 'message') return
    expect(parsed.inbound.platform).toBe(adapter.id)
    expect(parsed.inbound.text).toBe(fixture.expectedText)
    expect(parsed.inbound.accountKey.length).toBeGreaterThan(0)
  })

  it('parse 挑战请求 → challenge，原样回显', () => {
    const parsed = adapter.parse(fixture.challengeRequest, fixture.nowSec)
    expect(parsed.kind).toBe('challenge')
    if (parsed.kind !== 'challenge') return
    expect(parsed.response.body).toBe(fixture.challengeEcho)
    expect(parsed.response.status).toBe(200)
  })

  it('parse 不支持的消息 → unsupported 且 200（不跑 turn）', () => {
    const parsed = adapter.parse(fixture.unsupportedRequest, fixture.nowSec)
    expect(parsed.kind).toBe('unsupported')
    if (parsed.kind !== 'unsupported') return
    expect(parsed.response.status).toBe(200)
  })

  it('passive：输出非空，内容不超过 maxTextBytes', () => {
    const parsed = adapter.parse(fixture.textRequest, fixture.nowSec)
    if (parsed.kind !== 'message') throw new Error('应为 message')
    const response = parsed.reply.passive([{ kind: 'text', text: '您好' }])
    expect(response.status).toBe(200)
    expect(response.body.length).toBeGreaterThan(0)
    const content = fixture.contentOf(response)
    expect(content.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(adapter.capabilities.maxTextBytes)
  })

  it('push：成功时实际发出至少一条', async () => {
    const parsed = adapter.parse(fixture.textRequest, fixture.nowSec)
    if (parsed.kind !== 'message') throw new Error('应为 message')
    const before = fixture.pushed().length
    await expect(parsed.reply.push([{ kind: 'text', text: '结果' }])).resolves.toEqual({ ok: true })
    expect(fixture.pushed().length).toBeGreaterThan(before)
  })

  it('push：失败返回结构化 code（五码之一），不抛', async () => {
    const parsed = adapter.parse(fixture.textRequest, fixture.nowSec)
    if (parsed.kind !== 'message') throw new Error('应为 message')
    fixture.failNextPush()
    const result = await parsed.reply.push([{ kind: 'text', text: '结果' }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(['unavailable', 'expired-window', 'quota', 'unauthorized', 'failed']).toContain(result.code)
  })
})
