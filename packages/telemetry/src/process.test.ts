/**
 * 进程快照用例（可观测性 02 / S2.3）。
 *
 * `collectMetrics` 的进程 gauge 全部由这份快照供数；快照读错（NaN / 负值 /
 * 起始时刻偏移）不会让 `/api/metrics` 报错，只会静默给出错误的监控曲线。
 * 这里钉住公开契约：首次懒建直方图返回 0、之后返回有限非负值，进程字段形状正确。
 */

import { describe, expect, it } from 'vitest'

import { readProcessSnapshot } from './process.ts'

describe('process · 进程快照', () => {
  it('首次调用懒建直方图返回 0；之后 p99 有限非负；进程字段形状正确', () => {
    const now = 1_700_000_000_000
    const first = readProcessSnapshot(now)
    expect(first.eventLoopP99Sec).toBe(0)

    const second = readProcessSnapshot(now)
    expect(Number.isFinite(second.eventLoopP99Sec)).toBe(true)
    expect(second.eventLoopP99Sec).toBeGreaterThanOrEqual(0)

    expect(second.nodeVersion).toBe(process.version)
    expect(second.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(second.rssBytes).toBeGreaterThan(0)
    expect(second.heapUsedBytes).toBeGreaterThan(0)
    expect(Math.abs(second.startedAtMs - (now - second.uptimeSec * 1000))).toBeLessThanOrEqual(1_000)
  })
})
