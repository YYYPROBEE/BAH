/**
 * 会话观察状态（四接缝共享账本；无判决逻辑）。
 */

import { describe, expect, it } from 'vitest'

import type { RiskLevel } from '../kernel/index.ts'

import { SentryState } from './state.ts'

describe('SentryState', () => {
  it('turn 边界清空本 turn 计数与文本', () => {
    const state = new SentryState()
    state.beginTurn(1)
    state.noteToolCall()
    state.noteToolCall()
    state.noteToolResult()
    state.noteRead()
    state.noteAssistant('余额是 ¥1.00')
    state.noteAssistant('')
    state.noteResultAmount(100)
    state.noteResultAmount(100)
    expect(state.toolsInTurn).toBe(2)
    expect(state.toolResults).toBe(1)
    expect(state.readResults).toBe(1)
    expect(state.assistantTexts).toEqual(['余额是 ¥1.00'])
    expect(state.resultAmounts()).toEqual([100])

    state.beginTurn(2)
    expect(state.turn).toBe(2)
    expect(state.toolsInTurn).toBe(0)
    expect(state.toolResults).toBe(0)
    expect(state.readResults).toBe(0)
    expect(state.assistantTexts).toEqual([])
    expect(state.resultAmounts()).toEqual([])
  })

  it('风险分累加封顶 1，等级取更高的一档', () => {
    const state = new SentryState()
    state.raiseRisk(0.5, 'warn')
    expect(state.riskScore).toBe(0.5)
    expect(state.riskLevel).toBe('warn')
    state.raiseRisk(0.3, 'low')
    expect(state.riskScore).toBe(0.8)
    expect(state.riskLevel).toBe('warn')
    state.raiseRisk(0.5, 'high')
    expect(state.riskScore).toBe(1)
    expect(state.riskLevel).toBe('high')
    state.raiseRisk(0.1, 'high')
    expect(state.riskScore).toBe(1)
  })

  it('未知风险等级不会被静默忽略（封闭联合的 assertNever 收尾）', () => {
    const state = new SentryState()
    expect(() => state.raiseRisk(1, 'catastrophic' as RiskLevel)).toThrow('sentry-risk-level')
  })

  it('去重登记：同一次调用只计一次', () => {
    const state = new SentryState()
    expect(state.markDeny('call-1')).toBe(true)
    expect(state.markDeny('call-1')).toBe(false)
    expect(state.markInvalidArgs('call-1')).toBe(true)
    expect(state.markInvalidArgs('call-1')).toBe(false)
    expect(state.markGuardNotified(1)).toBe(true)
    expect(state.markGuardNotified(1)).toBe(false)
    expect(state.markCorrected(1)).toBe(true)
    expect(state.markCorrected(1)).toBe(false)
  })
})
