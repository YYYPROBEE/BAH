/**
 * `http.request` 包裹点（可观测性 01 / S1.8）。
 *
 * 这些用例守三件容易"看起来对、实际静默错"的事：
 *
 * 1. **闸的六个提前 return 都要有 span**：收尾挂在 `res.once('close')` 而不是 `try/finally`，
 *    所以这里用一个只发 `close` 的桩，证明"没有经过正常 end 也能闭合"。
 * 2. **route 取模板而不是原始 URL**：票据号进 span 等于把凭证写进日志。
 * 3. **入站 traceparent 只写 `inboundTraceId`**：它不能覆盖派生 trace-id，
 *    否则同一份 `session.jsonl` 在不同请求头下会算出不同的图。
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { createRecorder, type TelemetrySpan } from '@bah/telemetry'
import { describe, expect, it } from 'vitest'

import type { TelemetryHandle } from '../telemetry.ts'
import { startHttpSpan } from './trace.ts'

const T = 1_700_000_000_000

/** 只给 `recorder` 的句柄（`startHttpSpan` 不碰其它字段）。 */
function fakeTelemetry(): { handle: TelemetryHandle; snapshot: () => readonly TelemetrySpan[] } {
  const recorder = createRecorder({ sessionId: 's-http', now: () => T })
  return {
    handle: { recorder } as unknown as TelemetryHandle,
    snapshot: () => recorder.snapshot(),
  }
}

function makeReq(headers: Record<string, string | string[] | undefined> = {}): IncomingMessage {
  return { method: 'GET', headers } as unknown as IncomingMessage
}

/** 最小响应桩：`once` 来自 EventEmitter，`emitClose` 用来模拟"任何出口都会 close"。 */
function makeRes(status = 200, contentLength?: number): { res: ServerResponse; close: () => void } {
  const emitter = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    getHeader: (name: string) => unknown
  }
  emitter.statusCode = status
  emitter.writableEnded = false
  emitter.getHeader = (name: string) => (name === 'content-length' ? contentLength : undefined)
  return {
    res: emitter as unknown as ServerResponse,
    close: () => emitter.emit('close'),
  }
}

describe('web · http.request span', () => {
  it('开 span 抛错：返回 false，绝不让请求 500', () => {
    const handle = {
      recorder: {
        open(): never {
          throw new Error('recorder broken')
        },
      },
    } as unknown as TelemetryHandle
    const { res } = makeRes()
    expect(startHttpSpan(handle, makeReq(), res, '/api/health')).toBe(false)
  })

  it('没有遥测：返回 false，不碰 req/res', () => {
    const { res } = makeRes()
    expect(startHttpSpan(undefined, makeReq(), res, '/api/health')).toBe(false)
  })

  it('正常响应：route 取模板，status/bytes/requestSeq 都有', () => {
    const { handle, snapshot } = fakeTelemetry()
    const { res, close } = makeRes(200, 128)
    expect(startHttpSpan(handle, makeReq(), res, '/api/sessions/:id')).toBe(true)
    close()

    const [span] = snapshot()
    expect(span!.name).toBe('http.request')
    expect(span!.status).toBe('ok')
    expect(span!.source).toBe('recorded')
    expect(span!.attributes).toMatchObject({
      method: 'GET',
      route: '/api/sessions/:id',
      status: 200,
      bytes: 128,
    })
    expect(typeof span!.attributes['requestSeq']).toBe('number')
  })

  it('content-length=0 记 bytes 0（不是"没有样本"）', () => {
    const { handle, snapshot } = fakeTelemetry()
    const { res, close } = makeRes(204, 0)
    startHttpSpan(handle, makeReq(), res, '/api/health')
    close()
    expect(snapshot()[0]!.attributes['bytes']).toBe(0)
  })

  it('5xx 记 error + http-5xx；4xx 仍是 ok（调用方的问题）', () => {
    const { handle, snapshot } = fakeTelemetry()
    const five = makeRes(503)
    startHttpSpan(handle, makeReq(), five.res, '/api/turn')
    five.close()

    const four = makeRes(401)
    startHttpSpan(handle, makeReq(), four.res, '/api/metrics')
    four.close()

    // 同一注入钟下 startMs 全相等，`snapshot()` 按 spanId 排序——只能按 route 找。
    const spans = snapshot()
    const fiveSpan = spans.find((span) => span.attributes['route'] === '/api/turn')!
    const fourSpan = spans.find((span) => span.attributes['route'] === '/api/metrics')!
    expect(fiveSpan.status).toBe('error')
    expect(fiveSpan.code).toBe('http-5xx')
    expect(fourSpan.status).toBe('ok')
  })

  it('入站 traceparent 只写 inboundTraceId，不改派生 traceId', () => {
    const { handle, snapshot } = fakeTelemetry()
    const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const { res, close } = makeRes()
    startHttpSpan(handle, makeReq({ traceparent: inbound }), res, '/api/health')
    close()

    const [span] = snapshot()
    expect(span!.attributes['inboundTraceId']).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    // 派生 trace-id 由 sessionId 决定：它**不是**入站值。
    expect(span!.traceId).not.toBe('4bf92f3577b34da6a3ce929d0e0e4736')
  })

  it('非法 traceparent 不写属性、不抛', () => {
    const { handle, snapshot } = fakeTelemetry()
    const { res, close } = makeRes()
    startHttpSpan(handle, makeReq({ traceparent: 'not-a-traceparent' }), res, '/api/health')
    close()
    expect(snapshot()[0]!.attributes['inboundTraceId']).toBeUndefined()
  })

  it('响应已结束时立即收尾（不再等 close）', () => {
    const { handle, snapshot } = fakeTelemetry()
    const { res } = makeRes()
    ;(res as unknown as { writableEnded: boolean }).writableEnded = true
    expect(startHttpSpan(handle, makeReq(), res, '/api/health')).toBe(true)
    expect(snapshot()[0]!.endMs).not.toBeNull()
  })
})
