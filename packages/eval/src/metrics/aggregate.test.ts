/**
 * 四项指标聚合的纯函数测试（分母口径 + p95）。
 */

import { describe, expect, it } from 'vitest'

import { aggregateMetrics, countsByFamily, formatRate, percentile95 } from './aggregate.ts'
import type { ScenarioOutcome } from './aggregate.ts'

function outcome(
  id: string,
  family: ScenarioOutcome['family'],
  status: 'pass' | 'fail',
  steps: number,
  metric?: ScenarioOutcome['metric'],
): ScenarioOutcome {
  return { id, family, title: id, status, steps, ...(metric === undefined ? {} : { metric }) }
}

describe('W13 · 指标聚合', () => {
  it('三个率只统计声明了对应 metric 的场景（分母是适用场景数）', () => {
    const metrics = aggregateMetrics([
      outcome('Q-01', 'Q', 'pass', 1, 'task-success'),
      outcome('Q-02', 'Q', 'fail', 2, 'task-success'),
      outcome('P-05', 'P', 'pass', 3, 'privilege-block'),
      outcome('K-04', 'K', 'pass', 1, 'refusal-accuracy'),
      outcome('D-01', 'D', 'pass', 4),
    ])
    expect(metrics.taskSuccess).toEqual({ passed: 1, total: 2 })
    expect(metrics.privilegeBlock).toEqual({ passed: 1, total: 1 })
    expect(metrics.refusalAccuracy).toEqual({ passed: 1, total: 1 })
    expect(metrics.averageSteps).toEqual({ value: 2.2, samples: 5 })
  })

  it('比率字符串必须带分母；空分母显示 n/a', () => {
    expect(formatRate({ passed: 58, total: 60 })).toBe('58/60（96.7%）')
    expect(formatRate({ passed: 0, total: 0 })).toBe('0/0（n/a）')
  })

  it('p95 用最近秩法，空数组为 0', () => {
    expect(percentile95([])).toBe(0)
    expect(percentile95([1, 2, 3, 4, 5])).toBe(5)
    expect(percentile95(Array.from({ length: 100 }, (_, index) => index + 1))).toBe(95)
  })

  it('分族计数覆盖七族', () => {
    const counts = countsByFamily([outcome('Q-01', 'Q', 'pass', 1)])
    expect(counts.Q).toEqual({ passed: 1, total: 1 })
    expect(counts.K).toEqual({ passed: 0, total: 0 })
    expect(counts.U).toEqual({ passed: 0, total: 0 })
  })
})
