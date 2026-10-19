/**
 * 唯一转移函数 `reduceSaga`（SA-07 §4 冻结签名 / SA-08 §3.1）。
 *
 * 运行期推进与离线回放**共用**本函数：`advance` 只用它推断目标状态，
 * SA-11 投影与 SA-13 回放只折叠它，不得另写转移映射表。
 *
 * 转移输入只有链记录的最小事件面（`SagaEventRecord`），因此语义由**事件类型**决定：
 * - `saga/created` 把初值 `CREATED` 推到 `RUNNING`（建期 CAS 的同一提交段）；
 * - 每个 `saga/step-planned` 登记一步；每个 `saga/call-result` 标记该步已有结果；
 *   当全部已登记步骤都有结果且事务仍在 `RUNNING` 时推断为 `SUCCEEDED`
 *   （失败路径会在同一结算段追加 `saga/comp-decided`，最终折叠回 `COMPENSATING`）；
 * - `saga/comp-decided` / `comp-issued` / `comp-result` 维持/进入 `COMPENSATING`；
 * - `saga/dlq-escalated` → `COMPENSATION_DLQ`；`saga/manually-closed` → `MANUALLY_CLOSED`；
 * - 探诊与恢复事件只改步骤视图，不改事务状态。
 *
 * 本函数**零 I/O、零 LLM、零外部调用**；未知事件类型原样返回（链上允许并存非状态事件）。
 */

import { BahError } from '@bah/util'

import type { ReduceSaga, SagaProjection, StepState } from '../types.ts'

const SETTLED: ReadonlySet<StepState> = new Set<StepState>(['EXECUTED', 'SKIPPED'])

/** 回放/投影的统一初值（SA-11 §3.5 / SA-13 §3.3：一律从 `CREATED` 起播）。 */
export function initialProjection(sagaId: string): SagaProjection {
  return { sagaId, state: 'CREATED', steps: {} }
}

/** 唯一单步转移：纯函数，输入相同则输出逐位相同。 */
export const reduceSaga: ReduceSaga = (projection, event) => {
  if (event.sagaId !== projection.sagaId) {
    throw new BahError('saga-mismatch', `bah-saga: saga-mismatch: 事件 ${event.sagaId} 不属于 ${projection.sagaId}`, {
      expected: projection.sagaId,
      actual: event.sagaId,
    })
  }

  const steps: Record<string, StepState> = { ...projection.steps }
  const subject = event.subjectRef

  switch (event.type) {
    case 'saga/created':
      return { ...projection, state: projection.state === 'CREATED' ? 'RUNNING' : projection.state }

    case 'saga/step-planned':
      if (subject.length > 0) steps[subject] = 'PLANNED'
      return { ...projection, steps }

    case 'saga/call-result':
      if (subject.length > 0) steps[subject] = 'EXECUTED'
      return {
        ...projection,
        state: allStepsSettled(steps) ? 'SUCCEEDED' : projection.state,
        steps,
      }

    case 'saga/unknown-probe':
      if (subject.length > 0) steps[subject] = 'PROBING'
      return { ...projection, steps }

    case 'saga/recovered': {
      const split = splitRecoveredSubject(subject)
      if (split.stepId.length > 0) steps[split.stepId] = stepStateOfRecovery(split.action)
      return { ...projection, steps }
    }

    case 'saga/comp-decided':
    case 'saga/comp-issued':
    case 'saga/comp-result':
      return { ...projection, state: 'COMPENSATING' }

    case 'saga/dlq-escalated':
      if (subject.length > 0) steps[subject] = 'UNRESOLVED'
      return { ...projection, state: 'COMPENSATION_DLQ', steps }

    case 'saga/manually-closed':
      return { ...projection, state: 'MANUALLY_CLOSED' }

    default:
      return projection
  }
}

function allStepsSettled(steps: Readonly<Record<string, StepState>>): boolean {
  const entries = Object.values(steps)
  return entries.length > 0 && entries.every((state) => SETTLED.has(state))
}

/**
 * `saga/recovered` 的 `action` 不在载荷可见面里，只能由 `subjectRef` 携带。
 * 恢复写路径约定：subjectRef = `${stepId}#${action}`（见 persistence 的 `subjectRefOf`），
 * 便于回放把步骤视图还原到恢复后的状态，同时保留步骤标识前缀。
 */
function splitRecoveredSubject(subject: string): { readonly stepId: string; readonly action: string } {
  const hash = subject.lastIndexOf('#')
  return hash < 0
    ? { stepId: subject, action: '' }
    : { stepId: subject.slice(0, hash), action: subject.slice(hash + 1) }
}

function stepStateOfRecovery(action: string): StepState {
  switch (action) {
    case 'skip-executed':
      return 'EXECUTED'
    case 'probe':
      return 'PROBING'
    case 'dlq':
      return 'UNRESOLVED'
    default:
      return 'PLANNED'
  }
}
