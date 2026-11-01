/**
 * B4：`tool/result` 上链摘要的投影契约。
 *
 * 摘要会被 `sha256(canonicalJson(...))` 写进审计链，replay 会从会话事件重算并**硬比对**。
 * 因此这里钉三件事：字段集合与顺序稳定（增字段 = 断旧链）、PII 原文不外泄、
 * 坏载荷 fail-loud 而不是写一条形状错误的链行。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { toolResultSummaryOf } from './tool-result-summary.ts'

describe('toolResultSummaryOf：最小字段集', () => {
  it('只投影 callId / name / isError，content 与 reason 等原文不再出现在摘要里', () => {
    const data = {
      callId: 'c-1',
      name: 'transfer_create',
      isError: false,
      content: [{ type: 'text', text: '已转账给王建国 800 元' }],
      reason: '审批通过',
      payee: { name: '王建国', account: '6222020200001234' },
    }
    const summary = toolResultSummaryOf(data)
    expect(summary).toEqual({ callId: 'c-1', name: 'transfer_create', isError: false })
    expect(Object.keys(summary)).toEqual(['callId', 'name', 'isError'])
    expect(JSON.stringify(summary)).not.toContain('王建国')
    expect(JSON.stringify(summary)).not.toContain('6222')
  })

  it('code / durationMs 只在类型正确时出现，且顺序固定（重放哈希依赖字节序）', () => {
    const summary = toolResultSummaryOf({
      callId: 'c-2',
      name: 'account_balance',
      isError: true,
      code: 'upstream-timeout',
      durationMs: 42,
    })
    expect(Object.keys(summary)).toEqual(['callId', 'name', 'isError', 'code', 'durationMs'])
    expect(summary).toEqual({
      callId: 'c-2',
      name: 'account_balance',
      isError: true,
      code: 'upstream-timeout',
      durationMs: 42,
    })
  })

  it('可选字段类型不对 → 丢弃而不是抛错或转字符串', () => {
    const summary = toolResultSummaryOf({
      callId: 'c-3',
      name: 'txn_query',
      isError: false,
      code: 500,
      durationMs: '42',
    })
    expect(summary).toEqual({ callId: 'c-3', name: 'txn_query', isError: false })
  })

  it('不修改入参', () => {
    const data = { callId: 'c-4', name: 'x', isError: false, content: ['原文'] }
    const before = structuredClone(data)
    toolResultSummaryOf(data)
    expect(data).toEqual(before)
  })
})

describe('toolResultSummaryOf：坏载荷 fail-loud', () => {
  const badPayloads: readonly { readonly label: string; readonly data: unknown }[] = [
    { label: 'null', data: null },
    { label: '字符串', data: 'c-1' },
    { label: '数字', data: 1 },
    { label: '缺全部字段', data: {} },
    { label: '数组（没有 callId）', data: [] },
    { label: 'callId 类型错', data: { callId: 1, name: 'x', isError: false } },
    { label: 'name 类型错', data: { callId: 'c', name: null, isError: false } },
    { label: 'isError 不是布尔', data: { callId: 'c', name: 'x', isError: 'false' } },
  ]

  for (const { label, data } of badPayloads) {
    it(`${label} → tool-result-summary-invalid`, () => {
      const error = captureThrown(() => toolResultSummaryOf(data))
      expect(error.code).toBe('tool-result-summary-invalid')
      expect(error.message.startsWith('bah-saga: tool-result-summary-invalid:')).toBe(true)
    })
  }
})
