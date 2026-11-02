/**
 * 对称收敛子流程与 DLQ（SA-09 §3.5，批 3）。
 *
 * R3.8：正向（`FWD`）与补偿（`COMP`）走**同一** `settleCall`——同一套幂等占位、
 * 同一套错误分类、同一套探诊收敛。补偿读超时经探诊判 `executed` 后不再二次退款。
 *
 * UNRESOLVED → `dlq_entry` + `suspension_ticket`，与审计 append 同提交段落账；
 * **禁止自动补偿**（SA-00 §7 `probe-unresolved` / `unknown-target`）。
 */

import { commitSegment } from '../coordinator/commit.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_IDEMPOTENCY } from '../seams.ts'

import { classify } from './classify.ts'
import { probeStep } from './index.ts'

import type { Context } from '@bah/core'

import type { SagaSettings } from '../types.ts'
import type { ProbeTransport, StepRef } from './index.ts'

/** 一次外部调用的观测结果。 */
export type CallOutcome =
  | { readonly kind: 'ok'; readonly responseDigest?: string }
  | { readonly kind: 'err'; readonly code: string }
  | { readonly kind: 'unknown'; readonly code: string }

/** 收敛输入：正向与补偿仅命名空间不同。 */
export interface SettleInput {
  readonly namespace: 'FWD' | 'COMP'
  readonly ref: StepRef
  readonly nonce: string
  readonly requestDigest: string
  /** 正向调用 or 补偿调用（同一调用面）。 */
  readonly invoke: (signal: AbortSignal) => Promise<CallOutcome>
}

/**
 * 正向 / 补偿对称收敛（R3.8，防双扣亦防双退）。
 *
 * 本函数没有外层事务 → 用便利版 `reserve` / `complete`；
 * 调用方若已在 `store.tx` 内，须改用 `reserveIn` / `completeIn`（禁嵌套）。
 */
export async function settleCall(
  ctx: Context,
  input: SettleInput,
  transport: ProbeTransport,
  settings: SagaSettings,
): Promise<CallOutcome | { readonly kind: 'unresolved'; readonly reason: string }> {
  const idem = ctx.get(SAGA_IDEMPOTENCY)
  // 双键：仅命名空间不同（FWD vs COMP），同一 (sagaId, stepId) + nonce 才能重建。
  const key = idem.makeKey(input.namespace, input.ref.sagaId, input.ref.stepId, input.nonce)

  const reserved = idem.reserve(
    key,
    {
      idemKey: key,
      namespace: input.namespace,
      sagaId: input.ref.sagaId,
      targetSystem: input.ref.toolName,
      requestDigest: input.requestDigest,
      status: 'RESERVED',
    },
    60_000,
  )
  if (!reserved.ok) {
    // lease-held / key-conflict → 不硬抢；上层等待/换 worker。
    return { kind: 'unknown', code: reserved.reason }
  }

  const outcome = await input.invoke(AbortSignal.timeout(settings.probeTimeoutMs))
  if (outcome.kind === 'ok') {
    idem.complete(key, outcome.responseDigest ?? '', '')
    return outcome
  }

  if (outcome.kind === 'err') {
    const failure = classify(outcome.code)
    if (failure.kind === 'retryable') return outcome // 退避重试（同键）
    if (failure.kind !== 'unresolved') return outcome // 其余 ERR → 补偿判定（SA-10）
  }

  // unknown 或含糊错误 → 探诊消解；补偿路径同样走此 → 只退一次。
  const verdict = await probeStep(ctx, input.ref, transport, settings)
  if (verdict.kind === 'executed') {
    // 外部已执行：回填幂等行，后续同键重放不会再次调用。
    idem.complete(key, verdict.responseDigest, '')
    return { kind: 'ok', responseDigest: verdict.responseDigest }
  }
  if (verdict.kind === 'not-executed') return { kind: 'unknown', code: 'NOT_EXECUTED' }
  return { kind: 'unresolved', reason: verdict.reason }
}

/** DLQ 升级输入。 */
export interface EscalateInput {
  readonly sagaId: string
  readonly stepId?: string
  readonly source: 'step' | 'probe' | 'comp'
  readonly reason: string
  readonly slaDeadline: number
}

/**
 * UNRESOLVED → DLQ 表 + 工单，同时落 `saga/dlq-escalated`。
 *
 * 同 `(sagaId, stepId | source)` 重复升级是幂等的：已存在则不再插入/记账。
 *
 * @returns `dlqId`
 */
export function escalateToDlq(ctx: Context, input: EscalateInput): string {
  const audit = ctx.get(SAGA_AUDIT)
  const now = ctx.get(SAGA_CLOCK).now()
  const dlqId = `dlq:${input.sagaId}:${input.stepId ?? input.source}`
  const ticketId = `ticket:${dlqId}`
  const entrySource = input.source === 'comp' ? 'COMP' : input.source === 'probe' ? 'PROBE' : 'STEP'
  let inserted = false

  commitSegment(ctx, (tx) => {
    if (tx.readDlq(dlqId) !== undefined) return
    tx.insertDlq({
      dlqId,
      sagaId: input.sagaId,
      source: entrySource,
      reason: input.reason,
      enteredAt: now,
      slaDeadline: input.slaDeadline,
    })
    if (tx.readTicket(ticketId) === undefined) {
      tx.insertTicket({
        ticketId,
        sagaId: input.sagaId,
        reason: 'UNRESOLVED',
        slaDeadline: input.slaDeadline,
      })
    }
    audit.append(input.sagaId, 'saga/dlq-escalated', {
      sagaId: input.sagaId,
      dlqId,
      source: input.source,
      reason: input.reason,
      slaDeadline: input.slaDeadline,
    })
    inserted = true
  })

  if (inserted) {
    ctx.events.emit('saga/dlq-escalated', {
      sagaId: input.sagaId,
      dlqId,
      source: input.source,
      reason: input.reason,
      slaDeadline: input.slaDeadline,
    })
  }
  return dlqId
}
