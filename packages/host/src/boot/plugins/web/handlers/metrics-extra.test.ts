/**
 * `/api/metrics` 的 9 个新段与 Prometheus 输入（可观测性 02 / S2.8）。
 *
 * 这里守的是**派生口径**，不是 HTTP：同一份事件快照既要喂 JSON 又要喂 Prometheus，
 * 两套口径分叉时最先错的是"没有样本"被当成 0、以及非法数值被静默累加。
 */

import { describe, expect, it } from 'vitest'

import type { SloSample } from '@bah/saga'
import type { ProcessSnapshot, TelemetrySpan } from '@bah/telemetry'

import { resetAlertStats, recordAlertResult } from '../../alert-stats.ts'
import type { TelemetryHandle } from '../../telemetry.ts'
import { jsonExtrasOf, metricInputsOf, type MetricsView } from './metrics-extra.ts'

const T = 1_700_000_000_000

const PROCESS: ProcessSnapshot = {
  startedAtMs: T - 12_000,
  uptimeSec: 12,
  rssBytes: 1024,
  heapUsedBytes: 512,
  eventLoopP99Sec: 0.02,
  nodeVersion: 'v22.17.0',
}

type Event = MetricsView['events'][number]

function event(type: string, data: unknown, at = T): Event {
  return { at, type, data }
}

function span(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    traceId: 't'.repeat(32),
    spanId: 's'.repeat(16),
    parentSpanId: null,
    name: 'http.request',
    startMs: 1_000,
    endMs: 1_100,
    status: 'ok',
    attributes: { route: '/api/metrics', method: 'GET', status: 200 },
    source: 'recorded',
    ...overrides,
  }
}

/** 只造 `jsonExtrasOf` / `metricInputsOf` 真正读到的字段。 */
function fakeHandle(options: {
  spans?: readonly TelemetrySpan[]
  roots?: readonly { readonly depth: number; readonly children: readonly unknown[] }[]
  size?: number
  dropped?: number
  guard?: { maxTurnCostMicroYuan: number; maxSessionCostMicroYuan: number; maxTurnOutputTokens: number }
  exhausted?: { turn: number; session: number }
  turnCost?: number
  costConfigured?: boolean
} = {}): TelemetryHandle {
  const spans = options.spans ?? []
  return {
    recorder: { snapshot: () => spans } as never,
    derive: () =>
      ({
        spans,
        roots: options.roots ?? [],
        clockTrusted: true,
      }) as never,
    stats: {
      size: options.size ?? spans.length,
      dropped: options.dropped ?? 0,
      droppedErrors: 0,
      exportErrors: 0,
      attributeErrors: 0,
      sampledOut: 0,
    },
    spanLogPath: null,
    usage: { ofTurn: () => ({ costMicroYuan: options.turnCost ?? 0 }) } as never,
    costConfigured: () => options.costConfigured ?? false,
    guardLimits:
      options.guard ?? { maxTurnCostMicroYuan: 0, maxSessionCostMicroYuan: 0, maxTurnOutputTokens: 0 },
    budgetExhausted: () => options.exhausted ?? { turn: 0, session: 0 },
  } as unknown as TelemetryHandle
}

function view(overrides: Partial<MetricsView> = {}): MetricsView {
  return {
    events: [],
    handle: undefined,
    process: PROCESS,
    logs: {
      byLevel: { debug: 0, info: 0, warn: 0, error: 0 },
      suppressed: 0,
      writeErrors: 0,
    },
    slo: undefined,
    costConfigured: false,
    sseClients: 0,
    sseFrames: { frame: 0, fault: 0 },
    ...overrides,
  }
}

