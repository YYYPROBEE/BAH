/**
 * TC-W13-01：60 个场景的静态契约（数量 / 族计数 / ID 唯一 / seed 一致）。
 */

import { describe, expect, it } from 'vitest'

import { ALL_SCENARIOS } from '../scenarios/index.ts'
import { FAMILY_COUNTS, TOTAL_SCENARIOS, validateScenarios } from './validate.ts'

describe('W13 · 场景静态校验', () => {
  it('TC-W13-01 60 个场景：族计数 10/12/10/8/10/10，ID 唯一且前缀正确', () => {
    const result = validateScenarios(ALL_SCENARIOS)
    expect(result.findings).toEqual([])
    expect(result.ok).toBe(true)
    expect(ALL_SCENARIOS).toHaveLength(TOTAL_SCENARIOS)

    for (const [family, expected] of Object.entries(FAMILY_COUNTS)) {
      const items = ALL_SCENARIOS.filter((item) => item.spec.family === family)
      expect(`${family}:${String(items.length)}`).toBe(`${family}:${String(expected)}`)
    }
    const ids = ALL_SCENARIOS.map((item) => item.spec.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of ALL_SCENARIOS) {
      expect(item.spec.id.startsWith(item.spec.family)).toBe(true)
    }
  })

  it('重复 ID / 少一个场景 / 组内 seed 不一致都会被拒', () => {
    const duplicate = [...ALL_SCENARIOS.slice(0, -1), ALL_SCENARIOS[0]!]
    expect(validateScenarios(duplicate).findings.some((line) => line.includes('重复'))).toBe(true)

    const missing = ALL_SCENARIOS.slice(0, -1)
    expect(validateScenarios(missing).findings.some((line) => line.includes('总场景数'))).toBe(true)

    const mixedSeed = ALL_SCENARIOS.map((item, index) =>
      index === 1 ? { ...item, spec: { ...item.spec, seed: 1 } } : item,
    )
    expect(validateScenarios(mixedSeed).findings.some((line) => line.includes('seed 不一致'))).toBe(
      true,
    )
  })
})
