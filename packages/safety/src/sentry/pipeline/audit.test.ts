/**
 * 审计平面（`session/event`）：turn 边界 / 审批 / 判决 / 拒绝全量落 TraceLog；
 * 以及两条确定性触发（拒绝计数、非法参数降级）。
 */

import { createContext } from '@bah/core'
import type { Context, SessionId } from '@bah/core'
import { describe, expect, it } from 'vitest'

import { provideSentry, resolveSentrySettings, type SentryHandle } from './index.ts'

/** 审计平面测试台（只发 `session/event`，不触发任何工具管线）。 */
function harness(overrides: Readonly<Record<string, unknown>> = {}): {
  readonly ctx: Context
  readonly handle: SentryHandle
  emit(type: string, data: unknown): void
  types(): string[]
} {
  const ctx = createContext()
  let now = 1_000
  let seq = 0
  const settings = resolveSentrySettings(overrides)
  const handle = provideSentry(ctx, settings, {
    sessionId: 's-audit' as SessionId,
    now: () => {
      now += 1
      return now
    },
    record: () => {},
    toolTier: () => undefined,
    ticketStatus: () => undefined,
    revokeTickets: () => 0,
    nudge: () => {},
  })
  return {
    ctx,
    handle,
    emit(type, data) {
      seq += 1
      ctx.events.emit('session/event', { session: 's-audit', event: { type, seq, data } })
    },
    types() {
      return handle.trace.recent(100).map((record) => String(record['kind']))
    },
  }
}

describe('audit（观察 + 记账，不判决）', () => {
  it('turn 边界 / assistant / 工具 / 审批 / 票据 / 读结果全部落账', () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    test.emit('assistant/message', { content: [{ type: 'text', text: '好的' }] })
    test.emit('tool/call', { callId: 'c-1', name: 'account_balance' })
    test.emit('tool/result', {
      callId: 'c-1',
      name: 'account_balance',
      isError: false,
      content: [{ type: 'text', text: '余额 ¥1,234.56' }],
    })
    test.emit('read/balance', { result: {} })
    test.emit('approval/asked', { ticketId: 'ticket:c-2', callId: 'c-2', name: 'transfer_create' })
    test.emit('approval/decided', { ticketId: 'ticket:c-2', decision: 'unavailable', reason: 'no-responder' })
    test.emit('ticket/issued', { ticketId: 'ticket:c-2', callId: 'c-2' })
    test.emit('verify/locked', { sessionId: 's-audit', channel: 'face', until: 2, attempts: 3 })
    test.emit('policy/downgraded', { sessionId: 's-audit' })
    test.emit('guard/repeat-tool', { turn: 1, tools: 9, limit: 8 })
    test.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    test.emit('unknown/event', { whatever: true })

    const kinds = test.types()
    for (const expected of [
      'turn-start',
      'assistant',
      'tool-call',
      'tool-result',
      'read',
      'approval-asked',
      'approval-decided',
      'ticket/issued',
      'verify-locked',
      'policy-downgraded',
      'guard-repeat-tool',
      'turn-end',
    ]) {
      expect(`${expected}: ${kinds.includes(expected)}`).toBe(`${expected}: true`)
    }
    expect(test.handle.state.assistantTexts).toEqual(['好的'])
    expect(test.handle.state.readResults).toBe(1)
    expect(test.handle.state.toolResults).toBe(1)
  })

  it('审批 unavailable 不算拒绝（最终由 tool/result 的 approval-* 计入一次）', () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    test.emit('approval/decided', { ticketId: 'ticket:c-1', decision: 'unavailable' })
    expect(test.handle.breaker.countInWindow(2_000)).toBe(0)

    test.emit('tool/result', { callId: 'c-1', name: 'transfer_create', isError: true, code: 'approval-unavailable' })
    expect(test.handle.breaker.countInWindow(2_000)).toBe(1)
    // 同一次调用在 tier/decided 里再报一次也不重复计数
    test.emit('tier/decided', { callId: 'c-1', name: 'transfer_create', level: 'yellow', reason: 'declared', verdict: 'deny', code: 'approval-unavailable', at: 1 })
    expect(test.handle.breaker.countInWindow(2_000)).toBe(1)
  })

  it('窗口拒绝数跨来源累计：tier/decided deny 也计入（bank 的 no-identity）', () => {
    const test = harness({ breaker: { denyThreshold: 2 } })
    test.emit('tier/decided', { callId: 'a', name: 'transfer_create', level: 'green', reason: 'declared', verdict: 'deny', code: 'no-identity', at: 1 })
    test.emit('tier/decided', { callId: 'b', name: 'transfer_create', level: 'green', reason: 'declared', verdict: 'deny', code: 'no-identity', at: 2 })
    expect(test.handle.view().frozen).toBe(true)
  })

  it('tool-failed 不算拒绝（工具出错 ≠ 安全拒绝）', () => {
    const test = harness()
    test.emit('tool/result', { callId: 'c-1', name: 'transfer_create', isError: true, code: 'tool-failed' })
    expect(test.handle.breaker.countInWindow(2_000)).toBe(0)
  })

  it('非法参数连续计数与成功清零', () => {
    const test = harness({ degrade: { invalidArgsThreshold: 2 } })
    test.emit('tool/result', { callId: 'a', name: 'transfer_create', isError: true, code: 'tool-args-invalid' })
    expect(test.handle.state.degraded).toBe(false)
    test.emit('tool/result', { callId: 'b', name: 'transfer_create', isError: true, code: 'tool-args-invalid' })
    expect(test.handle.state.degraded).toBe(true)
  })

  it('畸形载荷不崩溃（防御性读取）', () => {
    const test = harness()
    test.emit('turn/start', null)
    test.emit('tool/result', null)
    test.emit('assistant/message', { content: [null, { type: 'image' }] })
    test.emit('tier/decided', {})
    expect(test.handle.state.turn).toBe(0)
    expect(test.handle.state.assistantTexts).toEqual([])
  })
})
