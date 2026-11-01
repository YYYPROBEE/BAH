/**
 * IM 渠道薄工厂用例。
 *
 * T-CH-003 的判据是"审批五法语义未分叉"：同一输入下 im 与 web 的六码判决必须逐字相同。
 * 只断言"能批/不能批"太弱——分叉往往先从文案或码名开始。
 */

import { describe, expect, it } from 'vitest'

import { IM_CAPABILITIES } from '../capabilities.ts'
import type { HttpChannelAdapter } from '../http-adapter.ts'
import { createWebChannelAdapter } from '../web/adapter.ts'
import { IM_CHANNEL_ID, createImChannelAdapter } from './adapter.ts'

const AT = 1_700_000_000_000

describe('createImChannelAdapter（T-CH-002）', () => {
  it('id 是 im，能力位取自 IM_CAPABILITIES（同一引用）', () => {
    expect(IM_CHANNEL_ID).toBe('im')
    const adapter = createImChannelAdapter()
    expect(adapter.id).toBe('im')
    expect(adapter.capabilities).toBe(IM_CAPABILITIES)
  })

  it('能力位四字段如实：richCards/buttons true、forms/streaming false', () => {
    const adapter = createImChannelAdapter()
    expect(adapter.capabilities.richCards).toBe(true)
    expect(adapter.capabilities.buttons).toBe(true)
    expect(adapter.capabilities.forms).toBe(false)
    expect(adapter.capabilities.streaming).toBe(false)
  })

  it('sessionId 原样透传：归属校验在 IM 端同样生效（W04）', () => {
    const adapter = createImChannelAdapter({ sessionId: 's-im' })
    const controller = new AbortController()
    adapter.attachApproval({
      ticketId: 'ticket:x',
      sessionId: 's-other',
      callId: 'call-x',
      name: 'transfer_create',
      signal: controller.signal,
      answer: () => ({ accepted: true }),
    })
    expect(adapter.decide('ticket:x', { decision: 'allowed-once' })).toMatchObject({
      ok: false,
      code: 'foreign-ticket',
    })
  })
})

describe('审批六码与 web 同源（T-CH-003）', () => {
  /** 同一份票面 + 同一份应答，分别喂给两个适配器。 */
  function both(
    answer: (input: { decision: string; reason?: string }) => { accepted: boolean; code?: string },
  ): { im: ReturnType<typeof createImChannelAdapter>; web: ReturnType<typeof createWebChannelAdapter> } {
    const im = createImChannelAdapter({ sessionId: 's-1' })
    const web = createWebChannelAdapter({ sessionId: 's-1' })
    for (const adapter of [im, web]) {
      const controller = new AbortController()
      adapter.attachApproval({
        ticketId: 'ticket:abc',
        sessionId: 's-1',
        callId: 'call-1',
        name: 'transfer_create',
        signal: controller.signal,
        answer,
      })
    }
    return { im, web }
  }

  const cases: readonly {
    readonly name: string
    readonly run: (adapter: HttpChannelAdapter) => unknown
  }[] = [
    { name: 'unknown-ticket', run: (adapter) => adapter.decide('ticket:none', { decision: 'allowed-once' }) },
    { name: 'invalid-decision', run: (adapter) => adapter.decide('ticket:abc', { decision: 'yes' }) },
    { name: 'reason-required', run: (adapter) => adapter.decide('ticket:abc', { decision: 'rejected' }) },
    { name: 'reason-too-long', run: (adapter) => adapter.decide('ticket:abc', { decision: 'rejected', reason: '很'.repeat(501) }) },
  ]

  it.each(cases)('$name 的判决与 web 逐字相同', ({ run }) => {
    const pair = both(() => ({ accepted: true }))
    expect(run(pair.im)).toEqual(run(pair.web))
  })

  it('already-decided / expired 的映射与 web 相同', () => {
    const decided = both(() => ({ accepted: false, code: 'already-answered' }))
    expect(decided.im.decide('ticket:abc', { decision: 'allowed-once' })).toEqual(
      decided.web.decide('ticket:abc', { decision: 'allowed-once' }),
    )

    const expired = both(() => ({ accepted: false, code: 'expired' }))
    expect(expired.im.decide('ticket:abc', { decision: 'rejected', reason: '到期' })).toEqual(
      expired.web.decide('ticket:abc', { decision: 'rejected', reason: '到期' }),
    )
  })

  it('强验证：无挑战 → no-challenge，与 web 同', async () => {
    const pair = both(() => ({ accepted: true }))
    await expect(pair.im.verify('ticket:abc')).resolves.toEqual(await pair.web.verify('ticket:abc'))
  })

  it('inbound 的 untrusted 判据与 web 同（from 有值才算转发）', () => {
    const im = createImChannelAdapter()
    const web = createWebChannelAdapter()
    expect(im.inbound({ text: '你好', at: AT })).toEqual(web.inbound({ text: '你好', at: AT }))
    expect(im.inbound({ text: '转发内容', from: 'third-party' })).toEqual(
      web.inbound({ text: '转发内容', from: 'third-party' }),
    )
  })
})