describe('metrics-extra · HTTP 与 LLM', () => {
  it('完成样本计时长分位；未闭合 span 只计入在飞数，不算请求', () => {
    const spans = [
      span(),
      span({
        spanId: 'a'.repeat(16),
        startMs: 1_000,
        endMs: 1_400,
        status: 'error',
        attributes: { route: '/api/turn', method: 'POST', status: 503 },
      }),
      span({
        spanId: 'b'.repeat(16),
        startMs: 1_000,
        endMs: 1_300,
        attributes: { route: '/api/turn', method: 'POST', status: 429 },
      }),
      span({ spanId: 'c'.repeat(16), startMs: 1_000, endMs: null }),
      span({
        spanId: 'd'.repeat(16),
        name: 'llm.call',
        startMs: 1_000,
        endMs: 1_050,
        attributes: { ttftMs: 50, model: 'router-chat' },
      }),
      span({
        spanId: 'e'.repeat(16),
        name: 'llm.call',
        startMs: 1_000,
        endMs: 1_150,
        attributes: { ttftMs: 150, model: 'router-chat' },
      }),
      // 非法 TTFT 不进样本（负数 / 字符串都不算"很快"）
      span({ spanId: 'f'.repeat(16), name: 'llm.call', attributes: { ttftMs: -1 } }),
      span({ spanId: 'g'.repeat(16), name: 'llm.call', attributes: { ttftMs: 'x' } }),
    ]
    const extras = jsonExtrasOf(
      view({
        events: [
          event('request/header', { turn: 1, model: 'router-chat' }),
          event('request/header', { turn: 2, model: 'router-chat' }),
          event('assistant/attempt', { status: 'failed' }),
        ],
        handle: fakeHandle({ spans }),
      }),
    )

    expect(extras['http']).toEqual({
      requests: 3,
      errors: 1,
      rateLimited: 1,
      inFlight: 1,
      durationMs: { p50: 300, p95: 400 },
    })
    expect(extras['llm']).toMatchObject({
      requests: 2,
      errors: 1,
      ttftMs: { p50: 50, p95: 150 },
    })
  })

  it('没有样本时分位是 null，不是 0', () => {
    expect(jsonExtrasOf(view())['http']).toEqual({
      requests: 0,
      errors: 0,
      rateLimited: 0,
      inFlight: 0,
      durationMs: { p50: null, p95: null },
    })
  })
})

describe('metrics-extra · 用量、成本与计划', () => {
  const usageEvents = [
    event('usage/summary', { turn: 1, input: 10, output: 5, cachedInput: 2, costMicroYuan: 1200 }),
    event('usage/summary', { turn: 2, input: 3, output: 4, cachedInput: 1, costMicroYuan: 800 }),
    // 同轮多条累加；非法数值按 0 处理（不产生 NaN）
    event('usage/summary', { turn: 2, input: Number.NaN, output: '9', cachedInput: null, costMicroYuan: 200 }),
  ]

  it('成本按轮累加、只取最近 50 轮，lastTurn 是最后一次出现', () => {
    const cost = jsonExtrasOf(view({ events: usageEvents }))['cost'] as Record<string, unknown>
    expect(cost['total']).toBe(2200)
    expect(cost['byTurn']).toEqual([
      { turn: 1, costMicroYuan: 1200, input: 10, output: 5 },
      { turn: 2, costMicroYuan: 1000, input: 3, output: 4 },
    ])
    expect(cost['configured']).toBe(false)
  })

  it('token 按轮归集；plan 节点按 status 分类，未知状态不计', () => {
    const events = [
      ...usageEvents,
      event('plan/node-result', { status: 'succeeded' }),
      event('plan/node-result', { status: 'succeeded' }),
      event('plan/node-result', { status: 'failed' }),
      event('plan/node-result', { status: 'skipped' }),
      event('plan/node-result', { status: 'weird' }),
      event('plan/node-blocked', {}),
    ]
    const extras = jsonExtrasOf(view({ events }))
    expect((extras['llm'] as Record<string, unknown>)['tokensPerTurn']).toEqual([
      { turn: 1, input: 10, output: 5, cachedInput: 2 },
      { turn: 2, input: 3, output: 4, cachedInput: 1 },
    ])
    expect(extras['plan']).toEqual({ nodes: { succeeded: 2, failed: 1, blocked: 1, skipped: 1 } })
  })

  it('预算：limit <= 0 输出 null；有上限时 turn 取最后一轮账本、session 取总成本', () => {
    const noBudget = metricInputsOf(view({ events: usageEvents, handle: fakeHandle() }))
    expect(noBudget.budget).toEqual({ turn: null, session: null })

    const withBudget = metricInputsOf(
      view({
        events: usageEvents,
        handle: fakeHandle({
          guard: { maxTurnCostMicroYuan: 1000, maxSessionCostMicroYuan: 5000, maxTurnOutputTokens: 0 },
          exhausted: { turn: 1, session: 0 },
          turnCost: 800,
        }),
      }),
    )
    expect(withBudget.budget).toEqual({
      turn: { used: 800, limit: 1000, exhausted: 1 },
      session: { used: 2200, limit: 5000, exhausted: 0 },
    })
  })
})

