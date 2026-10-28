import { describe, expect, it } from 'vitest'

import { toChromeEvents, toChromeTrace } from './export-chrome.ts'
import type { TelemetrySpan } from './span.ts'

function span(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'tool.execute',
    startMs: 1_700_000_000_000,
    endMs: 1_700_000_000_007,
    status: 'ok',
    attributes: { tool: 'account_list' },
    source: 'derived',
    ...overrides,
  }
}

/** Chrome Trace 事件的形状（只声明本测试关心的字段）。 */
interface ChromeEvent {
  name: string
  cat?: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  args?: Record<string, unknown>
}

describe('export-chrome · 结构', () => {
  it('顶层是裸数组（Perfetto 要求）', () => {
    const parsed = JSON.parse(toChromeTrace([span()])) as unknown
    expect(Array.isArray(parsed)).toBe(true)
  })

  it('头部两条 metadata（process_name / thread_name）', () => {
    const events = JSON.parse(toChromeTrace([])) as ChromeEvent[]
    expect(events.map((e) => e.ph)).toEqual(['M', 'M'])
    expect(events[0]!.args?.['name']).toBe('BAH host')
    expect(events[1]!.args?.['name']).toBe('event-loop')
  })

  it('每条 span 都有 ph，且 pid/tid 固定为 1', () => {
    const events = JSON.parse(toChromeTrace([span(), span({ spanId: 'c'.repeat(16) })])) as ChromeEvent[]
    const spans = events.filter((e) => e.ph !== 'M')
    expect(spans).toHaveLength(2)
    for (const event of spans) {
      expect(event.ph).toBe('X')
      expect(event.pid).toBe(1)
      expect(event.tid).toBe(1)
    }
  })
})

describe('export-chrome · 时间单位', () => {
  it('ts 是微秒（毫秒 × 1000）', () => {
    const event = toChromeEvents(span())
    expect(event.ts).toBe(1_700_000_000_000_000)
  })

  it('dur 也是微秒', () => {
    expect(toChromeEvents(span()).dur).toBe(7000)
  })

  it('0ms 的 dur 钳到 1µs（否则 Perfetto 里看不见）', () => {
    expect(toChromeEvents(span({ endMs: 1_700_000_000_000 })).dur).toBe(1)
  })
})

describe('export-chrome · 未闭合', () => {
  it('未闭合用 ph:"B" 且不写 dur', () => {
    const event = toChromeEvents(span({ endMs: null, status: 'unset' }))
    expect(event.ph).toBe('B')
    expect(event.dur).toBeUndefined()
  })
})

describe('export-chrome · 字段映射', () => {
  it('cat 取名字前缀', () => {
    expect(toChromeEvents(span()).cat).toBe('tool')
    expect(toChromeEvents(span({ name: 'turn' })).cat).toBe('turn')
    expect(toChromeEvents(span({ name: 'plan.node' })).cat).toBe('plan')
  })

  it('args 是扁平的：attributes + spanId/parentSpanId/status/code', () => {
    const event = toChromeEvents(span())
    expect(event.args).toMatchObject({
      tool: 'account_list',
      spanId: 'b'.repeat(16),
      parentSpanId: null,
      status: 'ok',
      code: null,
    })
    for (const value of Object.values(event.args ?? {})) {
      expect(['string', 'number', 'boolean', 'object']).toContain(typeof value)
      expect(value === null || typeof value !== 'object').toBe(true)
    }
  })
})
