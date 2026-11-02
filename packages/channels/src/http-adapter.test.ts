/**
 * HTTP 系适配器工厂的共用行为。
 *
 * 同一组夹具对 `web` / `mobile` 两个 id 各跑一遍：结果必须**逐条相同**——这正是 D2
 * "同源"的可执行判据。审批是安全面，六码与文案一个不许因渠道而变。
 */

import { describe, expect, it } from 'vitest'

import type { BahError } from '@bah/util'

import { MOBILE_CAPABILITIES, WEB_CAPABILITIES } from './capabilities.ts'
import {
  createHttpChannelAdapter,
  type ApprovalViewLike,
  type HttpChannelAdapter,
} from './http-adapter.ts'

/** 两个渠道的参数化面：只允许 id 与能力位不同。 */
const CHANNELS = [
  { id: 'web', capabilities: WEB_CAPABILITIES },
  { id: 'mobile', capabilities: MOBILE_CAPABILITIES },
] as const

/** 造一个审批视图（可观察 `answer` 调用与自定义 receipt）。 */
function view(
  overrides: Partial<ApprovalViewLike> & {
    readonly receipt?: { readonly accepted: boolean; readonly code?: string }
  } = {},
): ApprovalViewLike & { answers: unknown[] } {
  const answers: unknown[] = []
  const controller = new AbortController()
  return {
    ticketId: 'ticket:call-1',
    sessionId: 's-web',
    callId: 'call-1',
    name: 'transfer_create',
    signal: controller.signal,
    answers,
    answer(answer) {
      answers.push(answer)
      return overrides.receipt ?? { accepted: true }
    },
    ...overrides,
  }
}

/** 造一个绑定了会话的适配器。 */
function adapterOf(id: 'web' | 'mobile', sessionId?: string): HttpChannelAdapter {
  const capabilities = CHANNELS.find((item) => item.id === id)?.capabilities ?? WEB_CAPABILITIES
  return createHttpChannelAdapter({
    id,
    capabilities,
    ...(sessionId === undefined ? {} : { sessionId }),
  })
}

describe('createHttpChannelAdapter · 同源（TC-MCH-07）', () => {
  it('web 与 mobile 用同一组夹具跑 inbound / decide / verify，结果逐条相同', () => {
    const results = CHANNELS.map((channel) => {
      const adapter = createHttpChannelAdapter({
        id: channel.id,
        capabilities: channel.capabilities,
        sessionId: 's-1',
      })
      const inbound = adapter.inbound({ text: ' 查余额 ', from: 'im:u-9' })
      const empty = (() => {
        try {
          adapter.inbound({ text: ' ' })
          return 'no-throw'
        } catch (error) {
          return (error as BahError).code
        }
      })()
      const unknown = adapter.decide('nope', { decision: 'allowed-once' })
      return { id: adapter.id, inbound, empty, unknown }
    })

    expect(results[0]).toEqual({ ...results[1], id: 'web' })
    // 防夹具退化：空文本确实抛了结构化错误
    expect(results.map((item) => item.empty)).toEqual(['web-empty-message', 'web-empty-message'])
    // capabilities 与传入的是同一引用（不是深拷贝）
    expect(adapterOf('mobile').capabilities).toBe(MOBILE_CAPABILITIES)
    expect(adapterOf('web').capabilities).toBe(WEB_CAPABILITIES)
  })
})

