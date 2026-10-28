import { describe, expect, it } from 'vitest'

import { compareAttributeKeys, toJsonRow, toJsonTrace } from './export-json.ts'
import type { TelemetrySpan } from './span.ts'

function span(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'turn',
    startMs: 1000,
    endMs: 1010,
    status: 'ok',
    attributes: { steps: 1, turn: 1 },
    source: 'derived',
    ...overrides,
  }
}

describe('export-json · 键序与空值', () => {
  it('键顺序固定', () => {
    expect(Object.keys(toJsonRow(span()))).toEqual([
      'traceId',
      'spanId',
      'parentSpanId',
      'name',
      'startMs',
      'endMs',
      'status',
      'code',
      'attributes',
      'source',
    ])
  })

  it('null 显式输出（未闭合的 endMs、无理由码的 code）', () => {
    const row = toJsonRow(span({ endMs: null, status: 'unset' }))
    expect(row['endMs']).toBeNull()
    expect(row['code']).toBeNull()
  })

  it('attributes 按键名 localeCompare("en") 排序', () => {
    const row = toJsonRow(span({ attributes: { turn: 1, attempt: 2, model: 'm' } }))
    expect(Object.keys(row['attributes'] as Record<string, unknown>)).toEqual(['attempt', 'model', 'turn'])
  })

  it('compareAttributeKeys 是确定性的（同输入同结论）', () => {
    expect(compareAttributeKeys('a', 'b')).toBeLessThan(0)
    expect(compareAttributeKeys('b', 'a')).toBeGreaterThan(0)
    expect(compareAttributeKeys('a', 'a')).toBe(0)
  })
})

describe('export-json · 逐字节稳定', () => {
  it('同一输入两次调用完全相等', () => {
    const spans = [span(), span({ spanId: 'c'.repeat(16), name: 'step', parentSpanId: 'b'.repeat(16) })]
    expect(toJsonTrace(spans)).toBe(toJsonTrace(spans))
  })

  it('属性键的插入顺序不影响输出字节', () => {
    const a = toJsonTrace([span({ attributes: { turn: 1, steps: 2 } })])
    const b = toJsonTrace([span({ attributes: { steps: 2, turn: 1 } })])
    expect(a).toBe(b)
  })

  it('输出是裸数组，不包对象', () => {
    const parsed = JSON.parse(toJsonTrace([span()])) as unknown
    expect(Array.isArray(parsed)).toBe(true)
    expect((parsed as unknown[]).length).toBe(1)
  })

  it('空轨迹输出 []', () => {
    expect(JSON.parse(toJsonTrace([]))).toEqual([])
  })
})
