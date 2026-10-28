import { describe, expect, it } from 'vitest'

import { buildForest, criticalPath } from './tree.ts'
import type { SpanName, TelemetrySpan } from './span.ts'

let counter = 0

function span(partial: {
  name: SpanName
  parentSpanId?: string | null
  spanId?: string
  startMs?: number
  endMs?: number | null
}): TelemetrySpan {
  counter += 1
  return {
    traceId: 'a'.repeat(32),
    spanId: partial.spanId ?? String(counter).padStart(16, '0'),
    parentSpanId: partial.parentSpanId ?? null,
    name: partial.name,
    startMs: partial.startMs ?? 0,
    endMs: partial.endMs === undefined ? 100 : partial.endMs,
    status: partial.endMs === null ? 'unset' : 'ok',
    attributes: {},
    source: 'derived',
  }
}

describe('tree · 森林', () => {
  it('两个互不相干的根（http.request 与 turn 不是父子）', () => {
    const http = span({ name: 'http.request', spanId: 'h'.repeat(16), startMs: 0, endMs: 5 })
    const turn = span({ name: 'turn', spanId: 't'.repeat(16), startMs: 10, endMs: 90 })
    const forest = buildForest([http, turn])
    expect(forest).toHaveLength(2)
    expect(forest.map((n) => n.span.name)).toEqual(['http.request', 'turn'])
  })

  it('深度与子节点顺序按 (startMs, spanId)', () => {
    const root = span({ name: 'turn', spanId: '0'.repeat(15) + '1', startMs: 0, endMs: 100 })
    const b = span({ name: 'step', parentSpanId: root.spanId, spanId: 'b'.repeat(16), startMs: 20, endMs: 30 })
    const a = span({ name: 'step', parentSpanId: root.spanId, spanId: 'a'.repeat(16), startMs: 20, endMs: 30 })
    const [node] = buildForest([root, b, a])
    expect(node!.depth).toBe(0)
    expect(node!.children.map((c) => c.span.spanId)).toEqual([a.spanId, b.spanId])
    expect(node!.children[0]!.depth).toBe(1)
  })

  it('父 span 缺失 → 提升为根并标 orphan（不抛）', () => {
    const orphan = span({ name: 'tool.execute', parentSpanId: 'f'.repeat(16) })
    const forest = buildForest([orphan])
    expect(forest).toHaveLength(1)
    expect(forest[0]!.span.attributes['orphan']).toBe(true)
  })

  it('父 span 为 null 的根**不**标 orphan（那是正常的根）', () => {
    const forest = buildForest([span({ name: 'turn' })])
    expect(forest[0]!.span.attributes['orphan']).toBeUndefined()
  })

  it('子先出现父后出现也能连上（两遍建树）', () => {
    const child = span({ name: 'step', parentSpanId: 'p'.repeat(16), startMs: 10, endMs: 20 })
    const parent = span({ name: 'turn', spanId: 'p'.repeat(16), startMs: 0, endMs: 100 })
    const forest = buildForest([child, parent])
    expect(forest).toHaveLength(1)
    expect(forest[0]!.children).toHaveLength(1)
  })
})

describe('tree · selfMs', () => {
  it('父时长减子时长（按时间窗相交部分）', () => {
    const root = span({ name: 'turn', spanId: '1'.repeat(16), startMs: 0, endMs: 100 })
    const child = span({ name: 'step', parentSpanId: root.spanId, startMs: 20, endMs: 60 })
    const [node] = buildForest([root, child])
    expect(node!.selfMs).toBe(60)
    expect(node!.children[0]!.selfMs).toBe(40)
  })

  it('子区间超出父时只算相交部分（不出现负值）', () => {
    const root = span({ name: 'turn', spanId: '1'.repeat(16), startMs: 50, endMs: 60 })
    const child = span({ name: 'step', parentSpanId: root.spanId, startMs: 0, endMs: 100 })
    const [node] = buildForest([root, child])
    expect(node!.selfMs).toBe(0)
  })

  it('未闭合的 span selfMs 是 null，不是 0', () => {
    const open = span({ name: 'turn', endMs: null })
    const [node] = buildForest([open])
    expect(node!.selfMs).toBeNull()
  })
})

describe('tree · criticalPath', () => {
  it('取累计时长最大的那条，空输入返回 []', () => {
    expect(criticalPath([])).toEqual([])
    const root = span({ name: 'turn', spanId: '1'.repeat(16), startMs: 0, endMs: 100 })
    const fast = span({ name: 'step', parentSpanId: root.spanId, spanId: '2'.repeat(16), startMs: 0, endMs: 5 })
    const slow = span({ name: 'step', parentSpanId: root.spanId, spanId: '3'.repeat(16), startMs: 10, endMs: 90 })
    const path = criticalPath([root, fast, slow])
    expect(path).toEqual([root.spanId, slow.spanId])
  })

  it('确定性：同一输入两次同一条路径', () => {
    const root = span({ name: 'turn', spanId: '1'.repeat(16), startMs: 0, endMs: 100 })
    const a = span({ name: 'step', parentSpanId: root.spanId, spanId: '2'.repeat(16), startMs: 0, endMs: 50 })
    const b = span({ name: 'step', parentSpanId: root.spanId, spanId: '3'.repeat(16), startMs: 0, endMs: 50 })
    expect(criticalPath([root, a, b])).toEqual(criticalPath([root, b, a]))
  })
})
