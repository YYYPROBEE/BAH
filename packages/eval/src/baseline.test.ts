/**
 * TC-W15-06 / 07：基线形状与劣化判定（纯函数）。
 */

import { describe, expect, it } from 'vitest'

import { compareBaseline } from './baseline.ts'
import type { BaselineFile } from './baseline.ts'

const BASELINE: BaselineFile = {
  schemaVersion: 'eval-baseline.v1',
  commit: 'abc123',
  seed: 20261026,
  recordedAt: '2026-10-26T00:00:00.000Z',
  metrics: {
    taskSuccess: { passed: 49, total: 49, rate: 1 },
    privilegeBlock: { passed: 5, total: 5, rate: 1 },
    refusalAccuracy: { passed: 6, total: 6, rate: 1 },
    averageSteps: 1.25,
  },
  targets: {
    taskSuccessRate: 0.95,
    privilegeBlockRate: 1,
    refusalAccuracyRate: 0.95,
    averageStepsMax: 2,
  },
  notes: ['test'],
}

const CURRENT = {
  taskSuccess: { passed: 49, total: 49 },
  privilegeBlock: { passed: 5, total: 5 },
  refusalAccuracy: { passed: 6, total: 6 },
  averageSteps: { value: 1.25 },
}

describe('W15 · 基线', () => {
  it('TC-W15-06 当前指标与基线一致 → 通过；结构含 commit/seed/四指标', () => {
    expect(BASELINE.commit).toBeTruthy()
    expect(BASELINE.seed).toBe(20261026)
    expect(BASELINE.metrics.taskSuccess.total).toBe(49)
    const comparison = compareBaseline(CURRENT, BASELINE)
    expect(comparison.ok).toBe(true)
    expect(comparison.rows).toHaveLength(4)
  })

  it('TC-W15-07 率下降 >5pp / 平均步数恶化 >5% / 分母缩小 → 红', () => {
    const dropped = compareBaseline(
      { ...CURRENT, taskSuccess: { passed: 44, total: 49 } },
      BASELINE,
    )
    expect(dropped.ok).toBe(false)
    expect(dropped.rows.find((row) => row.name === 'taskSuccess')?.text).toContain('下降>5pp')

    const slower = compareBaseline({ ...CURRENT, averageSteps: { value: 1.4 } }, BASELINE)
    expect(slower.ok).toBe(false)

    const shrunk = compareBaseline(
      { ...CURRENT, privilegeBlock: { passed: 4, total: 4 } },
      BASELINE,
    )
    expect(shrunk.ok).toBe(false)
    expect(shrunk.rows.find((row) => row.name === 'privilegeBlock')?.text).toContain('分母缩小')
  })
})
