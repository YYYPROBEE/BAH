/**
 * 并行读批次的会话缓冲（BAH 代码修改清单 2026-10-20 · B3.4）。
 *
 * 核心不变量：
 * 1. flush 严格按记录顺序；
 * 2. 单条写入失败不阻断后续写入；
 * 3. 失败也会清空缓冲（不会重试时重复落账）。
 */

import { describe, expect, it } from 'vitest'

import type { SessionSink } from './service.ts'
import { SessionEventBuffer } from './buffer.ts'
import type { ToolResultData } from './types.ts'

const RESULT: ToolResultData = {
  callId: 'c1',
  name: 'probe',
  isError: false,
  content: [{ type: 'text', text: 'ok' }],
  durationMs: 1,
}

/** 最小 sink：只记录 append 序列，按需在指定事件上抛错。 */
function probeSink(calls: string[], failOn?: string): SessionSink {
  return {
    sessionId: 's-buffer',
    formatVersion: 1,
    append: ((type: string) => {
      calls.push(`append:${type}`)
      if (type === failOn) throw new Error(`append ${type} failed`)
      return { seq: calls.length } as never
    }) as SessionSink['append'],
    appendDomain: ((type: string) => {
      calls.push(`domain:${type}`)
      return { seq: calls.length } as never
    }) as SessionSink['appendDomain'],
  } as SessionSink
}

describe('SessionEventBuffer', () => {
  it('按记录顺序 flush append 与 result 广播', () => {
    const calls: string[] = []
    const emitted: string[] = []
    const buffer = new SessionEventBuffer()
    buffer.record((sink) => {
      void sink.append('tool/call', {} as never)
    })
    buffer.record((sink) => {
      void sink.append('tool/result', {} as never)
    })
    buffer.emitResult(RESULT)

    buffer.flush(probeSink(calls), (result) => {
      emitted.push(result.callId)
    })

    expect(calls).toEqual(['append:tool/call', 'append:tool/result'])
    expect(emitted).toEqual(['c1'])
  })

  it('单条写入失败不阻断后续 append / 广播；失败后缓冲清空', () => {
    const calls: string[] = []
    const emitted: string[] = []
    const buffer = new SessionEventBuffer()
    buffer.record((sink) => {
      void sink.append('tool/call', {} as never)
    })
    buffer.record((sink) => {
      void sink.append('tool/result', {} as never)
    })
    buffer.emitResult(RESULT)

    const sink = probeSink(calls, 'tool/call')
    expect(() =>
      buffer.flush(sink, (result) => {
        emitted.push(result.callId)
      }),
    ).toThrow(AggregateError)

    expect(calls).toEqual(['append:tool/call', 'append:tool/result'])
    expect(emitted).toEqual(['c1'])

    // 已清空：再次 flush 不会重复写
    calls.length = 0
    emitted.length = 0
    buffer.flush(sink, (result) => {
      emitted.push(result.callId)
    })
    expect(calls).toEqual([])
    expect(emitted).toEqual([])
  })
})
