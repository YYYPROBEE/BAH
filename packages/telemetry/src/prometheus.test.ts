import { describe, expect, it } from 'vitest'

import { collectMetrics, type MetricFamily, type MetricInputs, type MetricSpec } from './metrics.ts'
import { renderPrometheus } from './prometheus.ts'

const PROCESS = {
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

function family(spec: MetricSpec, samples: MetricFamily['samples']): MetricFamily {
  return { spec, samples }
}

const TURNS: MetricSpec = {
  name: 'test_total',
  type: 'counter',
  help: 'test counter',
  labels: [],
  unit: 'count',
  source: 'test',
}

describe('prometheus · 格式', () => {
  it('HELP/TYPE/样本三段式，文件以换行结尾', () => {
    const text = renderPrometheus(collectMetrics(inputs()))
    expect(text.startsWith('# HELP bah_up Process is up\n# TYPE bah_up gauge\nbah_up 1\n')).toBe(true)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).not.toContain('\r')
    expect(text).toContain('# TYPE bah_turns_total counter')
    expect(text).toContain('bah_turns_total 0')
  })

  it('标签按字母序；值转义反斜杠/引号/换行', () => {
    const text = renderPrometheus([
      family(TURNS, [{ labels: { z: 'a"b\\c\nd', a: '1' }, value: 2 }]),
    ])
    expect(text).toContain('test_total{a="1",z="a\\"b\\\\c\\nd"} 2')
  })

  it('histogram：+Inf 桶 count === _count，_sum 用浮点', () => {
    const events = [
      { at: 1, type: 'tool/call', data: { callId: 'c1', name: 'account_balance', tier: { level: 'green' } } },
      { at: 2, type: 'tool/result', data: { callId: 'c1', name: 'account_balance', isError: false, durationMs: 100 } },
    ]
    const text = renderPrometheus(collectMetrics(inputs({ events })))
    const inf = /bah_tool_duration_seconds_bucket\{tool="account_balance",le="\+Inf"\} (\d+)/.exec(text)
    const count = /bah_tool_duration_seconds_count\{tool="account_balance"\} (\d+)/.exec(text)
    expect(inf?.[1]).toBe('1')
    expect(count?.[1]).toBe('1')
    expect(text).toContain('bah_tool_duration_seconds_sum{tool="account_balance"} 0.1')
  })

  it('NaN 写 NaN（SLO 无数据）', () => {
    const text = renderPrometheus(
      collectMetrics(inputs({ slo: { dlqDepth: { value: null, soft: 1, hard: 2, unit: 'count' } } })),
    )
    expect(text).toContain('bah_slo_value{metric="dlqDepth",verdict="no-data"} NaN')
  })

  it('空 family 不输出；没有样本的直方图也不输出', () => {
    const text = renderPrometheus([
      family({ ...TURNS, name: 'empty_total' }, []),
      family({ ...TURNS, name: 'empty_hist', type: 'histogram' }, [
        { labels: {}, value: null, histogram: { buckets: [], sum: 0, count: 0 } },
      ]),
    ])
    expect(text).toBe('\n')
  })

  it('重复 series 直接抛错（不静默输出两条）', () => {
    expect(() =>
      renderPrometheus([
        family(TURNS, [
          { labels: { a: '1' }, value: 1 },
          { labels: { a: '1' }, value: 2 },
        ]),
      ]),
    ).toThrow(/duplicate series/)
  })
})
