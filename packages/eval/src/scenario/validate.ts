/**
 * 场景静态校验（TC-W13-01）：ID 唯一、族计数、字段形状、组内 seed 一致。
 *
 * 为什么在 runner 里再做一遍：`spec.ts` 只有类型；`it.each` 式的误拷贝（两个 T-03）
 * 与"少写一个场景"都只能靠运行时校验发现。校验器不读文件、不 boot，纯函数。
 */

import type { ScenarioFamily } from './spec.ts'
import type { EvalScenario } from './types.ts'

/** 七族的固定例数（W13 §1；少一条或多一条都算本设计失败）。 */
export const FAMILY_COUNTS: Readonly<Record<ScenarioFamily, number>> = {
  Q: 14,
  T: 16,
  P: 11,
  S: 8,
  D: 15,
  K: 10,
  U: 17,
}

/** 总场景数。 */
export const TOTAL_SCENARIOS = 91

const ID_PATTERN = /^[QTPSDKU]-\d{2}$/
const FAMILIES = ['Q', 'T', 'P', 'S', 'D', 'K', 'U'] as const
const APPROVALS = new Set(['allow', 'reject', 'unavailable'])
const METRICS = new Set(['task-success', 'privilege-block', 'refusal-accuracy'])
const EXPECT_KINDS = new Set([
  'tool-sequence',
  'tool-denied',
  'tool-result',
  'refused',
  'event',
  'no-event',
])

/** 校验结果（findings 为空即通过）。 */
export interface ValidationResult {
  readonly ok: boolean
  readonly findings: readonly string[]
}

/** 校验全部场景。 */
export function validateScenarios(scenarios: readonly EvalScenario[]): ValidationResult {
  const findings: string[] = []
  const ids = new Map<string, number>()
  const counts: Record<string, number> = {}

  for (const { spec } of scenarios) {
    const where = spec.id || '<无 id>'
    if (!ID_PATTERN.test(spec.id)) {
      findings.push(`${where}: id 必须是「族字母 + 两位序号」（如 T-03）`)
    } else if (!spec.id.startsWith(spec.family)) {
      findings.push(`${where}: id 前缀与 family=${spec.family} 不一致`)
    }
    ids.set(spec.id, (ids.get(spec.id) ?? 0) + 1)
    counts[spec.family] = (counts[spec.family] ?? 0) + 1

    if (!FAMILIES.includes(spec.family)) findings.push(`${where}: 未知 family ${spec.family}`)
    if (typeof spec.title !== 'string' || spec.title.trim().length === 0) {
      findings.push(`${where}: title 不能为空`)
    }
    if (typeof spec.profile !== 'string' || spec.profile.trim().length === 0) {
      findings.push(`${where}: profile 不能为空`)
    }
    if (spec.approval !== undefined && !APPROVALS.has(spec.approval)) {
      findings.push(`${where}: approval 只能是 allow / reject / unavailable`)
    }
    if (spec.approval !== undefined && spec.family !== 'P') {
      findings.push(`${where}: 只有 P 族可以声明 approval（其它族固定 allow）`)
    }
    if (!Number.isInteger(spec.seed)) findings.push(`${where}: seed 必须是整数`)
    if (!Array.isArray(spec.turns) || spec.turns.some((turn) => typeof turn !== 'string')) {
      findings.push(`${where}: turns 必须是字符串数组`)
    }
    if (!Array.isArray(spec.expect)) findings.push(`${where}: expect 必须是数组`)
    for (const [index, expectation] of spec.expect.entries()) {
      if (!EXPECT_KINDS.has(expectation.kind)) {
        findings.push(`${where}: expect[${String(index)}] 未知 kind`)
      }
    }
    if (spec.metric !== undefined && !METRICS.has(spec.metric)) {
      findings.push(`${where}: 未知 metric ${String(spec.metric)}`)
    }
  }

  for (const [id, count] of ids) {
    if (count > 1) findings.push(`${id}: 场景 ID 重复（${String(count)} 次）`)
  }
  for (const family of FAMILIES) {
    const expected = FAMILY_COUNTS[family]
    const actual = counts[family] ?? 0
    if (actual !== expected) {
      findings.push(`族 ${family}: 期望 ${String(expected)} 例，实际 ${String(actual)} 例`)
    }
  }
  if (scenarios.length !== TOTAL_SCENARIOS) {
    findings.push(`总场景数期望 ${String(TOTAL_SCENARIOS)}，实际 ${String(scenarios.length)}`)
  }

  // 同一个 boot 组内的 seed 必须一致：数据集在 boot 期生成，组内换 seed 不会生效，
  // 只会让报告里的 seed 字段说谎。
  const groups = new Map<string, number>()
  for (const { spec } of scenarios) {
    const approval = spec.family === 'P' ? (spec.approval ?? 'allow') : 'allow'
    const key = `${spec.family}:${approval}:${spec.profile}`
    const previous = groups.get(key)
    if (previous !== undefined && previous !== spec.seed) {
      findings.push(`${key}: 组内 seed 不一致（${String(previous)} vs ${String(spec.seed)}）`)
    } else if (previous === undefined) {
      groups.set(key, spec.seed)
    }
  }

  return { ok: findings.length === 0, findings }
}
