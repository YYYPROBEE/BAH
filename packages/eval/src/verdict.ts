/**
 * 五分量合取（M0 §4.1 的 `Verdict`）。
 *
 * **这不是 M1 的判定链**：M1 才负责「判定器输出 → 五分量」的聚合编排与分母台账。
 * 这里只做一件最小的事：把已经算好的五个分量按红线 1/2 的优先级合取成一个结论，
 * 并挑出「第一个该被看到」的失败分量。M0 的判定器各自独立可用，聚合由调用方显式给值。
 */

import { COMPONENT_ORDER, type ComponentVerdict, type Verdict, type VerdictComponent } from './types.ts'

/** 分量定位串（报告里用来指认「失败在哪一步」）。 */
export type ComponentLocators = Partial<Record<VerdictComponent, string>>

export interface BuildVerdictInput {
  readonly episodeId: string
  readonly components: Record<VerdictComponent, ComponentVerdict>
  /** 各分量的失败定位；缺省时用 `<component>:unspecified`。 */
  readonly locators?: ComponentLocators
  /** 完整率守卫（红线 3）判定为不可判定时的理由。 */
  readonly undecidableReason?: string
}

/**
 * 合取 + 首失败定位。
 *
 * 三条不可动摇的性质（测试 T15 钉住）：
 * 1. `strictPass` 只在**五分量全为 true** 时为 true；
 * 2. `'undecidable'` 一律按不通过处理（红线 3：证据不足 = 不可判定，**禁止默认通过**）；
 * 3. `firstFailure` 按 `COMPONENT_ORDER`（合规优先）挑，而不是按传入顺序。
 */
export function buildVerdict(input: BuildVerdictInput): Verdict {
  const firstFailure = COMPONENT_ORDER.filter((component) => input.components[component] !== true)
    .map((component) => ({
      component,
      locator: input.locators?.[component] ?? `${component}:unspecified`,
    }))
    .at(0)

  const strictPass = firstFailure === undefined

  return {
    episodeId: input.episodeId,
    components: { ...input.components },
    strictPass,
    ...(firstFailure === undefined ? {} : { firstFailure }),
    ...(input.undecidableReason === undefined
      ? {}
      : { undecidableReason: input.undecidableReason }),
  }
}

/** 该结论是否计入 N₃（评测器无法判定）。M1 的分母台账会用到。 */
export function isUndecidable(verdict: Verdict): boolean {
  return Object.values(verdict.components).some((value) => value === 'undecidable')
}
