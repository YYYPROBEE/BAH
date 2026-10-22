/**
 * FRS 失败残留扫描（M0 §4.4）。
 *
 * 两类判定分开：`residues`（残留谓词命中，给清单）与 `stateRestored`（终局是否回到 S₀
 * 或显式回滚态）。**pass 需要两者同时干净**——只满足其一都不算干净：
 * - 回到 S₀ 但谓词仍命中 → 说明残留不在被比较的键上（如订阅挂在状态外的子系统里）；
 * - 谓词不命中但没回滚 → 说明状态漂着，只是漂在了四类已知残留之外（未知残留）。
 *
 * **FRS 独立于任务成败运行**（§4.4 原话）：成功 episode 也扫，结果供报告。
 * 是否把结果计入 SPR 分量，由调用方决定，本函数不做这个判断。
 */

import type { FlatState } from '../types.ts'
import { valueEquals } from './TSD.ts'

/** 残留谓词：终局状态满足即命中。四类基线（订阅挂起/额度占用/冻结/限额半改）由金标扩展。 */
export type ResiduePredicate = (state: FlatState) => boolean

export interface FrsInput {
  readonly before: FlatState
  readonly after: FlatState
  readonly residuePatterns: Readonly<Record<string, ResiduePredicate>>
  /** 判定「显式回滚态」时读哪个键（缺省 `state`）。 */
  readonly rollbackKey?: string
  /** 该键取这些值时视为显式回滚（如 `rolled-back` / `compensated`）。 */
  readonly rollbackValues?: readonly string[]
}

export interface FrsResult {
  readonly pass: boolean
  /** 命中的残留类型名（报告直接用）。 */
  readonly residues: readonly string[]
  readonly stateRestored: boolean
  readonly rollback: boolean
  readonly locator?: string
}

export function scanFrs(input: FrsInput): FrsResult {
  const residues = Object.entries(input.residuePatterns)
    .filter(([, predicate]) => predicate(input.after))
    .map(([name]) => name)

  const stateRestored = valueEquals(input.before, input.after)

  const rollbackKey = input.rollbackKey ?? 'state'
  const rollbackValues = input.rollbackValues ?? []
  const current = input.after[rollbackKey]
  const rollback = typeof current === 'string' && rollbackValues.includes(current)

  const pass = residues.length === 0 && (stateRestored || rollback)

  // 定位串：残留优先报（它们比「状态没回滚」更具体，指认得到东西）。
  const locator =
    residues.length > 0
      ? `frs:residue:${residues.join(',')}`
      : stateRestored || rollback
        ? undefined
        : `frs:state-not-restored:${rollbackKey}`

  return {
    pass,
    residues,
    stateRestored,
    rollback,
    ...(locator === undefined ? {} : { locator }),
  }
}