describe('createHttpChannelAdapter · decide 六码（TC-MCH-08..10）', () => {
  it('未 attach ⇒ unknown-ticket；跨会话 ⇒ foreign-ticket 且不触达 answer', () => {
    const adapter = adapterOf('mobile', 's-1')
    expect(adapter.decide('ticket:absent', { decision: 'allowed-once' })).toEqual({
      ok: false,
      code: 'unknown-ticket',
      reason: '没有待应答的票据 ticket:absent',
    })

    const foreign = view({ sessionId: 's-2' })
    adapter.attachApproval(foreign)
    expect(adapter.decide('ticket:call-1', { decision: 'allowed-once' })).toEqual({
      ok: false,
      code: 'foreign-ticket',
      reason: '票据不属于当前会话',
    })
    expect(foreign.answers).toHaveLength(0)
  })

  it('非法结论 ⇒ invalid-decision', () => {
    const adapter = adapterOf('web')
    adapter.attachApproval(view())
    expect(adapter.decide('ticket:call-1', { decision: 'always' })).toMatchObject({
      ok: false,
      code: 'invalid-decision',
    })
    expect(adapter.decide('ticket:call-1', {})).toMatchObject({ ok: false, code: 'invalid-decision' })
  })

  it('rejected 缺理由 ⇒ reason-required；500 字通过、501 字拒绝（MAX_REASON 边界）', () => {
    const adapter = adapterOf('web')
    adapter.attachApproval(view())
    expect(adapter.decide('ticket:call-1', { decision: 'rejected', reason: '   ' })).toMatchObject({
      ok: false,
      code: 'reason-required',
    })

    const atLimit = view({ ticketId: 'ticket:500' })
    adapter.attachApproval(atLimit)
    expect(adapter.decide('ticket:500', { decision: 'rejected', reason: '理'.repeat(500) })).toEqual({
      ok: true,
    })
    expect(atLimit.answers).toHaveLength(1)

    const overLimit = view({ ticketId: 'ticket:501' })
    adapter.attachApproval(overLimit)
    expect(adapter.decide('ticket:501', { decision: 'rejected', reason: '理'.repeat(501) })).toMatchObject({
      ok: false,
      code: 'reason-required',
      reason: '拒绝理由不得超过 500 字',
    })
    expect(overLimit.answers).toHaveLength(0)
  })

  it('票据已有结论 ⇒ already-decided；票据过期 ⇒ expired（先到者胜出）', () => {
    const adapter = adapterOf('mobile')
    const decided = view({ receipt: { accepted: false, code: 'already-decided' } })
    adapter.attachApproval(decided)
    expect(adapter.decide('ticket:call-1', { decision: 'allowed-once' })).toEqual({
      ok: false,
      code: 'already-decided',
      reason: '该票据已有结论（先到者胜出）',
    })

    const expired = view({ receipt: { accepted: false, code: 'expired' } })
    adapter.attachApproval(expired)
    expect(adapter.decide('ticket:call-1', { decision: 'allowed-once' })).toEqual({
      ok: false,
      code: 'expired',
      reason: '票据已过期，结论未采纳',
    })
  })

  it('成功路径把结论与理由传进 view.answer，并清出 pendingTickets', () => {
    const adapter = adapterOf('mobile')
    adapter.attachApproval(view())
    expect(adapter.pendingTickets()).toEqual(['ticket:call-1'])
    expect(adapter.decide('ticket:call-1', { decision: 'allowed-once' })).toEqual({ ok: true })
    expect(adapter.pendingTickets()).toEqual([])
  })
})

describe('createHttpChannelAdapter · verify 四路 + 收尾（TC-MCH-11）', () => {
  it('unknown-ticket / foreign-ticket / no-challenge / 透传 code 或兜底 verify-failed', async () => {
    const adapter = adapterOf('web', 's-1')
    expect(await adapter.verify('nope')).toMatchObject({ ok: false, code: 'unknown-ticket' })

    const foreign = view({ sessionId: 's-2' })
    adapter.attachApproval(foreign)
    expect(await adapter.verify('ticket:call-1')).toMatchObject({ ok: false, code: 'foreign-ticket' })

    const noChallenge = view({ sessionId: 's-1', ticketId: 'ticket:plain', callId: 'call-2' })
    adapter.attachApproval(noChallenge)
    expect(await adapter.verify('ticket:plain')).toEqual({
      ok: false,
      code: 'no-challenge',
      reason: '该票据不需要强验证',
    })

    const failed = view({
      sessionId: 's-1',
      ticketId: 'ticket:challenge',
      callId: 'call-3',
      challenge: { channel: 'sms', verify: async () => ({ ok: false, code: 'sms-code-mismatch', reason: '验证码错误' }) },
    })
    adapter.attachApproval(failed)
    expect(await adapter.verify('ticket:challenge')).toEqual({
      ok: false,
      code: 'sms-code-mismatch',
      reason: '验证码错误',
    })

    const noCode = view({
      sessionId: 's-1',
      ticketId: 'ticket:challenge-2',
      callId: 'call-4',
      challenge: { channel: 'face', verify: async () => ({ ok: false }) },
    })
    adapter.attachApproval(noCode)
    expect(await adapter.verify('ticket:challenge-2')).toEqual({
      ok: false,
      code: 'verify-failed',
      reason: '强验证未通过',
    })

    const passed = view({
      sessionId: 's-1',
      ticketId: 'ticket:challenge-3',
      callId: 'call-5',
      challenge: { channel: 'ushield', verify: async () => ({ ok: true }) },
    })
    adapter.attachApproval(passed)
    expect(await adapter.verify('ticket:challenge-3')).toEqual({ ok: true })
  })

  it('dispose 幂等；signal abort 后 pendingTickets 不再包含该票', () => {
    const adapter = adapterOf('mobile')
    const controller = new AbortController()
    const abortable = view({ ticketId: 'ticket:abort', callId: 'call-9', signal: controller.signal })
    adapter.attachApproval(abortable)
    expect(adapter.pendingTickets()).toEqual(['ticket:abort'])

    controller.abort()
    expect(adapter.pendingTickets()).toEqual([])

    adapter.attachApproval(view({ ticketId: 'ticket:keep', callId: 'call-10' }))
    adapter.dispose()
    adapter.dispose()
    expect(adapter.pendingTickets()).toEqual([])
  })

  it('render 与 projectSession 同源（不另写一套推导）', async () => {
    const adapter = adapterOf('mobile')
    const frames = await adapter.render([
      { seq: 1, at: 1, formatVersion: 1, type: 'turn/start', data: { turn: 1 } },
    ] as never)
    expect(frames.map((frame) => frame.kind)).toEqual(['turn'])
  })
})
