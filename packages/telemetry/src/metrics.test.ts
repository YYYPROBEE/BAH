import { describe, expect, it } from 'vitest'

import { collectMetrics, METRIC_SPECS, type MetricFamily, type MetricInputs } from './metrics.ts'
import type { ProcessSnapshot } from './process.ts'
import type { TelemetrySpan } from './span.ts'

const PROCESS: ProcessSnapshot = {
  startedAtMs: 1_700_000_000_000,
  uptimeSec: 12,
  rssBytes: 1024,
  heapUsedBytes: 512,
  eventLoopP99Sec: 0.02,
  nodeVersion: 'v22.17.0',
}

function inputs(overrides: Partial<MetricInputs> = {}): MetricInputs {
  return {
    events: [],
    spans: [],
    stats: { spans: 0, dropped: 0 },
    process: PROCESS,
    logs: { byLevel: { debug: 0, info: 0, warn: 0, error: 0 }, suppressed: 0 },
    alerts: { samples: [] },
    costConfigured: false,
    ...overrides,
  }
}

function family(families: readonly MetricFamily[], name: string): MetricFamily {
  const found = families.find((item) => item.spec.name === name)
  if (found === undefined) throw new Error(`缺少 family ${name}`)
  return found
}

function event(type: string, data: unknown, at = 1_700_000_000_000): { at: number; type: string; data: unknown } {
  return { at, type, data }
}

