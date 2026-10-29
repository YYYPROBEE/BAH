import { describe, expect, it } from 'vitest'

import { createRecorder, DEFAULT_SAMPLE } from './recorder.ts'
import { durationMsOf, type TelemetrySpan } from './span.ts'

/** 递增钟：每次取时间 +10ms，避免"所有 span 同 startMs"掩盖问题。 */
function steppingClock(): () => number {
  let value = 1_700_000_000_000
  return () => {
    value += 10
    return value
  }
}

function recorder(
  options: {
    maxSpans?: number
    sample?: Readonly<Record<string, number>>
    sink?: (span: TelemetrySpan) => void
  } = {},
) {
  return createRecorder({ sessionId: 's-rec', now: steppingClock(), ...options })
}

describe('recorder · withSpan', () => {
  it('正常返回：span ok，endMs >= startMs', () => {
    const rec = recorder()
    const value = rec.withSpan('tool.execute', { tool: 'account_list' }, () => 42)
    expect(value).toBe(42)
    const [span] = rec.snapshot()
    expect(span!.status).toBe('ok')
    expect(span!.source).toBe('recorded')
    expect((span!.endMs as number) >= span!.startMs).toBe(true)
    expect(span!.name).toBe('tool.execute')
  })

  it('抛错：span error + code，且**原对象**抛出（不包装）', () => {
    const rec = recorder()
    const boom = Object.assign(new Error('boom'), { code: 'tool-failed' })
    let caught: unknown
    try {
      rec.withSpan('tool.execute', { tool: 'account_list' }, () => {
        throw boom
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(boom)
    const [span] = rec.snapshot()
    expect(span!.status).toBe('error')
    expect(span!.code).toBe('tool-failed')
  })

  it('非 BahError 的抛出物记 unknown-error（不静默丢信息）', () => {
    const rec = recorder()
    expect(() =>
      rec.withSpan('tool.execute', { tool: 'x' }, () => {
        throw 'plain-string'
      }),
    ).toThrow()
    expect(rec.snapshot()[0]!.code).toBe('unknown-error')
  })

  it('非法属性只丢属性，不丢 span、不抛给业务', () => {
    const rec = recorder()
    const value = rec.withSpan('turn', { tool: 'not-allowed' }, () => 'ok')
    expect(value).toBe('ok')
    expect(rec.snapshot()[0]!.attributes).toEqual({})
    expect(rec.stats.attributeErrors).toBe(1)
  })
})

describe('recorder · withSpanAsync', () => {
  it('异步成功：ok', async () => {
    const rec = recorder()
    await expect(rec.withSpanAsync('rag.answer', { kind: 'policy' }, async () => 'v')).resolves.toBe('v')
    expect(rec.snapshot()[0]!.status).toBe('ok')
  })

  it('异步失败：error + code，异常原样抛出，end 只生效一次', async () => {
    const rec = recorder()
    const boom = Object.assign(new Error('nope'), { code: 'rag-unavailable' })
    await expect(
      rec.withSpanAsync('rag.answer', { kind: 'policy' }, async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    const [span] = rec.snapshot()
    expect(span!.status).toBe('error')
    expect(span!.code).toBe('rag-unavailable')
  })
})

describe('recorder · open（长生命周期）', () => {
  it('开着的 span 出现在快照里，end 之后闭合', () => {
    const rec = recorder()
    const handle = rec.open('sse.attach', { clients: 1 })
    expect(rec.snapshot()[0]!.endMs).toBeNull()
    handle.end('ok')
    expect(rec.snapshot()[0]!.status).toBe('ok')
    expect(durationMsOf(rec.snapshot()[0]!)).toBe(10)
  })

  it('重复 end 不覆盖首次结论', () => {
    const rec = recorder()
    const handle = rec.open('sse.attach')
    handle.end('ok')
    handle.end('error', 'late')
    expect(rec.snapshot()[0]!.status).toBe('ok')
    expect(rec.snapshot()[0]!.code).toBeUndefined()
  })
})

describe('recorder · 容量与淘汰（确定性，不用随机/时间戳）', () => {
  it('容量 2 + 3 条 ok：留最后 2 条，dropped = 1', () => {
    const rec = recorder({ maxSpans: 2 })
    for (let index = 0; index < 3; index += 1) {
      rec.withSpan('step', { turn: 1, step: index }, () => undefined)
    }
    expect(rec.snapshot()).toHaveLength(2)
    expect(rec.stats.dropped).toBe(1)
    expect(rec.stats.droppedErrors).toBe(0)
  })

  it('容量 2 + 1 条 error + 2 条 ok：error 不被淘汰', () => {
    const rec = recorder({ maxSpans: 2 })
    expect(() =>
      rec.withSpan('tool.execute', { tool: 'a' }, () => {
        throw new Error('x')
      }),
    ).toThrow()
    rec.withSpan('step', { turn: 1, step: 1 }, () => undefined)
    rec.withSpan('step', { turn: 1, step: 2 }, () => undefined)
    const spans = rec.snapshot()
    expect(spans).toHaveLength(2)
    expect(spans.some((s) => s.status === 'error')).toBe(true)
    expect(rec.stats.droppedErrors).toBe(0)
  })

  it('全剩 error 仍溢出：丢最旧的 error 并记 droppedErrors', () => {
    const rec = recorder({ maxSpans: 1 })
    for (let index = 0; index < 2; index += 1) {
      expect(() =>
        rec.withSpan('tool.execute', { tool: 'a' }, () => {
          throw new Error('x')
        }),
      ).toThrow()
    }
    expect(rec.snapshot()).toHaveLength(1)
    expect(rec.stats.dropped).toBe(1)
    expect(rec.stats.droppedErrors).toBe(1)
  })

  it('全剩未闭合也要能淘汰（否则长时间 SSE 会无界增长）', () => {
    const rec = recorder({ maxSpans: 2 })
    for (let index = 0; index < 3; index += 1) rec.open('sse.attach', { clients: index })
    expect(rec.snapshot()).toHaveLength(2)
    expect(rec.stats.dropped).toBe(1)
  })
})

describe('recorder · 采样（确定性）', () => {
  it('policy.evaluate 默认 0.1：1000 次落在 60~140', () => {
    expect(DEFAULT_SAMPLE['policy.evaluate']).toBe(0.1)
    const rec = recorder({ maxSpans: 5000 })
    for (let index = 0; index < 1000; index += 1) {
      rec.withSpan('policy.evaluate', { verdict: 'allow' }, () => undefined)
    }
    const kept = rec.snapshot().length
    expect(kept).toBeGreaterThanOrEqual(60)
    expect(kept).toBeLessThanOrEqual(140)
    expect(rec.stats.sampledOut).toBe(1000 - kept)
  })

  it('采样率为 1 的名字一条不少', () => {
    const rec = recorder({ maxSpans: 5000 })
    for (let index = 0; index < 50; index += 1) {
      rec.withSpan('http.request', { method: 'GET' }, () => undefined)
    }
    expect(rec.snapshot()).toHaveLength(50)
    expect(rec.stats.sampledOut).toBe(0)
  })

  it('被采样掉时 fn 照常执行，spanId 仍可用（出站 traceparent 不会失效）', () => {
    const rec = recorder({ sample: { 'policy.evaluate': 0 } })
    let seen = ''
    const value = rec.withSpan('policy.evaluate', { verdict: 'allow' }, (spanId) => {
      seen = spanId
      return 'ran'
    })
    expect(value).toBe('ran')
    expect(seen).toMatch(/^[0-9a-f]{16}$/)
    expect(rec.snapshot()).toHaveLength(0)
    expect(rec.stats.sampledOut).toBe(1)
  })
})

describe('recorder · sink 与 absorb', () => {
  it('sink 抛错被吞掉并计数，不冒泡', () => {
    const rec = recorder({
      sink: () => {
        throw new Error('disk-full')
      },
    })
    expect(() => rec.withSpan('step', { turn: 1, step: 1 }, () => undefined)).not.toThrow()
    expect(rec.stats.exportErrors).toBe(1)
  })

  it('absorb 按 spanId 去重，后者覆盖前者', () => {
    const rec = recorder()
    const span: TelemetrySpan = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: null,
      name: 'turn',
      startMs: 10,
      endMs: 20,
      status: 'ok',
      attributes: {},
      source: 'derived',
    }
    rec.absorb([span])
    rec.absorb([{ ...span, endMs: 30 }])
    const spans = rec.snapshot()
    expect(spans).toHaveLength(1)
    expect(spans[0]!.endMs).toBe(30)
  })

  it('snapshot 出去的对象是冻结的：谁也不能把 trace 改回去', () => {
    const rec = recorder()
    rec.withSpan('step', { turn: 1, step: 1 }, () => undefined)
    const first = rec.snapshot()
    expect(Object.isFrozen(first[0]!.attributes)).toBe(true)
    // 快照之间互不影响：上一次拿到的数组与下一次的数组不是同一个对象。
    expect(rec.snapshot()).not.toBe(rec.snapshot())
    expect(rec.snapshot()[0]!.attributes).toEqual({ turn: 1, step: 1 })
  })
})
