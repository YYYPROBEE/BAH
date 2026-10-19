/**
 * 三锚点崩溃恢复（SA-08 §3.4 / O15）。
 *
 * 启动扫 `activeSagas()`（`idx_saga_active` 命中），按
 * (step.state, idempotency_record, comp 绑定) 分派：
 * - `CALLING` / `UNKNOWN` → 探诊（B1）或 DLQ（B0）；
 * - `EXECUTED` → 重放跳过（**绝不重发**）；
 * - `PLANNED` → 交回调度器正常发起（不落 `saga/recovered`）。
 *
 * 本函数只做**分派与落账**；探诊执行属 SA-09 批 3，补偿绑定属 SA-10。
 * 因此恢复本身不含任何外部调用，可在启动期同步执行。
 */

import { assertNever } from '@bah/util'

import { SAGA_AUDIT, SAGA_STORE } from '../seams.ts'

import type { Context } from '@bah/core'

import type { IdempotencyRecord, SagaSettings, SagaStep, StepState } from '../types.ts'

/** 恢复动作。 */
export type RecoveryAction = 'probe' | 'dlq' | 'skip-executed' | 'reissue' | 'none'

/** 恢复报告。 */
export interface RecoveryReport {
  readonly scanned: number
  readonly dispatched: Readonly<Record<RecoveryAction, number>>
}

/** 锚点二：幂等记录（锚点三 comp 绑定由 SA-10 提供，批 2 恒为 undefined）。 */
function anchors(
  ctx: Context,
  step: SagaStep,
): { idem: IdempotencyRecord | undefined; comp: string | undefined } {
  const idem = ctx.get(SAGA_STORE).tx((tx) => tx.readIdempotency(step.idempotencyKey))
  return { idem, comp: undefined }
}

/** 分派规则（PLANNED 返回 undefined：只计入 reissue）。 */
function dispatchOf(
  state: StepState,
  b1: boolean,
): { from: 'CALLING' | 'UNKNOWN' | 'EXECUTED'; action: RecoveryAction } | undefined {
  switch (state) {
    case 'CALLING':
    case 'UNKNOWN':
      return { from: state, action: b1 ? 'probe' : 'dlq' }
    case 'EXECUTED':
      return { from: 'EXECUTED', action: 'skip-executed' }
    case 'PLANNED':
      return undefined
    case 'FAILED':
    case 'SKIPPED':
    case 'PROBING':
    case 'UNRESOLVED':
    case 'COMP_ISSUED':
    case 'COMPENSATED':
      return undefined
    default:
      return assertNever(state, 'recovery-dispatch')
  }
}

/** 扫描全部非终态 saga 并落 `saga/recovered`（不改步骤/事务状态）。 */
export function recoverAll(ctx: Context, settings: SagaSettings): RecoveryReport {
  const store = ctx.get(SAGA_STORE)
  const audit = ctx.get(SAGA_AUDIT)
  const dispatched: Record<RecoveryAction, number> = {
    probe: 0,
    dlq: 0,
    'skip-executed': 0,
    reissue: 0,
    none: 0,
  }

  const sagas = store.activeSagas()
  for (const sagaId of sagas) {
    for (const step of store.listSteps(sagaId)) {
      const plan = dispatchOf(step.state, settings.features.b1)
      if (plan === undefined) {
        if (step.state === 'PLANNED') dispatched.reissue += 1
        continue
      }

      // 锚点二校验：CALLING/UNKNOWN 必须有幂等记录，否则存储错配 → 转 DLQ 人工。
      let action = plan.action
      if (action !== 'skip-executed' && anchors(ctx, step).idem === undefined) action = 'dlq'
      dispatched[action] += 1

      audit.append(sagaId, 'saga/recovered', {
        sagaId,
        stepId: step.stepId,
        from: plan.from,
        action,
      })
      ctx.events.emit('saga/recovered', {
        sagaId,
        stepId: step.stepId,
        from: plan.from,
        action,
      })
    }
  }

  return { scanned: sagas.length, dispatched }
}
