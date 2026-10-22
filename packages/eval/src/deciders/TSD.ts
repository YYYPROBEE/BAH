/**
 * TSD 终局状态差分（M0 §4.3）——**双向**：该变的要变，不该变的一个字节都不许动。
 *
 * 三个失败面分开命名，因为它们在报告里指向完全不同的缺陷：
 * - `unmetChanges`：说了要做但没做（典型：预检代替执行，T06）→ 任务未完成；
 * - `mustNotChangeViolations`：明确不该动的动了（T07）→ 越权或副作用污染；
 * - `undeclaredChanges`：白名单外的键自己变了（T08）→ 最隐蔽的一类，模型没被要求
 *   也没被禁止，但状态漂了，事后无法归因，必须 fail 而不是放过。
 */

import type { FlatState } from '../types.ts'

export interface TsdInput {
  /** 起始快照 S₀。 */
  readonly before: FlatState
  /** 终局快照 Send。 */
  readonly after: FlatState
  readonly mustChange: Readonly<Record<string, unknown>>
  readonly mustNotChange: readonly string[]
}

export interface TsdViolation {
  readonly key: string
  readonly kind: 'unmet-change' | 'must-not-change' | 'undeclared-change'
  readonly expected?: unknown
  readonly actual?: unknown
}

export interface TsdResult {
  readonly pass: boolean
  readonly violations: readonly TsdViolation[]
  /** 首个违规的定位串。 */
  readonly locator?: string
}

/**
 * 值比较：**数值严格相等 + 数组按集合等价 + 对象深比较**。
 *
 * 「支持值相等或等价集合」是 §4.3 的原话：金标里用 `['step-a','step-b']` 表达期望时，
 * 语义是「这两个都在」，而不是「顺序也必须一致」——顺序由 CSA 管，TSD 不该重复管。
 */
export function valueEquals(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false
    const remaining = [...actual]
    for (const item of expected) {
      const index = remaining.findIndex((candidate) => valueEquals(item, candidate))
      if (index === -1) return false
      remaining.splice(index, 1)
    }
    return true
  }

  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
    const expectedRecord = expected as Record<string, unknown>
    const actualRecord = actual as Record<string, unknown>
    const expectedKeys = Object.keys(expectedRecord)
    if (expectedKeys.length !== Object.keys(actualRecord).length) return false
    return expectedKeys.every((key) => valueEquals(expectedRecord[key], actualRecord[key]))
  }

  return Object.is(expected, actual)
}

/** 白名单 = `mustChange` 的键 ∪ `mustNotChange` 的键；其余一律算「白名单外」。 */
function whitelist(input: TsdInput): ReadonlySet<string> {
  return new Set([...Object.keys(input.mustChange), ...input.mustNotChange])
}

export function diffTsd(input: TsdInput): TsdResult {
  const violations: TsdViolation[] = []

  for (const [key, expected] of Object.entries(input.mustChange)) {
    const actual = input.after[key]
    if (!valueEquals(expected, actual)) {
      violations.push({ key, kind: 'unmet-change', expected, actual })
    }
  }

  for (const key of input.mustNotChange) {
    if (!valueEquals(input.before[key], input.after[key])) {
      violations.push({
        key,
        kind: 'must-not-change',
        expected: input.before[key],
        actual: input.after[key],
      })
    }
  }

  const allowed = whitelist(input)
  const keys = new Set([...Object.keys(input.before), ...Object.keys(input.after)])
  for (const key of keys) {
    if (allowed.has(key)) continue
    if (valueEquals(input.before[key], input.after[key])) continue
    violations.push({
      key,
      kind: 'undeclared-change',
      expected: input.before[key],
      actual: input.after[key],
    })
  }

  const first = violations[0]
  return {
    pass: violations.length === 0,
    violations,
    ...(first === undefined ? {} : { locator: `tsd:${first.kind}:${first.key}` }),
  }
}
