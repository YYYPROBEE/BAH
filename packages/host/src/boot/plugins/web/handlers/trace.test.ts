/**
 * `GET /api/trace` 的出口与边界（可观测性 02 / S2.8）。
 *
 * 四个决定成败的分支：没装遥测 → 503；未知格式 → 400；非法 limit → 400；
 * 序列化超 4 MiB → 503（**不截断半棵树**）。
 */

import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TelemetrySpan } from '@bah/telemetry'

import type { TelemetryHandle } from '../../telemetry.ts'
import type { WebDeps, WebRequest } from '../deps.ts'
import { handleTrace } from './trace.ts'

const T = 1_700_000_000_000

class FakeRes extends EventEmitter {
  statusCode = 0
  headers: Record<string, string> = {}
  body = ''

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status
    this.headers = headers
    return this
  }

  end(chunk?: string): void {
    this.body = chunk ?? ''
  }
}

function span(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: 't'.repeat(32),
    spanId: 's'.repeat(16),
    parentSpanId: null,
    name: 'http.request',
    startMs: T,
    endMs: T + 10,
    status: 'ok',
    attributes: { route: '/api/metrics', method: 'GET', status: 200 },
    source: 'recorded',
    ...overrides,
  }
}

function handle(spans: readonly TelemetrySpan[], clockTrusted = true, dropped = 0): TelemetryHandle {
  return {
    derive: () => ({ spans, roots: [], clockTrusted }) as never,
    stats: { dropped },
  } as unknown as TelemetryHandle
}

function deps(telemetry: TelemetryHandle | undefined): WebDeps {
  return {
    session: { sessionId: 'sess-t', lastSeq: () => 1, events: () => [] },
    tryTelemetry: () => telemetry,
  } as unknown as WebDeps
}

function request(search: string): WebRequest {
  const url = new URL(`http://127.0.0.1/api/trace${search}`)
  return { method: 'GET', url, path: '/api/trace', rest: '' }
}

const req = { headers: {} } as unknown as IncomingMessage

describe('handleTrace · 不可用与参数', () => {
  it('未装配遥测返回 503，而不是空森林', async () => {
    const res = new FakeRes()
    await handleTrace(req, res as unknown as ServerResponse, request(''), deps(undefined))

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'trace-unavailable', reason: expect.any(String) },
    })
  })

  it('未知 format 返回 400', async () => {
    const res = new FakeRes()
    await handleTrace(req, res as unknown as ServerResponse, request('?format=xml'), deps(handle([span()])))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)['error'].code).toBe('trace-format-unsupported')
  })

  it.each(['limit=0', 'limit=-1', 'limit=1.5', 'limit=abc'])('%s → 400', async (search) => {
    const res = new FakeRes()
    await handleTrace(req, res as unknown as ServerResponse, request(`?${search}`), deps(handle([span()])))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)['error'].code).toBe('trace-limit-invalid')
  })
})

describe('handleTrace · 正常输出', () => {
  it('默认 JSON 森林：带 traceId / clock / open 统计', async () => {
    const res = new FakeRes()
    const spans = [span(), span({ spanId: 'u'.repeat(16), parentSpanId: 's'.repeat(16), endMs: null, status: 'unset' })]
    await handleTrace(req, res as unknown as ServerResponse, request(''), deps(handle(spans, true, 3)))

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body).toMatchObject({
      sessionId: 'sess-t',
      clock: 'trusted',
      stats: { spans: 2, dropped: 3, depth: 1, open: 1 },
    })
    expect(typeof body['traceId']).toBe('string')
    expect((body['roots'] as unknown[]).length).toBe(1)
  })

  it('时钟不可信时显式标 frozen（不假装时间可信）', async () => {
    const res = new FakeRes()
    await handleTrace(req, res as unknown as ServerResponse, request(''), deps(handle([span()], false)))

    expect(JSON.parse(res.body)['clock']).toBe('frozen')
  })

  it('limit 只保留最近 N 条；stats.spans 与 roots 同口径', async () => {
    const res = new FakeRes()
    const spans = [
      span({ name: 'http.request' }),
      span({ name: 'llm.call', spanId: 'z'.repeat(16), attributes: { model: 'm', ttftMs: 5 } }),
    ]
    await handleTrace(req, res as unknown as ServerResponse, request('?limit=1'), deps(handle(spans)))

    const body = JSON.parse(res.body) as {
      stats: { spans: number }
      roots: { span: { name: string; spanId: string } }[]
    }
    expect(body.stats.spans).toBe(1)
    expect(body.roots).toHaveLength(1)
    expect(body.roots[0]!.span.spanId).toBe('z'.repeat(16))
    expect(body.roots[0]!.span.name).toBe('llm.call')
  })

  it('format=chrome 输出裸数组（Perfetto 可直接打开）', async () => {
    const res = new FakeRes()
    await handleTrace(
      req,
      res as unknown as ServerResponse,
      request('?format=chrome'),
      deps(handle([span(), span({ spanId: 'v'.repeat(16), name: 'llm.call', attributes: { model: 'm', ttftMs: 5 } })])),
    )

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { name: string; ph: string }[]
    // 2 条 `ph:"M"` 元数据 + 2 条 span 事件（没有 thread_name，Perfetto 只显示 "1"）
    expect(body).toHaveLength(4)
    expect(body.filter((event) => event.ph === 'M').map((event) => event.name).sort()).toEqual([
      'process_name',
      'thread_name',
    ])
    expect(body.some((event) => event.name === 'llm.call')).toBe(true)
  })

  it('序列化超过 4 MiB 返回 503，不截断', async () => {
    const res = new FakeRes()
    const huge = span({ attributes: { route: `/${'x'.repeat(4 * 1024 * 1024 + 64)}`, method: 'GET', status: 200 } })
    await handleTrace(req, res as unknown as ServerResponse, request(''), deps(handle([huge])))

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)['error'].code).toBe('trace-too-large')
  })
})
