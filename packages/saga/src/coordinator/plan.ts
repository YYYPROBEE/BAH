/**
 * 计划期落账（SA-08 §3.5）：建事务 + 步骤 + `saga/created` / `saga/step-planned`（同提交段）。
 *
 * `initiator` 明文不进事件流：`saga_transaction.initiator` 只存脱敏 JSON，
 * 事件载荷按 SA-07 §5 冻结形态**不含** initiator。
 */

import { BahError } from '@bah/util'

import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE } from '../seams.ts'

import { commitSegment } from './commit.ts'

import type { Context } from '@bah/core'

import type { SagaSettings, SideEffectClass } from '../types.ts'

/** 计划期的一步。 */
export interface PlannedStep {
  readonly stepId: string
  readonly seqNo: number
  readonly toolName: string
  readonly endpoint: string
  readonly sideEffectClass: SideEffectClass
  /** 计划期生成的双键幂等键（命名空间 FWD）。 */
  readonly idemKey: string
  readonly nonce: string
  readonly topologyDeps: readonly string[]
  readonly deadlineMs: number
}

/** 计划期输入。 */
export interface SagaPlan {
  readonly sagaId: string
  readonly businessType: string
  readonly traceId: string
  readonly timeoutBudgetMs: number
  readonly initiator: string
  readonly steps: readonly PlannedStep[]
  /**
   * 父 saga（只由修正 saga 使用，SA-12 I11）。
   *
   * 追加为可选字段：不改变既有调用方的语义，也不占用任何冻结面。
   */
  readonly parentSagaId?: string
}

/** 落计划：事务从 `CREATED` 起步，同段 CAS 到 `RUNNING` 后派发 `saga/created`。 */
export function planSaga(ctx: Context, plan: SagaPlan, settings: SagaSettings): void {
  const store = ctx.get(SAGA_STORE)
  const audit = ctx.get(SAGA_AUDIT)
  const at = ctx.get(SAGA_CLOCK).now()

  commitSegment(ctx, (tx) => {
    tx.insertTransaction({
      sagaId: plan.sagaId,
      ...(plan.parentSagaId === undefined ? {} : { parentSagaId: plan.parentSagaId }),
      businessType: plan.businessType,
      traceId: plan.traceId,
      state: 'CREATED',
      version: 1,
      timeoutBudgetMs: plan.timeoutBudgetMs,
      compStrategy: 'AUTO',
      initiator: JSON.stringify({ initiator: plan.initiator }),
      frozen: false,
      createdAt: at,
      updatedAt: at,
    })

    for (const step of plan.steps) {
      tx.insertStep({
        stepId: step.stepId,
        sagaId: plan.sagaId,
        seqNo: step.seqNo,
        topologyDeps: [...step.topologyDeps],
        toolName: step.toolName,
        endpoint: step.endpoint,
        sideEffectClass: step.sideEffectClass,
        idempotencyKey: step.idemKey,
        idempotencyNonce: step.nonce,
        state: 'PLANNED',
        attempts: 0,
        maxAttempts: settings.maxAttempts,
        deadlineMs: step.deadlineMs,
      })
    }

    audit.append(plan.sagaId, 'saga/created', {
      sagaId: plan.sagaId,
      businessType: plan.businessType,
      traceId: plan.traceId,
      timeoutBudgetMs: plan.timeoutBudgetMs,
    })

    for (const step of plan.steps) {
      audit.append(plan.sagaId, 'saga/step-planned', {
        sagaId: plan.sagaId,
        stepId: step.stepId,
        seqNo: step.seqNo,
        toolName: step.toolName,
        sideEffectClass: step.sideEffectClass,
        idemKey: step.idemKey,
      })
    }

    if (!store.casState(plan.sagaId, 'CREATED', 'RUNNING', 1, at)) {
      throw new BahError(
        'version-conflict',
        `bah-saga: version-conflict: ${plan.sagaId} 建期 CAS 失败`,
        { sagaId: plan.sagaId },
      )
    }
  })

  ctx.events.emit('saga/created', {
    sagaId: plan.sagaId,
    businessType: plan.businessType,
    traceId: plan.traceId,
    timeoutBudgetMs: plan.timeoutBudgetMs,
  })

  for (const step of plan.steps) {
    ctx.events.emit('saga/step-planned', {
      sagaId: plan.sagaId,
      stepId: step.stepId,
      seqNo: step.seqNo,
      toolName: step.toolName,
      sideEffectClass: step.sideEffectClass,
      idemKey: step.idemKey,
    })
  }
}
