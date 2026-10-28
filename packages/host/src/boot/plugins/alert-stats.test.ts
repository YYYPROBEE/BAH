/**
 * 告警扇出计数（可观测性 02 / S2.7）。
 *
 * 这是 `/api/metrics.alerts` 与 `bah_alerts_total` 的**唯一**计数源。
 * 三条纪律：成功与失败都记、`amount <= 0` 不建空 series、三个出口的结果互不吞并。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { alertSamples, alertSummary, recordAlertResult, resetAlertStats } from './alert-stats.ts'

beforeEach(() => {
  resetAlertStats()
})

describe('alert-stats · 计数', () => {
  it('四个出口各记各的，amount 累加', () => {
    recordAlertResult('alert', 'stderr')
    recordAlertResult('alert', 'file')
    recordAlertResult('alert', 'file')
    recordAlertResult('P0', 'webhook', 2)
    recordAlertResult('P0', 'failed')

    expect(alertSamples()).toContainEqual({ level: 'alert', result: 'stderr', count: 1 })
    expect(alertSamples()).toContainEqual({ level: 'alert', result: 'file', count: 2 })
    expect(alertSamples()).toContainEqual({ level: 'P0', result: 'webhook', count: 2 })
    expect(alertSamples()).toContainEqual({ level: 'P0', result: 'failed', count: 1 })
  })

  it('amount <= 0 不产生 series（0 值与"没发生过"是两件事）', () => {
    recordAlertResult('alert', 'webhook', 0)
    recordAlertResult('alert', 'webhook', -1)
    expect(alertSamples()).toEqual([])
  })

  it('汇总按 level / result 双向合计，且零值键始终存在', () => {
    recordAlertResult('alert', 'stderr', 2)
    recordAlertResult('P0', 'failed', 3)

    expect(alertSummary()).toEqual({
      byLevel: { alert: 2, P0: 3 },
      byResult: { stderr: 2, file: 0, webhook: 0, failed: 3 },
    })
  })

  it('reset 只清计数，不影响之后的累加', () => {
    recordAlertResult('P0', 'file')
    resetAlertStats()
    expect(alertSamples()).toEqual([])
    recordAlertResult('P0', 'file')
    expect(alertSamples()).toEqual([{ level: 'P0', result: 'file', count: 1 }])
  })
})
