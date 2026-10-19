/**
 * 合法出边表（SA-00 §4.1 的唯一事实源落地）。
 *
 * 独立成文件是为了让 `reduceSaga`（推断目标态）与 `assertTransition`（运行期守卫）
 * 共用同一张表，同时避免 `index.ts ⇄ reduce.ts` 的运行时环。
 */

import type { SagaState } from '../types.ts'

/** 合法出边表：终态无出边（SA-00 §4.1）。 */
export const SAGA_TRANSITIONS: Readonly<Record<SagaState, readonly SagaState[]>> = {
  CREATED: ['RUNNING'],
  RUNNING: [
    'SUCCEEDED',
    'ABORTED_CLEAN',
    'COMPENSATING',
    'PENDING_RISK_REVIEW',
    'GATE_HOLDING',
    'COMPENSATION_DLQ',
  ],
  PENDING_RISK_REVIEW: ['RUNNING', 'COMPENSATING', 'ABORTED_CLEAN'],
  GATE_HOLDING: ['RUNNING', 'COMPENSATING'],
  COMPENSATING: ['COMPENSATED', 'PARTIALLY_COMPENSATED', 'COMPENSATION_DLQ', 'MANUALLY_CLOSED'],
  PARTIALLY_COMPENSATED: ['COMPENSATING', 'MANUALLY_CLOSED'],
  COMPENSATION_DLQ: ['MANUALLY_CLOSED'],
  SUCCEEDED: [],
  ABORTED_CLEAN: [],
  COMPENSATED: [],
  MANUALLY_CLOSED: [],
}

/** 该出边是否合法（纯函数；`reduceSaga` 与运行期守卫共用）。 */
export function canTransition(from: SagaState, to: SagaState): boolean {
  return SAGA_TRANSITIONS[from].includes(to)
}
