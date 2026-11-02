/**
 * 修正 saga（SA-12 §3.2 / I11，批 5）。
 *
 * 复用 SA-08 的 `planSaga` 建路径，不另起炉灶：
 * - `parent_saga_id` = 原 saga；
 * - `business_type = 'AMENDMENT_COMPENSATION'`；
 * - 模板 = **原绑定复用**（读回计划期冻结版本，不重新选版）；
 * - 幂等键 = `COMP` 命名空间 + 不可预测 nonce（M3/A13）。
 */

import { BahError } from '@bah/util'

import { planSaga } from '../coordinator/plan.ts'
import { makeNonce } from '../idempotency/index.ts'
import { SAGA_CLOCK, SAGA_IDEMPOTENCY, SAGA_STORE, SAGA_TEMPLATES } from '../seams.ts'

import type { Context } from '@bah/core'
import type { SagaSettings } from '../types.ts'
import type { ExternalStatementRow } from './types.ts'

/**
 * 建一个修正 saga，返回新 sagaId。
 *
 * @throws `BahError('saga-missing')` 外部对账单给出的悬垂步骤在本地不存在
 */
export function createAmendmentSaga(
  ctx: Context,
  settings: SagaSettings,
  row: ExternalStatementRow,
): string {
  const store = ctx.get(SAGA_STORE)
  const templates = ctx.get(SAGA_TEMPLATES)
  const idem = ctx.get(SAGA_IDEMPOTENCY)
  const original = store.loadTransaction(row.sagaId)
  const originalSteps = store.listSteps(row.sagaId)
  const amendmentId = `amend-${row.sagaId}-${ctx.get(SAGA_CLOCK).now()}`

  const steps = row.danglingEffects.map((stepId, index) => {
    const origin = originalSteps.find((step) => step.stepId === stepId)
    if (origin === undefined) {
      throw new BahError(
        'saga-missing',
        `bah-saga: saga-missing: ${row.sagaId} 无步骤 ${stepId}`,
        { sagaId: row.sagaId, stepId },
      )
    }
    const nonce = makeNonce()
    // `saga_step.step_id` 是全局主键：修正 saga 不能复用原 step_id，
    // 否则 `UNIQUE constraint failed`。原 id 只用于读回真实工具名/端点。
    const amendmentStepId = `${amendmentId}--${stepId}`
    return {
      stepId: amendmentStepId,
      seqNo: index,
      // 必须取原步骤真实 toolName / endpoint：写成 templateId 会让 findActive 落空。
      toolName: origin.toolName,
      endpoint: origin.endpoint,
      sideEffectClass: 'EXTERNAL_UNDOABLE' as const,
      idemKey: idem.makeKey('COMP', amendmentId, amendmentStepId, nonce),
      nonce,
      topologyDeps: [] as readonly string[],
      deadlineMs: settings.forceCloseMs,
    }
  })

  planSaga(
    ctx,
    {
      sagaId: amendmentId,
      parentSagaId: row.sagaId,
      businessType: 'AMENDMENT_COMPENSATION',
      traceId: `${original?.traceId ?? row.sagaId}-amend`,
      timeoutBudgetMs: settings.forceCloseMs,
      initiator: 'recon-operator',
      steps,
    },
    settings,
  )

  // 模板 = 原绑定复用（版本冻结跟随）：禁止 findActive 取最新版。
  for (const stepId of row.danglingEffects) {
    const bound = templates.boundFor(row.sagaId, stepId)
    if (bound !== undefined) templates.bind(amendmentId, `${amendmentId}--${stepId}`, bound)
  }

  return amendmentId
}
