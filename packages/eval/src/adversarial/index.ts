/**
 * 对抗集入口（W14）：45 例 = 注入 15 + 越权 15 + 幻觉 15。
 *
 * 场景复用 W13 的 `ScenarioSpec` / runner；ID 前缀与 `expected.ts` 的真实族一致。
 */

export { ADVERSARIAL_META, familyLabel, metaOf, validateAdversarial } from './expected.ts'
export type {
  AdversarialAttribution,
  AdversarialExpectation,
  AdversarialFamily,
  AdversarialMeta,
  AdversarialSource,
} from './expected.ts'
export { HALLUCINATION_SCENARIOS } from './hallucination/index.ts'
export { INJECTION_SCENARIOS } from './injection/index.ts'
export { PRIVILEGE_SCENARIOS } from './privilege/index.ts'
export { renderAdversarialSummary, runAdversarial } from './runner.ts'
export type { AdversarialCaseResult, AdversarialReport, AdversarialRunResult } from './runner.ts'

import { HALLUCINATION_SCENARIOS } from './hallucination/index.ts'
import { INJECTION_SCENARIOS } from './injection/index.ts'
import { PRIVILEGE_SCENARIOS } from './privilege/index.ts'
import type { EvalScenario } from '../scenario/types.ts'

/** 45 例（注入 → 越权 → 幻觉）。 */
export const ADVERSARIAL_SCENARIOS: readonly EvalScenario[] = [
  ...INJECTION_SCENARIOS,
  ...PRIVILEGE_SCENARIOS,
  ...HALLUCINATION_SCENARIOS,
]
