/**
 * 状态转换守卫（SA-00 §4.1 的唯一事实源落地）。
 *
 * 只做两件事：合法出边判定（`assertTransition`）与终态判定（`isTerminal`）。
 * 运行期推进只允许「先 assertTransition 校验、再用 reduceSaga 的结果 casState 落库」。
 */

import { BahError } from '@bah/util'

import { TERMINAL_STATES } from '../types.ts'

import type { SagaStore } from '../seams.ts'
import type { SagaState, TerminalState } from '../types.ts'

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

/**
 * 断言一条状态出边合法。
 *
 * @throws `BahError('illegal-transition')` 非法出边
 */
export function assertTransition(from: SagaState, to: SagaState): void {
  if (SAGA_TRANSITIONS[from].includes(to)) return
  throw new BahError('illegal-transition', `bah-saga: illegal-transition: ${from} -> ${to}`, {
    from,
    to,
  })
}

/** 是否终态（无出边）。 */
export function isTerminal(state: SagaState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state)
}

/**
 * version CAS 推进（M2）：非法出边**先拦后写**，库外不产生半写。
 *
 * `to` 必须来自唯一转移函数 `reduceSaga` 的推断（不得另写转移语义）；
 * 并发两方同读 `version` 时，仅一方 `casState` 返回 true。
 *
 * @throws `BahError('illegal-transition')` 非法出边
 * @throws `BahError('version-conflict')` CAS 失败
 */
export function advance(
  store: SagaStore,
  sagaId: string,
  from: SagaState,
  to: SagaState,
  version: number,
  at: number,
): void {
  assertTransition(from, to)
  if (!store.casState(sagaId, from, to, version, at)) {
    throw new BahError('version-conflict', `bah-saga: version-conflict: ${sagaId}@v${version}`, {
      sagaId,
      version,
      from,
      to,
    })
  }
}

export { initialProjection, reduceSaga } from './reduce.ts'
