import { describe, expect, it } from 'vitest'

import {
  assertAttributes,
  durationMsOf,
  isOpen,
  MAX_ATTRIBUTE_STRING,
  SPAN_ATTRIBUTE_KEYS,
  SPAN_NAMES,
  spanNamesAllowing,
  STRUCTURAL_ATTRIBUTE_KEYS,
  type SpanName,
  type TelemetrySpan,
} from './span.ts'

/** 一个最小合法 span（`endMs: null` = 未闭合）。 */
function span(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'turn',
    startMs: 1000,
    endMs: 1010,
    status: 'ok',
    attributes: {},
    source: 'derived',
    ...overrides,
  }
}

describe('span · 名字闭集', () => {
  it('恰好 13 个且无重复', () => {
    expect(SPAN_NAMES).toHaveLength(13)
    expect(new Set(SPAN_NAMES).size).toBe(13)
  })

  it('每个名字都有属性白名单行（新增名字忘了登记会红）', () => {
    for (const name of SPAN_NAMES) expect(SPAN_ATTRIBUTE_KEYS[name]).toBeDefined()
  })

  it('名字全部是「域.动作」两段（或单词），不出现三段', () => {
    for (const name of SPAN_NAMES) {
      expect(name).toMatch(/^[a-z]+(\.[a-z]+)?$/)
    }
  })
})

describe('span · 属性白名单（每个名字一条合法 / 一条非法）', () => {
  const LEGAL: Record<SpanName, Record<string, string | number | boolean>> = {
    'http.request': { method: 'GET', route: '/api/metrics', status: 200, bytes: 12, requestSeq: 1 },
    'sse.attach': { clients: 1, since: 0 },
    turn: { turn: 1, end: 'completed', steps: 2 },
    step: { turn: 1, step: 1 },
    'llm.call': { model: 'mock:a', attempt: 1, ttftMs: 12, chunks: 3 },
    'tool.execute': { tool: 'account_list', tier: 'green', isError: false },
    'approval.wait': { tool: 'transfer_create', decision: 'allowed-once', challenge: 'face' },
    'plan.run': { planId: 'p1', nodes: 2, status: 'succeeded', dryRun: false },
    'plan.node': { planId: 'p1', nodeId: 'a', tool: 'account_list', ordinal: 1, status: 'succeeded' },
    'saga.run': { sagaId: 's1', businessType: 'transfer', status: 'succeeded' },
    'rag.answer': { kind: 'policy', verdict: 'pass', citations: 2 },
    'rag.query': { kind: 'policy', verdict: 'pass', visibleCount: 3 },
    'policy.evaluate': { verdict: 'allow', policyVersion: 'v1', engineSource: 'compiled' },
  }

  for (const name of SPAN_NAMES) {
    it(`${name}：合法属性通过`, () => {
      expect(() => assertAttributes(name, LEGAL[name])).not.toThrow()
    })

    it(`${name}：非白名单键被拒`, () => {
      expect(() => assertAttributes(name, { notAllowed: 'x' })).toThrowError(/不允许属性 notAllowed/)
    })
  }

  it('跨名字的属性不被误放行（tool 名不能写进 turn）', () => {
    expect(() => assertAttributes('turn', { tool: 'account_list' })).toThrowError(/不允许属性 tool/)
  })
})

describe('span · 属性值约束（PII 防线）', () => {
  it('字符串超过 64 字符被拒（这是"疑似原文"的信号）', () => {
    expect(() =>
      assertAttributes('tool.execute', { tool: 'x'.repeat(MAX_ATTRIBUTE_STRING + 1) }),
    ).toThrowError(/疑似原文/)
    expect(() => assertAttributes('tool.execute', { tool: 'x'.repeat(MAX_ATTRIBUTE_STRING) })).not.toThrow()
  })

  it('嵌套对象 / 数组 / null 被拒（Chrome Trace 的 args 也只放扁平值）', () => {
    expect(() => assertAttributes('turn', { turn: { a: 1 } as unknown as number })).toThrowError(/标量/)
    expect(() => assertAttributes('turn', { turn: [1] as unknown as number })).toThrowError(/标量/)
    expect(() => assertAttributes('turn', { end: null as unknown as string })).toThrowError(/标量/)
  })

  it('NaN / Infinity 被拒', () => {
    expect(() => assertAttributes('turn', { steps: Number.NaN })).toThrowError(/有限数/)
    expect(() => assertAttributes('turn', { steps: Number.POSITIVE_INFINITY })).toThrowError(/有限数/)
  })

  it('结构标记对任何名字都放行（库自己写的，不可能是原文）', () => {
    for (const key of STRUCTURAL_ATTRIBUTE_KEYS) {
      const value = key === 'inboundTraceId' ? 'a'.repeat(32) : key === 'durationSource' ? 'wall' : true
      expect(() => assertAttributes('step', { [key]: value })).not.toThrow()
    }
  })

  it('undefined 属性对象合法（包裹点可以不传）', () => {
    expect(() => assertAttributes('step', undefined)).not.toThrow()
  })
})

describe('span · 反查表', () => {
  it('spanNamesAllowing 能反查业务键', () => {
    expect(spanNamesAllowing('tool')).toContain('tool.execute')
    expect(spanNamesAllowing('tool')).toContain('approval.wait')
    expect(spanNamesAllowing('不存在的键')).toEqual([])
  })
})

describe('span · 时长与未闭合', () => {
  it('闭合时返回差值', () => {
    expect(durationMsOf(span())).toBe(10)
    expect(isOpen(span())).toBe(false)
  })

  it('未闭合返回 null（不是 0）', () => {
    const open = span({ endMs: null, status: 'unset' })
    expect(durationMsOf(open)).toBeNull()
    expect(isOpen(open)).toBe(true)
  })

  it('endMs === startMs 是 0（有样本且为 0），与 null 区分', () => {
    expect(durationMsOf(span({ endMs: 1000 }))).toBe(0)
  })
})
