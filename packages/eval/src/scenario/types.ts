/**
 * eval 场景的运行期形状（W13）。
 *
 * `spec.ts`（W02 冻结）只描述"场景是什么"；本文件补"runner 怎么执行它"。
 * 动作与 spec 放在一起（每个场景文件导出 `{ spec, action }`），因为 DSL 冻结时
 * 明确不预留 `setup` 字段——行为差异不该回流到场景契约里。
 */

import type { MockStep } from '@bah/llm/mock'
import type { Plan } from '@bah/runtime'

import type { ScenarioSpec } from './spec.ts'

/** 编排步的副作用类别（与 saga 的状态机同值集；结构类型，不 import saga 实现）。 */
export type SagaSideEffectClass = 'NONE' | 'IDEMPOTENT' | 'EXTERNAL_UNDOABLE'

/** S 族失败注入用的一条编排步。 */
export interface SagaStepFixture {
  readonly stepId: string
  readonly toolName: string
  readonly sideEffectClass: SagaSideEffectClass
  readonly deps: readonly string[]
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * runner 的执行动作（四种封闭形态）。
 *
 * - `script`：确定性模型脚本，走真实 `AgentLoop` + 七段管线；
 * - `plan`：直接调 `bah:plan`（编排原语不接受模型生成，场景由数据构造）；
 * - `saga`：脚本触发 `transfer_create`，但用场景自带的编排步替换默认配方（失败注入）；
 * - `none`：不发起任何动作（仅验启动态）。
 */
export type ScenarioAction =
  | { readonly kind: 'script'; readonly steps: readonly MockStep[] }
  | {
      readonly kind: 'plan'
      readonly plan: Plan
      readonly dryRun?: boolean
      readonly resume?: boolean
      /** resume 时点名重跑的失败节点（`failed` 不会被自动重试，见 W10 语义）。 */
      readonly resumeFrom?: readonly string[]
    }
  | { readonly kind: 'saga'; readonly steps: readonly MockStep[]; readonly recipe?: readonly SagaStepFixture[] }
  | { readonly kind: 'none' }

/** 一个可执行场景 = 冻结 spec + runner 动作。 */
export interface EvalScenario {
  readonly spec: ScenarioSpec
  readonly action: ScenarioAction
}