function httpSpan(overrides: Partial<TelemetrySpan> = {}): TelemetrySpan {
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

describe('metrics · 空输入与进程面', () => {
  it('空事件：计数为 0 而不是 NaN，进程 gauge 有值', () => {
    const families = collectMetrics(inputs())
    expect(family(families, 'bah_up').samples[0]!.value).toBe(1)
    expect(family(families, 'bah_turns_total').samples[0]!.value).toBe(0)
    expect(family(families, 'bah_steps_total').samples[0]!.value).toBe(0)
    expect(family(families, 'bah_nodejs_rss_bytes').samples[0]!.value).toBe(1024)
    expect(family(families, 'bah_process_uptime_seconds').samples[0]!.value).toBe(12)
    expect(families.some((item) => item.samples.some((sample) => Number.isNaN(sample.value ?? 0)))).toBe(false)
  })

  it('36 个 family 一个不少，且名字唯一', () => {
    expect(METRIC_SPECS).toHaveLength(36)
    expect(new Set(METRIC_SPECS.map((spec) => spec.name)).size).toBe(36)
    expect(collectMetrics(inputs())).toHaveLength(36)
  })
})

describe('metrics · 工具与审批', () => {
  it('3 条 durationMs 100/200/300：_count=3、_sum=0.6、桶累计正确', () => {
    const events = [
      event('tool/call', { callId: 'c1', name: 'account_balance', tier: { level: 'green' } }),
      event('tool/result', { callId: 'c1', name: 'account_balance', isError: false, durationMs: 100 }),
      event('tool/call', { callId: 'c2', name: 'account_balance', tier: { level: 'green' } }),
      event('tool/result', { callId: 'c2', name: 'account_balance', isError: false, durationMs: 200 }),
      event('tool/call', { callId: 'c3', name: 'account_balance', tier: { level: 'green' } }),
      event('tool/result', { callId: 'c3', name: 'account_balance', isError: false, durationMs: 300 }),
    ]
    const hist = family(collectMetrics(inputs({ events })), 'bah_tool_duration_seconds').samples[0]!.histogram!
    expect(hist.count).toBe(3)
    expect(hist.sum).toBeCloseTo(0.6, 10)
    const bucket = (le: number): number => hist.buckets.find((row) => row.le === le)!.count
    expect(bucket(0.001)).toBe(0)
    expect(bucket(0.1)).toBe(1)
    expect(bucket(0.25)).toBe(2)
    expect(bucket(Number.POSITIVE_INFINITY)).toBe(3)
  })

  it('durationMs 缺省直接跳过（缺省 ≠ 0ms）', () => {
    const events = [
      event('tool/call', { callId: 'c1', name: 'account_balance', tier: { level: 'green' } }),
      event('tool/result', { callId: 'c1', name: 'account_balance', isError: false }),
    ]
    const familyItem = family(collectMetrics(inputs({ events })), 'bah_tool_duration_seconds')
    expect(familyItem.samples).toEqual([])
  })

  it('同一工具两次出现只有一个 series，值累加', () => {
    const events = [
      event('tool/call', { callId: 'c1', name: 'account_balance', tier: { level: 'green' } }),
      event('tool/call', { callId: 'c2', name: 'account_balance', tier: { level: 'green' } }),
    ]
    const calls = family(collectMetrics(inputs({ events })), 'bah_tool_calls_total').samples
    expect(calls).toHaveLength(1)
    expect(calls[0]!.labels).toEqual({ tool: 'account_balance', tier: 'green' })
    expect(calls[0]!.value).toBe(2)
  })

  it('审批等待只用墙钟，decision 归成 approved/rejected/other', () => {
    const events = [
      event('approval/asked', { ticketId: 't1', callId: 'c1', name: 'transfer_create' }, 1_000),
      event('approval/decided', { ticketId: 't1', decision: 'allowed-once' }, 4_000),
      event('approval/asked', { ticketId: 't2', callId: 'c2', name: 'safety_unfreeze' }, 5_000),
      event('approval/decided', { ticketId: 't2', decision: 'unavailable' }, 6_000),
    ]
    const families = collectMetrics(inputs({ events }))
    const approvals = family(families, 'bah_approvals_total').samples
    expect(approvals.map((sample) => sample.labels['decision']).sort()).toEqual(['approved', 'other'])
    const wait = family(families, 'bah_approval_wait_seconds').samples
    expect(wait.map((sample) => sample.labels['name']).sort()).toEqual(['safety_unfreeze', 'transfer_create'])
    expect(wait.find((sample) => sample.labels['name'] === 'transfer_create')!.histogram!.sum).toBe(3)
  })
})

describe('metrics · 用量与成本', () => {
  it('两条 usage/summary 1200/800 µ元 → 2000（整数）', () => {
    const events = [
      event('request/header', { turn: 1, step: 1, model: 'router-chat' }),
      event('usage/summary', { turn: 1, input: 10, output: 5, cachedInput: 2, costMicroYuan: 1200 }),
      event('request/header', { turn: 2, step: 1, model: 'router-chat' }),
      event('usage/summary', { turn: 2, input: 10, output: 5, cachedInput: 2, costMicroYuan: 800 }),
    ]
    const cost = family(collectMetrics(inputs({ events })), 'bah_llm_cost_micro_yuan_total')
    expect(cost.samples).toHaveLength(1)
    expect(cost.samples[0]!.value).toBe(2000)
    expect(family(collectMetrics(inputs({ events })), 'bah_llm_tokens_total').samples).toHaveLength(3)
  })

  it('costConfigured=false → gauge 0（不是"免费"，是"没配"）', () => {
    const item = family(collectMetrics(inputs({ costConfigured: false })), 'bah_llm_cost_configured')
    expect(item.samples[0]!.value).toBe(0)
  })

  it('llm error 归到最近一次 request/header 的模型', () => {
    const events = [
      event('request/header', { turn: 1, step: 1, model: 'router-chat' }),
      event('assistant/attempt', { status: 'failed', reason: 'boom' }),
    ]
    const requests = family(collectMetrics(inputs({ events })), 'bah_llm_requests_total').samples
    expect(requests.map((sample) => `${sample.labels['model']}/${sample.labels['status']}`).sort()).toEqual([
      'router-chat/error',
      'router-chat/request',
    ])
  })
})

describe('metrics · SLO 与预算', () => {
  it('SLO 空值输出 NaN + verdict=no-data', () => {
    const families = collectMetrics(
      inputs({ slo: { dlqDepth: { value: null, soft: 1, hard: 2, unit: 'count' } } }),
    )
    const sample = family(families, 'bah_slo_value').samples[0]!
    expect(sample.labels).toEqual({ metric: 'dlqDepth', verdict: 'no-data' })
    expect(Number.isNaN(sample.value)).toBe(true)
  })

  it('预算未配：不输出 remaining 系列', () => {
    const families = collectMetrics(
      inputs({ budget: { turn: { used: 0, limit: 0, exhausted: 0 }, session: null } }),
    )
    expect(family(families, 'bah_cost_budget_remaining_micro_yuan').samples).toEqual([])
    expect(family(families, 'bah_cost_budget_exhausted_total').samples).toEqual([])
  })

  it('预算 10000 已用 6000 → remaining 4000；耗尽计数按 scope 分开', () => {
    const families = collectMetrics(
      inputs({
        budget: {
          turn: { used: 6_000, limit: 10_000, exhausted: 1 },
          session: { used: 6_000, limit: 20_000, exhausted: 0 },
        },
      }),
    )
    const remaining = family(families, 'bah_cost_budget_remaining_micro_yuan').samples
    expect(remaining.find((sample) => sample.labels['scope'] === 'turn')!.value).toBe(4_000)
    expect(remaining.find((sample) => sample.labels['scope'] === 'session')!.value).toBe(14_000)
    expect(family(families, 'bah_cost_budget_exhausted_total').samples).toHaveLength(2)
  })
})

describe('metrics · HTTP / 遥测 / 日志 / 告警', () => {
  it('http.request span：请求数、时长、429、in-flight 各归其位', () => {
    const spans = [
      httpSpan(),
      httpSpan({ spanId: 'a'.repeat(16), attributes: { route: '/api/turn', method: 'POST', status: 429 } }),
      httpSpan({ spanId: 'b'.repeat(16), endMs: null, attributes: { route: '/api/events', method: 'GET' } }),
    ]
    const families = collectMetrics(inputs({ spans }))
    expect(family(families, 'bah_http_requests_total').samples).toHaveLength(2)
    expect(family(families, 'bah_http_rate_limited_total').samples[0]!.value).toBe(1)
    expect(family(families, 'bah_http_in_flight').samples[0]!.value).toBe(1)
  })

  it('遥测与日志计数：spans / dropped / byLevel', () => {
    const families = collectMetrics(
      inputs({
        stats: { spans: 7, dropped: 2 },
        logs: { byLevel: { debug: 0, info: 3, warn: 1, error: 0 }, suppressed: 4 },
      }),
    )
    expect(family(families, 'bah_telemetry_spans').samples[0]!.value).toBe(7)
    expect(family(families, 'bah_telemetry_spans_dropped_total').samples[0]!.value).toBe(2)
    expect(family(families, 'bah_log_lines_total').samples).toHaveLength(4)
  })

  it('告警按 level/result 分 series', () => {
    const families = collectMetrics(
      inputs({
        alerts: {
          samples: [
            { level: 'alert', result: 'stderr', count: 2 },
            { level: 'P0', result: 'webhook', count: 1 },
          ],
        },
      }),
    )
    expect(family(families, 'bah_alerts_total').samples).toHaveLength(2)
  })
})
