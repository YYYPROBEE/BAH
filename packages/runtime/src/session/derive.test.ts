/**
 * 派生投影单测（施工单 03 §1.4 / §4 的 T-SESS-002 ~ 004）。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { deriveMessages } from './derive.ts'
import { SessionStore } from './store.ts'
import { KNOWN_SESSION_EVENT_TYPES, type AnySessionEvent } from './types.ts'

/** 造一段覆盖全部平台族的日志（每条事件各一条，验证 switch 穷尽）。 */
function fullLog(): ReturnType<SessionStore['events']> {
  const store = new SessionStore()
  store.append('turn/start', { turn: 1 })
  store.append('step/start', { turn: 1, step: 1 })
  store.append('request/header', { turn: 1, step: 1, model: 'deepseek-chat' })
  store.append('request/context', { turn: 1, step: 1, texts: ['上下文'] })
  store.append('system/message', { content: '你是银行助手' })
  store.append('user/message', { content: '查一下余额' })
  store.append('assistant/attempt', { status: 'retried', reason: '429' })
  store.append('assistant/message', {
    content: [{ type: 'text', text: '我来查' }],
    toolCalls: [{ callId: 'c1', name: 'bank:balance', args: {} }],
  })
  store.append('tool/call', {
    callId: 'c1',
    name: 'bank:balance',
    args: {},
    fingerprint: 'bank:balance:{}',
    tier: { level: 'green' },
    at: 1,
  })
  store.append('approval/asked', {
    ticketId: 'ticket:c1' as never,
    callId: 'c1',
    name: 'bank:balance',
  })
  store.append('approval/decided', {
    ticketId: 'ticket:c1' as never,
    decision: 'allowed-once',
  })
  store.append('tool/result', {
    callId: 'c1',
    name: 'bank:balance',
    isError: false,
    content: [{ type: 'text', text: '余额 100' }],
  })
  store.append('step/end', { turn: 1, step: 1 })
  store.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return store.events()
}

describe('deriveMessages', () => {
  it('T-SESS-002 system/user/assistant/tool 消息序列正确', () => {
    const messages = deriveMessages(fullLog())

    expect(messages).toEqual([
      { role: 'system', content: '你是银行助手' },
      { role: 'user', content: '查一下余额' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '我来查' }],
        toolCalls: [{ callId: 'c1', name: 'bank:balance', args: {} }],
      },
      {
        role: 'tool',
        callId: 'c1',
        name: 'bank:balance',
        isError: false,
        content: [{ type: 'text', text: '余额 100' }],
      },
    ])
  })

  it('T-SESS-003 tool/call 没有 tool/result → 抛「日志空洞」错', () => {
    const store = new SessionStore()
    store.append('user/message', { content: '转账' })
    store.append('tool/call', {
      callId: 'c9',
      name: 'bank:transfer',
      args: { amount: 100 },
      fingerprint: 'bank:transfer:{"amount":100}',
      tier: { level: 'red', amountPath: 'amount' },
      at: 1,
    })

    const error = captureThrown(() => deriveMessages(store.events()))
    expect(error.code).toBe('session-log-hole')
    expect(error.message).toContain('bank:transfer#c9')
  })

  it('T-SESS-004 ignorable 事件被旧 reader 跳过；required 事件缺失则报错', () => {
    const store = new SessionStore()
    store.append('user/message', { content: '你好' })
    // 用「旧 reader 的白名单」把 user/message 排除，模拟表外事件
    const onlySystem = new Set(['system/message'])
    const events = store.events()

    const skipped = deriveMessages(
      [{ ...events[0]!, ignorable: true }],
      { known: onlySystem },
    )
    expect(skipped).toEqual([])

    const error = captureThrown(() => deriveMessages(events, { known: onlySystem }))
    expect(error.code).toBe('session-unknown-event')
    expect(error.message).toContain('required-on-read')

    // 默认白名单包含全量平台族
    expect(KNOWN_SESSION_EVENT_TYPES.has('user/message')).toBe(true)
  })

  it('request/context 不进模型历史（reconcile 归 05 §5，投影不另塞消息）', () => {
    // 钉住有意的语义：运行时上下文不是"消息"，它由提示词装配按 reconcile 规则并入请求
    // （施工单 05 §5）。若有人把它当 user 消息塞进历史，会污染模型可见序列。
    const store = new SessionStore()
    store.append('request/context', { turn: 1, step: 1, texts: ['运行时上下文'] })

    expect(deriveMessages(store.events())).toEqual([])
  })

  it('表内新增键但未接投影 → fail-loud（不许静默丢消息）', () => {
    const unprojected = {
      seq: 1,
      at: 1,
      formatVersion: 1,
      type: 'domain/unprojected',
      data: {},
    } as unknown as AnySessionEvent

    const error = captureThrown(() =>
      deriveMessages([unprojected], { known: new Set(['domain/unprojected']) }),
    )
    expect(error.code).toBe('session-unprojected-event')
    expect(error.message).toContain('domain/unprojected')
  })
})