describe('metrics-extra · SLO / 告警 / 进程 / 轨迹', () => {
  const slo: Record<string, SloSample> = {
    dlqDepth: { metric: 'dlqDepth', value: 3, unit: 'count', soft: 1, hard: 5, detail: '' },
    rto: { metric: 'rto', value: null, unit: 'ms', soft: 300_000, hard: 300_000, detail: '' },
  }

  it('SLO 空值保持 null 并判 no-data；没装 saga 时整段为 null', () => {
    const withSlo = jsonExtrasOf(view({ slo }))
    expect(withSlo['slo']).toEqual({
      dlqDepth: { value: 3, verdict: 'alert', unit: 'count', soft: 1, hard: 5 },
      rto: { value: null, verdict: 'no-data', unit: 'ms', soft: 300_000, hard: 300_000 },
    })
    expect(jsonExtrasOf(view())['slo']).toBeNull()

    const inputs = metricInputsOf(view({ slo }))
    expect(inputs.slo).toEqual({
      dlqDepth: { value: 3, soft: 1, hard: 5, unit: 'count' },
      rto: { value: null, soft: 300_000, hard: 300_000, unit: 'ms' },
    })
    expect(metricInputsOf(view()).slo).toBeUndefined()
  })

  it('告警计数从 alert-stats 读；进程、日志、SSE、轨迹深度同段输出', () => {
    resetAlertStats()
    recordAlertResult('P0', 'failed', 2)
    recordAlertResult('alert', 'webhook')

    const extras = jsonExtrasOf(
      view({
        handle: fakeHandle({
          spans: [span()],
          size: 5,
          dropped: 2,
          roots: [{ depth: 2, children: [{ depth: 4, children: [] }] }],
        }),
        logs: {
          byLevel: { debug: 0, info: 1, warn: 2, error: 0 },
          suppressed: 3,
          writeErrors: 0,
        },
        sseClients: 4,
        sseFrames: { frame: 7, fault: 1 },
      }),
    )

    expect(extras['alerts']).toEqual({
      byLevel: { alert: 1, P0: 2 },
      byResult: { stderr: 0, file: 0, webhook: 1, failed: 2 },
    })
    expect(extras['process']).toEqual({
      uptimeSec: 12,
      rssBytes: 1024,
      heapUsedBytes: 512,
      eventLoopP99Sec: 0.02,
      node: 'v22.17.0',
    })
    expect(extras['telemetry']).toEqual({ spans: 5, dropped: 2, treeDepth: 4 })
    expect(extras['logs']).toEqual({ byLevel: { debug: 0, info: 1, warn: 2, error: 0 }, suppressed: 3 })

    const inputs = metricInputsOf(
      view({
        slo,
        sseClients: 4,
        sseFrames: { frame: 7, fault: 1 },
        handle: fakeHandle({ spans: [span()], size: 5, dropped: 2 }),
      }),
    )
    expect(inputs.alerts).toEqual({
      samples: [
        { level: 'P0', result: 'failed', count: 2 },
        { level: 'alert', result: 'webhook', count: 1 },
      ],
    })
    expect(inputs.sseClients).toBe(4)
    expect(inputs.sseFrames).toEqual({ frame: 7, fault: 1 })

    resetAlertStats()
  })
})
