import { describe, expect, it } from 'vitest'

import { deriveSpans, orderSpans, type DeriveEvent } from './derive.ts'
import { durationMsOf, isOpen, SPAN_NAMES, type TelemetrySpan } from './span.ts'

/** 基准时刻（**真钟**场景：事件 `at` 各不相同）。 */
const T = 1_700_000_000_000

/** 造事件：`at` 用相对偏移，省得每行都写 13 位数字。 */
function ev(seq: number, offsetMs: number, type: string, data: unknown): DeriveEvent {
  return { seq, at: T + offsetMs, type, data }
}

const OPTS = { sessionId: 's-test' }

/** 正常一轮：含一次工具调用。 */
function normalTurn(): DeriveEvent[] {
  return [
    ev(1, 0, 'turn/start', { turn: 1 }),
    ev(2, 10, 'step/start', { turn: 1, step: 1 }),
    ev(3, 20, 'request/header', { turn: 1, step: 1, model: 'mock:model-a' }),
    ev(4, 30, 'tool/call', { callId: 'c1', name: 'transfer_create', tier: { level: 'red' } }),
    ev(5, 40, 'tool/result', { callId: 'c1', isError: false, durationMs: 8 }),
    ev(6, 50, 'assistant/message', { content: [] }),
    ev(7, 60, 'step/end', { turn: 1, step: 1 }),
    ev(8, 70, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

const names = (spans: readonly TelemetrySpan[]): string[] => spans.map((s) => s.name)
const byName = (spans: readonly TelemetrySpan[], name: string): TelemetrySpan | undefined =>
  spans.find((s) => s.name === name)

describe('derive · 场景 1（正常一轮）', () => {
  const spans = deriveSpans(normalTurn(), OPTS)

  it('产出 4 条 span（turn / step / llm.call / tool.execute）', () => {
    expect(names(spans)).toEqual(['turn', 'step', 'llm.call', 'tool.execute'])
  })

  it('父子关系正确：step → turn，llm/tool → step', () => {
    const turn = byName(spans, 'turn')!
    const step = byName(spans, 'step')!
    expect(turn.parentSpanId).toBeNull()
    expect(step.parentSpanId).toBe(turn.spanId)
    expect(byName(spans, 'llm.call')!.parentSpanId).toBe(step.spanId)
    expect(byName(spans, 'tool.execute')!.parentSpanId).toBe(step.spanId)
  })

  it('turn 收尾是 ok，带结束原因与 step 计数', () => {
    const turn = byName(spans, 'turn')!
    expect(turn.status).toBe('ok')
    expect(turn.attributes).toMatchObject({ turn: 1, end: 'completed', steps: 1 })
    expect(durationMsOf(turn)).toBe(70)
  })

  it('llm.call 在第一个 tool/call 处闭合（不把工具耗时算进模型耗时）', () => {
    const llm = byName(spans, 'llm.call')!
    expect(llm.startMs).toBe(T + 20)
    expect(llm.endMs).toBe(T + 30)
    expect(llm.attributes).toMatchObject({ model: 'mock:model-a', attempt: 1 })
  })

  it('tool.execute 用 tool/result.durationMs 作权威时长', () => {
    const tool = byName(spans, 'tool.execute')!
    expect(tool.attributes['durationSource']).toBe('tool')
    expect(tool.startMs).toBe(T + 32)
    expect(tool.endMs).toBe(T + 40)
    expect(durationMsOf(tool)).toBe(8)
    expect(tool.attributes['isError']).toBe(false)
    expect(tool.attributes['tier']).toBe('red')
  })
})

describe('derive · 场景 2（审批夹在中间）', () => {
  const spans = deriveSpans(
    [
      ev(1, 0, 'turn/start', { turn: 1 }),
      ev(2, 10, 'step/start', { turn: 1, step: 1 }),
      ev(3, 20, 'request/header', { turn: 1, step: 1, model: 'm' }),
      ev(4, 30, 'tool/call', { callId: 'c1', name: 'transfer_create', tier: { level: 'red' } }),
      ev(5, 31, 'approval/asked', { ticketId: 't-1', callId: 'c1', name: 'transfer_create', challenge: 'face' }),
      ev(6, 51, 'approval/decided', { ticketId: 't-1', decision: 'allowed-once' }),
      ev(7, 55, 'tool/result', { callId: 'c1', isError: false, durationMs: 2 }),
      ev(8, 56, 'assistant/message', { content: [] }),
      ev(9, 60, 'step/end', { turn: 1, step: 1 }),
      ev(10, 70, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ],
    OPTS,
  )

  it('approval.wait 与 tool.execute 不相交（人等的 ≠ 机器干的）', () => {
    const wait = byName(spans, 'approval.wait')!
    const tool = byName(spans, 'tool.execute')!
    expect(wait.endMs).toBe(T + 51)
    expect(tool.startMs).toBe(T + 53)
    expect(tool.startMs).toBeGreaterThan(wait.endMs as number)
  })

  it('tool.execute 时长等于 result.durationMs（不含审批等待）', () => {
    expect(durationMsOf(byName(spans, 'tool.execute')!)).toBe(2)
  })

  it('approval.wait 挂在同 callId 的 tool.execute 下', () => {
    const wait = byName(spans, 'approval.wait')!
    expect(wait.parentSpanId).toBe(byName(spans, 'tool.execute')!.spanId)
    expect(wait.attributes).toMatchObject({ tool: 'transfer_create', decision: 'allowed-once', challenge: 'face' })
    expect(wait.status).toBe('ok')
  })
})

describe('derive · 场景 3（未闭合）', () => {
  it('只有 turn/start 时留一条开的 span，不丢弃', () => {
    const spans = deriveSpans([ev(1, 0, 'turn/start', { turn: 1 })], OPTS)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.endMs).toBeNull()
    expect(spans[0]!.status).toBe('unset')
    expect(spans[0]!.attributes['open']).toBe(true)
    expect(isOpen(spans[0]!)).toBe(true)
    expect(durationMsOf(spans[0]!)).toBeNull()
  })
})

describe('derive · 场景 4（assistant/attempt）', () => {
  const spans = deriveSpans(
    [
      ev(1, 0, 'turn/start', { turn: 1 }),
      ev(2, 10, 'step/start', { turn: 1, step: 1 }),
      ev(3, 20, 'request/header', { turn: 1, step: 1, model: 'm' }),
      ev(4, 30, 'assistant/attempt', { status: 'failed', reason: 'boom' }),
      ev(5, 40, 'step/end', { turn: 1, step: 1 }),
      ev(6, 50, 'turn/end', { turn: 1, reason: { kind: 'failed', reason: 'boom' } }),
    ],
    OPTS,
  )

  it('llm.call 记为 error，code 取 attempt.status', () => {
    const llm = byName(spans, 'llm.call')!
    expect(llm.status).toBe('error')
    expect(llm.code).toBe('failed')
  })

  it('turn 的失败原因进 code，不是塞进 attributes', () => {
    const turn = byName(spans, 'turn')!
    expect(turn.status).toBe('error')
    expect(turn.code).toBe('failed')
    expect(turn.attributes['end']).toBe('failed')
  })

  it('重试会有独立的 llm.call（id 不撞号）', () => {
    const retried = deriveSpans(
      [
        ev(1, 0, 'turn/start', { turn: 1 }),
        ev(2, 10, 'step/start', { turn: 1, step: 1 }),
        ev(3, 20, 'request/header', { turn: 1, step: 1, model: 'm' }),
        ev(4, 25, 'assistant/attempt', { status: 'retried' }),
        ev(5, 30, 'request/header', { turn: 1, step: 1, model: 'm' }),
        ev(6, 35, 'assistant/message', { content: [] }),
        ev(7, 40, 'step/end', { turn: 1, step: 1 }),
      ],
      OPTS,
    )
    const llms = retried.filter((s) => s.name === 'llm.call')
    expect(llms).toHaveLength(2)
    expect(new Set(llms.map((s) => s.spanId)).size).toBe(2)
    expect(llms.map((s) => s.attributes['attempt'])).toEqual([1, 2])
    expect(llms[0]!.code).toBe('retried')
  })
})

describe('derive · 场景 5（时钟不可信）', () => {
  const spans = deriveSpans(normalTurn(), { sessionId: 's-test', clockTrusted: false })

  it('每条派生 span 都标 clock=frozen', () => {
    for (const span of spans) expect(span.attributes['clock']).toBe('frozen')
  })

  it('靠 at 相减的时长塌成 0（turn / step / llm.call）', () => {
    for (const name of ['turn', 'step', 'llm.call']) {
      expect(durationMsOf(byName(spans, name)!)).toBe(0)
    }
  })

  it('事件自带的 durationMs 保持真值（不被抹平成 0）', () => {
    // 这是 01 §2.1 与 §4.4 不变量 7 的冲突取舍：快照里"工具有耗时、轮次没耗时"是事实，
    // 全部塌成 0 会把这个事实抹掉。
    expect(durationMsOf(byName(spans, 'tool.execute')!)).toBe(8)
  })

  it('isOpen 语义不变（未闭合仍是 null，不是 0）', () => {
    const open = deriveSpans([ev(1, 0, 'turn/start', { turn: 1 })], {
      sessionId: 's-test',
      clockTrusted: false,
    })
    expect(open[0]!.endMs).toBeNull()
    expect(isOpen(open[0]!)).toBe(true)
  })
})

describe('derive · 场景 6（重复 callId）', () => {
  const spans = deriveSpans(
    [
      ev(1, 0, 'tool/call', { callId: 'dup', name: 'account_list', tier: { level: 'green' } }),
      ev(2, 10, 'tool/result', { callId: 'dup', isError: true, code: 'x', durationMs: 1 }),
      ev(3, 20, 'tool/call', { callId: 'dup', name: 'account_list', tier: { level: 'green' } }),
      ev(4, 30, 'tool/result', { callId: 'dup', isError: false, durationMs: 2 }),
    ],
    OPTS,
  )

  it('只保留最后一条，并标注 duplicateCallId', () => {
    const tools = spans.filter((s) => s.name === 'tool.execute')
    expect(tools).toHaveLength(1)
    expect(tools[0]!.attributes['duplicateCallId']).toBe(true)
    expect(tools[0]!.status).toBe('ok')
    expect(durationMsOf(tools[0]!)).toBe(2)
  })
})

describe('derive · 场景 7（空/畸形输入）', () => {
  it('空数组返回 []，不抛', () => {
    expect(deriveSpans([], OPTS)).toEqual([])
  })

  it('载荷缺字段的事件被跳过，不抛（历史日志可能跨版本）', () => {
    expect(
      deriveSpans([ev(1, 0, 'turn/start', null), ev(2, 1, 'tool/call', {}), ev(3, 2, '未知事件', {})], OPTS),
    ).toEqual([])
  })
})

describe('derive · 场景 8（plan 嵌套）', () => {
  const spans = deriveSpans(
    [
      ev(1, 0, 'turn/start', { turn: 1 }),
      ev(2, 5, 'plan/created', { planId: 'p1', nodes: 2, dryRun: false }),
      ev(3, 10, 'plan/node-started', { planId: 'p1', nodeId: 'a', tool: 'transfer_create', ordinal: 1 }),
      ev(4, 20, 'plan/node-result', { planId: 'p1', nodeId: 'a', status: 'succeeded', durationMs: 5 }),
      ev(5, 30, 'plan/completed', { planId: 'p1', status: 'succeeded', durationMs: 10 }),
      ev(6, 40, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ],
    OPTS,
  )

  it('plan.node → plan.run → turn', () => {
    const run = byName(spans, 'plan.run')!
    const node = byName(spans, 'plan.node')!
    expect(run.parentSpanId).toBe(byName(spans, 'turn')!.spanId)
    expect(node.parentSpanId).toBe(run.spanId)
  })

  it('plan.run 用 plan/completed.durationMs 作时长', () => {
    const run = byName(spans, 'plan.run')!
    expect(run.attributes).toMatchObject({ planId: 'p1', nodes: 2, dryRun: false, durationSource: 'event' })
    expect(durationMsOf(run)).toBe(10)
    expect(run.status).toBe('ok')
  })

  it('plan/node 用 node-result.durationMs 作时长', () => {
    expect(durationMsOf(byName(spans, 'plan.node')!)).toBe(5)
    expect(byName(spans, 'plan.node')!.attributes).toMatchObject({ tool: 'transfer_create', ordinal: 1 })
  })

  it('plan/node-blocked 合成一条 blocked span（否则"为什么没跑完"图里看不见）', () => {
    const blocked = deriveSpans(
      [
        ev(1, 0, 'plan/created', { planId: 'p2', nodes: 2, dryRun: false }),
        ev(2, 10, 'plan/node-blocked', { planId: 'p2', nodeId: 'b', blockedBy: ['a'], reason: 'upstream-failed' }),
        ev(3, 20, 'plan/completed', { planId: 'p2', status: 'failed', durationMs: 20 }),
      ],
      OPTS,
    )
    const node = byName(blocked, 'plan.node')!
    expect(node.status).toBe('error')
    expect(node.code).toBe('upstream-blocked')
    expect(node.attributes['status']).toBe('blocked')
  })

  it('plan 事件不带 turn 时挂到最近那个 turn（跨 turn 的计划）', () => {
    const across = deriveSpans(
      [
        ev(1, 0, 'turn/start', { turn: 1 }),
        ev(2, 5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
        ev(3, 10, 'plan/created', { planId: 'p3', nodes: 1, dryRun: true }),
        ev(4, 20, 'plan/completed', { planId: 'p3', status: 'succeeded', durationMs: 10 }),
      ],
      OPTS,
    )
    expect(byName(across, 'plan.run')!.parentSpanId).toBe(byName(across, 'turn')!.spanId)
  })
})

describe('derive · 不变量（顺序 / 确定性 / 闭集）', () => {
  it('全序：startMs 相同则按 spanId 排序（不依赖插入顺序）', () => {
    // 两个互不相干的工具调用占据完全相同的时间窗，只是入队先后不同。
    // 快照场景（`fixedClock` 幂等）就是这个形状：只按 startMs 排会退化成插入序。
    const pair = (first: string, second: string): DeriveEvent[] => [
      ev(1, 0, 'tool/call', { callId: first, name: 'account_list', tier: { level: 'green' } }),
      ev(2, 10, 'tool/result', { callId: first, isError: false, durationMs: 1 }),
      ev(3, 0, 'tool/call', { callId: second, name: 'account_list', tier: { level: 'green' } }),
      ev(4, 10, 'tool/result', { callId: second, isError: false, durationMs: 1 }),
    ]
    const a = deriveSpans(pair('cA', 'cB'), OPTS)
    const b = deriveSpans(pair('cB', 'cA'), OPTS)
    expect(a.map((s) => s.spanId)).toEqual(b.map((s) => s.spanId))
    for (let index = 1; index < a.length; index += 1) {
      const prev = a[index - 1]!
      const next = a[index]!
      expect(
        prev.startMs < next.startMs || (prev.startMs === next.startMs && prev.spanId < next.spanId),
      ).toBe(true)
    }
  })

  it('确定性：同一输入两次调用逐字节相等', () => {
    expect(JSON.stringify(deriveSpans(normalTurn(), OPTS))).toBe(JSON.stringify(deriveSpans(normalTurn(), OPTS)))
  })

  it('只产出闭集里的名字', () => {
    const all = deriveSpans(normalTurn(), OPTS)
    for (const span of all) expect(SPAN_NAMES).toContain(span.name)
  })

  it('source 一律是 derived', () => {
    for (const span of deriveSpans(normalTurn(), OPTS)) expect(span.source).toBe('derived')
  })

  it('orderSpans 不改入参', () => {
    const spans = deriveSpans(normalTurn(), OPTS)
    const before = [...spans]
    orderSpans([...spans].reverse())
    expect(spans).toEqual(before)
  })
})
