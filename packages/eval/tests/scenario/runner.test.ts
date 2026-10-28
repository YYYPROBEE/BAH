/**
 * W13 端到端：60 场景全量、确定性（同 shard / 跨 shard）、filter、boot 次数。
 *
 * 这一组**不在主 vitest 面**（`vitest.eval.config.ts` 才收），因为它会真 boot 8 个应用。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ALL_SCENARIOS, runEvalReport } from '../../src/index.ts'

const ROOT = process.cwd()

function sessionsSnapshot(): readonly string[] {
  try {
    return readdirSync(join(ROOT, 'sessions'), { withFileTypes: true })
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

describe('W13 · 60 场景端到端', () => {
  it(
    '全量 60：全部通过、boot=8、报告按族→ID 排序、仓库 sessions/ 无新增',
    async () => {
      const before = sessionsSnapshot()
      const report = await runEvalReport({ repoRoot: ROOT, scenarios: ALL_SCENARIOS })
      const after = sessionsSnapshot()

      expect(report.bootCount).toBe(8)
      expect(report.scenarios).toHaveLength(60)
      expect(report.scenarios.filter((scenario) => scenario.status === 'fail')).toEqual([])
      expect(report.metrics.taskSuccess.total).toBeGreaterThan(0)
      expect(report.metrics.taskSuccess.passed).toBe(report.metrics.taskSuccess.total)
      expect(report.metrics.privilegeBlock.passed).toBe(report.metrics.privilegeBlock.total)
      expect(report.metrics.refusalAccuracy.passed).toBe(report.metrics.refusalAccuracy.total)
      expect(after).toEqual(before)

      const order = ['Q', 'T', 'P', 'S', 'D', 'K']
      const sorted = [...report.scenarios].sort((left, right) => {
        const family = order.indexOf(left.family) - order.indexOf(right.family)
        return family !== 0 ? family : left.id.localeCompare(right.id)
      })
      expect(report.scenarios.map((scenario) => scenario.id)).toEqual(
        sorted.map((scenario) => scenario.id),
      )
    },
    120_000,
  )

  it(
    'TC-W13-02 同 seed 两次全等；--shard=1 与 --shard=6 结果全等',
    async () => {
      const options = { repoRoot: ROOT, scenarios: ALL_SCENARIOS, filter: 'Q,T' }
      const first = await runEvalReport({ ...options, shard: 1 })
      const second = await runEvalReport({ ...options, shard: 1 })
      const parallel = await runEvalReport({ ...options, shard: 6 })
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
      expect(JSON.stringify(parallel)).toBe(JSON.stringify(first))
      expect(first.bootCount).toBe(2)
    },
    120_000,
  )

  it('TC-W13-06 --filter 按族/ID 跑子集（boot 也只起需要的组）', async () => {
    const byId = await runEvalReport({ repoRoot: ROOT, scenarios: ALL_SCENARIOS, filter: 'T-03' })
    expect(byId.scenarios.map((scenario) => scenario.id)).toEqual(['T-03'])
    expect(byId.bootCount).toBe(1)

    const byFamily = await runEvalReport({ repoRoot: ROOT, scenarios: ALL_SCENARIOS, filter: 'K' })
    expect(byFamily.scenarios).toHaveLength(10)
    expect(byFamily.bootCount).toBe(1)
  }, 120_000)
})
