/**
 * 渠道适配器用例（施工单 13 §1：入站转换 / 出站投影 / 审批翻译）。
 *
 * 审批这段是本文件的重点：错误结论（缺理由的拒绝、非法枚举、重复应答）
 * 必须在**适配器**这一层就被挡住，而不是靠 HTTP 层或界面兜底。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'
import type { BahError } from '@bah/util'

import { createWebChannelAdapter } from './adapter.ts'
import type { ApprovalViewLike } from './adapter.ts'

/** 造一个审批视图（可观察 `answer` 调用）。 */
function view(overrides: Partial<ApprovalViewLike> = {}): ApprovalViewLike & { answers: unknown[] } {
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
      return { accepted: true }
    },
    ...overrides,
  }
}

describe('WebChannelAdapter · 入站', () => {
  it('直接输入视为可信，转发文本打 untrusted', () => {
    const adapter = createWebChannelAdapter()
    expect(adapter.inbound({ text: '  查余额  ' })).toMatchObject({ text: '查余额', untrusted: false })
    expect(adapter.inbound({ text: '转账', from: 'im:u-9' })).toMatchObject({
      text: '转账',
      untrusted: true,
      from: 'im:u-9',
    })
  })

  it('空消息抛结构化错误（不让空 user/message 落账）', () => {
    const adapter = createWebChannelAdapter()
    try {
      adapter.inbound({ text: '   ' })
      expect.unreachable('空消息必须抛错')
    } catch (error) {
      expect((error as BahError).code).toBe('web-empty-message')
    }
  })

  it('能力位全量：富卡片 / 按钮 / 表单 / 图片 / 流式', () => {
    // 施工单 01 / 00 D4：能力位从 5 字段扩到 10 字段后，对**整体**做 toEqual 会结构性必红。
    // 语义不变（这五个呈现位都为 true），所以只把被断言的主语投影成这五个字段，
    // 期望字面量一字未改（比 toMatchObject 更严：多一个键也会红）。
    const { richCards, buttons, forms, images, streaming } = createWebChannelAdapter().capabilities
    expect({ richCards, buttons, forms, images, streaming }).toEqual({
      richCards: true,
      buttons: true,
      forms: true,
      images: true,
      streaming: true,
    })
  })
})

describe('WebChannelAdapter · 出站', () => {
  it('render 与 projectSession 同源（不另写一套推导）', async () => {
    const adapter = createWebChannelAdapter()
    const events = [
      { seq: 1, at: 1, formatVersion: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, at: 2, formatVersion: 1, type: 'user/message', data: { content: '你好' } },
    ] as unknown as AnySessionEvent[]

    const frames = await adapter.render(events)
    expect(frames.map((frame) => frame.kind)).toEqual(['turn', 'message'])
  })
})

describe('WebChannelAdapter · 审批归属（W04）', () => {
  it('他会话的票据：decide 与 verify 都返回 foreign-ticket，且不触达 answer', async () => {
    const adapter = createWebChannelAdapter({ sessionId: 's-web' })
    const foreign = view({
      ticketId: 'ticket:foreign',
      sessionId: 's-other',
      challenge: { channel: 'sms', verify: async () => ({ ok: true }) },
    })
    adapter.attachApproval(foreign)

    expect(adapter.decide('ticket:foreign', { decision: 'allowed-once' })).toMatchObject({
      ok: false,
      code: 'foreign-ticket',
    })
    expect(foreign.answers).toEqual([])
    await expect(adapter.verify('ticket:foreign')).resolves.toMatchObject({
      ok: false,
      code: 'foreign-ticket',
    })
  })

  it('本会话的票据照常放行；未绑定会话时保持旧行为（单测 / 纯投影）', () => {
    const bound = createWebChannelAdapter({ sessionId: 's-web' })
    bound.attachApproval(view({ sessionId: 's-web' }))
    expect(bound.decide('ticket:call-1', { decision: 'allowed-once' })).toEqual({ ok: true })

    const unbound = createWebChannelAdapter()
    unbound.attachApproval(view({ sessionId: 's-any' }))
    expect(unbound.decide('ticket:call-1', { decision: 'allowed-once' })).toEqual({ ok: true })
  })
})

describe('WebChannelAdapter · 审批翻译', () => {
  it('登记后可按票据提交批准', () => {
    const adapter = createWebChannelAdapter()
    const target = view()
    adapter.attachApproval(target)

    expect(adapter.pendingTickets()).toEqual(['ticket:call-1'])
    expect(adapter.decide('ticket:call-1', { decision: 'allowed-once' })).toEqual({ ok: true })
    expect(target.answers).toEqual([{ decision: 'allowed-once' }])
    expect(adapter.pendingTickets()).toEqual([])
  })

  it('拒绝必须带理由（空理由 / 超长都拒绝）', () => {
    const adapter = createWebChannelAdapter()
    adapter.attachApproval(view())

    expect(adapter.decide('ticket:call-1', { decision: 'rejected' })).toMatchObject({
      ok: false,
      code: 'reason-required',
    })
    expect(adapter.decide('ticket:call-1', { decision: 'rejected', reason: '  ' })).toMatchObject({
      ok: false,
      code: 'reason-required',
    })
    expect(
      adapter.decide('ticket:call-1', { decision: 'rejected', reason: 'x'.repeat(501) }),
    ).toMatchObject({ ok: false, code: 'reason-required' })
  })

  it('带理由的拒绝被采纳并回传原因', () => {
    const adapter = createWebChannelAdapter()
    const target = view()
    adapter.attachApproval(target)

    expect(adapter.decide('ticket:call-1', { decision: 'rejected', reason: '不是我要的收款人' })).toEqual({
      ok: true,
    })
    expect(target.answers).toEqual([{ decision: 'rejected', reason: '不是我要的收款人' }])
  })

  it('未知票据 / 非法结论 / 已决都有结构化理由码', () => {
    const adapter = createWebChannelAdapter()
    expect(adapter.decide('ticket:none', { decision: 'allowed-once' })).toMatchObject({
      ok: false,
      code: 'unknown-ticket',
    })

    adapter.attachApproval(view())
    expect(adapter.decide('ticket:call-1', { decision: 'allow' })).toMatchObject({
      ok: false,
      code: 'invalid-decision',
    })

    const decided = view({ answer: () => ({ accepted: false, code: 'already-decided' }) })
    adapter.attachApproval({ ...decided, ticketId: 'ticket:call-2' })
    expect(adapter.decide('ticket:call-2', { decision: 'allowed-once' })).toMatchObject({
      ok: false,
      code: 'already-decided',
    })
  })

  it('超时（signal abort）自动摘掉在途票据', () => {
    const adapter = createWebChannelAdapter()
    const controller = new AbortController()
    adapter.attachApproval(view({ signal: controller.signal }))
    expect(adapter.pendingTickets()).toHaveLength(1)

    controller.abort()
    expect(adapter.pendingTickets()).toHaveLength(0)
  })

  it('dispose 清空在途票据', () => {
    const adapter = createWebChannelAdapter()
    adapter.attachApproval(view())
    adapter.dispose()
    expect(adapter.pendingTickets()).toEqual([])
  })
})
