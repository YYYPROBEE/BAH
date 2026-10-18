/**
 * 失败 step 补记单测（施工单 03 §0 第 4 条 / T-LOOP-006 的前置件）。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '../session/types.ts'
import { ToolCallRecovery } from './recovery.ts'

/** 造一条 `tool/call` 事件。 */
function callEvent(callId: string, name = 'bank:probe'): AnySessionEvent {
  return {
    seq: 1,
    at: 1,
    formatVersion: 1,
    type: 'tool/call',
    data: { callId, name, args: {}, fingerprint: `${name}:{}`, tier: { level: 'green' }, at: 1 },
  }
}

/** 造一条 `tool/result` 事件。 */
function resultEvent(callId: string, name = 'bank:probe'): AnySessionEvent {
  return {
    seq: 2,
    at: 2,
    formatVersion: 1,
    type: 'tool/result',
    data: { callId, name, isError: false, content: [] },
  }
}

describe('ToolCallRecovery', () => {
  it('未闭合的调用在失败时补记为 isError（保证 call↔result 不空洞）', () => {
    const recovery = new ToolCallRecovery()
    recovery.observe(callEvent('c1'))

    expect(recovery.pending).toBe(1)
    const results = recovery.results()

    expect(results).toHaveLength(1)
    expect(results[0]?.callId).toBe('c1')
    expect(results[0]?.data).toMatchObject({
      callId: 'c1',
      name: 'bank:probe',
      isError: true,
      code: 'tool-interrupted',
    })
    expect(results[0]?.data.content).toEqual([{ type: 'text', text: 'step 中断：工具执行未完成' }])
  })

  it('已闭合的调用不再补记；无关事件被忽略', () => {
    const recovery = new ToolCallRecovery()
    recovery.observe(callEvent('c1'))
    recovery.observe(resultEvent('c1'))
    recovery.observe({ seq: 3, at: 3, formatVersion: 1, type: 'user/message', data: { content: 'x' } })

    expect(recovery.pending).toBe(0)
    expect(recovery.results()).toEqual([])
  })

  it('补记理由可定制（审计要区分「执行失败」与「没来得及执行」）', () => {
    const recovery = new ToolCallRecovery()
    recovery.observe(callEvent('c7', 'bank:transfer'))

    const [recovered] = recovery.results('模型请求被取消')
    expect(recovered?.data.reason).toBe('模型请求被取消')
  })
})
