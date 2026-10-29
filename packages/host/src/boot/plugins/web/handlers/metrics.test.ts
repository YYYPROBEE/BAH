/**
 * `GET /api/metrics` 的出口协商（可观测性 02 / S2.8）。
 *
 * 四种输入只有三条出路：JSON、Prometheus、400。最容易回归的是**优先级**——
 * `format` 显式时压过 `Accept`，别让 Prometheus 的探测头把前端 JSON 抢走。
 */

import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SloSample } from '@bah/saga'

import type { WebDeps, WebRequest } from '../deps.ts'
import { handleMetrics } from './metrics.ts'

const T = 1_700_000_000_000

/** 只实现 handler 用到的 `writeHead` / `end`。 */
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

function deps(slo?: Record<string, SloSample>): WebDeps {
  return {
    session: {
      sessionId: 'sess-1',
      lastSeq: () => 7,
      events: () => [],
    },
    hub: { size: () => 3 },
    now: () => T,
    // 接管段：本文件不测状态机语义（见 handoff.test.ts），这里只要"没接管"
    handoff: { active: false, slaMs: 0 },
    tryHalt: () => undefined,
    tryTelemetry: () => undefined,
    trySlo: () => slo,
  } as unknown as WebDeps
}

function request(search: string): WebRequest {
  const url = new URL(`http://127.0.0.1/api/metrics${search}`)
  return { method: 'GET', url, path: '/api/metrics', rest: '' }
}

function req(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('handleMetrics · 出口协商', () => {
  it('缺省 JSON：保留旧 10 字段并附 9 个新段', async () => {
    const res = new FakeRes()
    await handleMetrics(req(), res as unknown as ServerResponse, request(''), deps())

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body).toMatchObject({
      sessionId: 'sess-1',
      lastSeq: 7,
      at: T,
      turns: 0,
      halt: null,
      sseClients: 3,
    })
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining([
        'tools',
        'approvals',
        'policy',
        'usage',
        // 9 个新段
        'http',
        'llm',
        'cost',
        'plan',
        'slo',
        'process',
        'telemetry',
        'logs',
        'alerts',
      ]),
    )
    // 没装 saga：slo 显式 null，而不是缺键
    expect(body['slo']).toBeNull()
  })

  it('`?format=prometheus` 返回 text/plain 并可被解析', async () => {
    const res = new FakeRes()
    await handleMetrics(req(), res as unknown as ServerResponse, request('?format=prometheus'), deps())

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain; version=0.0.4')
    expect(res.body.startsWith('# HELP bah_up ')).toBe(true)
    expect(res.body.endsWith('\n')).toBe(true)
  })

  it('`Accept: text/plain`（无 format）也走 Prometheus', async () => {
    const res = new FakeRes()
    await handleMetrics(
      req({ accept: 'text/plain;version=0.0.4' }),
      res as unknown as ServerResponse,
      request(''),
      deps(),
    )

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
  })

  it('显式 `format=json` 压过 `Accept: text/plain`', async () => {
    const res = new FakeRes()
    await handleMetrics(
      req({ accept: 'text/plain' }),
      res as unknown as ServerResponse,
      request('?format=json'),
      deps(),
    )

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('未知 format 返回 400（不静默降级成 JSON）', async () => {
    const res = new FakeRes()
    await handleMetrics(req(), res as unknown as ServerResponse, request('?format=xml'), deps())

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'metrics-format-unsupported', reason: expect.stringContaining('xml') },
    })
  })

  it('SLO 有样本时按 {value,verdict,unit,soft,hard} 出参', async () => {
    const slo: Record<string, SloSample> = {
      dlqDepth: { metric: 'dlqDepth', value: 6, unit: 'count', soft: 1, hard: 5, detail: '' },
    }
    const res = new FakeRes()
    await handleMetrics(req(), res as unknown as ServerResponse, request(''), deps(slo))

    const body = JSON.parse(res.body) as { slo: Record<string, unknown> }
    expect(body.slo['dlqDepth']).toEqual({
      value: 6,
      verdict: 'P0',
      unit: 'count',
      soft: 1,
      hard: 5,
    })
  })
})
