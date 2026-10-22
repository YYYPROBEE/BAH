/**
 * L2 协调器（SA-08 §3.2 / §3.3）。
 *
 * 正向主循环：READY 步骤并发（上限 `maxParallelBranches`）→ barrier 汇聚 → 直至静默或终态。
 * 状态推进只经 `casState`；每步的「步推进 + 审计 append + 幂等回填」在**同一提交段**完成。
 */

import { BahError } from '@bah/util'

import { SAGA_AUDIT, SAGA_CLOCK, SAGA_IDEMPOTENCY, SAGA_STEP_CONTEXT, SAGA_STORE } from '../seams.ts'
import { type CompensationDeps, runCompensation } from '../compensation/index.ts'
import { mustDeadLetter } from '../probe/classify.ts'
import { escalateToDlq } from '../probe/settle.ts'
import { advance, isTerminal } from '../state-machine/index.ts'
import { commitSegment } from './commit.ts'

import type { Context } from '@bah/core'

import type { SagaSettings, SagaStep, SagaTransaction, StepState } from '../types.ts'

export { commitSegment } from './commit.ts'
export { planSaga } from './plan.ts'
export type { PlannedStep, SagaPlan } from './plan.ts'

/** 外部调用派发面：B0 用 mock；B1 后接幂等信封；B2 后接七段工具管线（SA-10/13）。 */
export type CallDispatcher = (step: SagaStep) => Promise<CallOutcome>

/** 单步调用结果。 */
export type CallOutcome =
  | { readonly kind: 'ok'; readonly responseDigest: string }
  | { readonly kind: 'err'; readonly code: string }
  | { readonly kind: 'unknown'; readonly code: string }

/** 协调器依赖。 */
export interface CoordinatorDeps {
  readonly settings: SagaSettings
  readonly dispatch: CallDispatcher
  /**
   * 补偿调用 / 探诊通道（SA-10 §3.2）。
   *
   * 省略时失败结算只 CAS 到 `COMPENSATING`、不发射补偿（批 4 之前的兼容路径）；
   * 自动补偿必须由调用方注入——没有通道就不得假装补偿成功。
   */
  readonly compensation?: CompensationDeps
}

/** 已收敛的 step 状态（READY 与完成判定共用）。 */
const SETTLED: ReadonlySet<StepState> = new Set<StepState>(['EXECUTED', 'SKIPPED'])

/** 租约时长（毫秒）；恢复扫描按租约过期接管。 */
const LEASE_TTL_MS = 60_000

/** READY = 自身 PLANNED 且全部 topology_deps 已收敛。 */
export function readySteps(steps: readonly SagaStep[]): readonly SagaStep[] {
  const done = new Set(steps.filter((step) => SETTLED.has(step.state)).map((step) => step.stepId))
  return steps.filter((step) => step.state === 'PLANNED' && step.topologyDeps.every((dep) => done.has(dep)))
}

/** 正向主循环。 */
export async function runSaga(ctx: Context, sagaId: string, deps: CoordinatorDeps): Promise<void> {
  const store = ctx.get(SAGA_STORE)
  for (;;) {
    const snapshot = store.loadTransaction(sagaId)
    if (snapshot === undefined) {
      throw new BahError('saga-missing', `bah-saga: saga-missing: ${sagaId}`, { sagaId })
    }
    if (isTerminal(snapshot.state)) return
    if (snapshot.frozen) return
    const ready = readySteps(store.listSteps(sagaId))
    if (ready.length === 0) return
    const outcomes = await mapPool(ready, deps.settings.maxParallelBranches, (step) =>
      runStep(ctx, sagaId, step, deps),
    )
    await settleSaga(ctx, sagaId, snapshot, outcomes, deps)
  }
}

/**
 * 并发池：发起数严格 ≤ limit（结果顺序 = 入参顺序）。
 *
 * 失败语义：**先让所有分支跑完，再抛第一个失败**。不能用 `Promise.all` 的快速失败——
 * 那会让其余补偿分支变成孤儿写入（还在跑，但事务已经按失败收尾），
 * 甚至可能改写已经收敛的终态。
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  let failure: { readonly error: unknown } | undefined
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        out[index] = await run(items[index] as T)
      } catch (error) {
        failure ??= { error }
      }
    }
  })
  await Promise.all(workers)
  if (failure !== undefined) throw failure.error
  return out
}

/** 单步执行：预写 CALLING + 幂等预占 → 派发 → 终态落账。 */
async function runStep(
  ctx: Context,
  sagaId: string,
  step: SagaStep,
  deps: CoordinatorDeps,
): Promise<CallOutcome> {
  const idem = ctx.get(SAGA_IDEMPOTENCY)
  const at = ctx.get(SAGA_CLOCK).now()

  // 重试硬停（SA-09 §3.5 / M5 / A23）：达上限即 DLQ，**不再派发**；不可配置关闭。
  if (mustDeadLetter(step.attempts, step.maxAttempts)) {
    escalateToDlq(ctx, {
      sagaId,
      stepId: step.stepId,
      source: 'step',
      reason: 'max-attempts',
      slaDeadline: at + deps.settings.hardSlaMs,
    })
    const outcome: CallOutcome = { kind: 'err', code: 'max-attempts' }
    commitSegment(ctx, (tx) => {
      tx.updateStep({ ...step, state: 'UNRESOLVED' })
      ctx.get(SAGA_AUDIT).append(sagaId, 'saga/call-result', {
        sagaId,
        stepId: step.stepId,
        outcome: outcome.kind,
        requestDigest: step.requestDigest ?? '',
      })
    })
    ctx.events.emit('saga/call-result', {
      sagaId,
      stepId: step.stepId,
      outcome: outcome.kind,
      requestDigest: step.requestDigest ?? '',
    })
    return outcome
  }

  const attempts = step.attempts + 1

  let reserved: { ok: true } | { ok: false; reason: 'lease-held' | 'key-conflict' }
  try {
    reserved = commitSegment(ctx, (tx) => {
      tx.updateStep({ ...step, state: 'CALLING', attempts })
      return idem.reserveIn(
        tx,
        step.idempotencyKey,
        {
          idemKey: step.idempotencyKey,
          namespace: 'FWD',
          sagaId,
          targetSystem: step.toolName,
          requestDigest: step.requestDigest ?? '',
          status: 'RESERVED',
          leaseOwner: 'coordinator',
          leaseExpiry: at + LEASE_TTL_MS,
        },
        LEASE_TTL_MS,
      )
    })
  } catch {
    // 预写失败：状态由 sqlite 回滚，交给恢复扫描；不发起外部调用。
    return { kind: 'unknown', code: 'prewrite-failed' }
  }

  if (!reserved.ok) {
    // 键被占用 / 同键异载：不硬抢、不派发（防双发）。
    const outcome: CallOutcome = { kind: 'unknown', code: reserved.reason }
    commitSegment(ctx, (tx) => {
      tx.updateStep({ ...step, state: 'UNKNOWN', attempts })
      ctx.get(SAGA_AUDIT).append(sagaId, 'saga/call-result', {
        sagaId,
        stepId: step.stepId,
        outcome: outcome.kind,
        requestDigest: step.requestDigest ?? '',
      })
    })
    ctx.events.emit('saga/call-result', {
      sagaId,
      stepId: step.stepId,
      outcome: outcome.kind,
      requestDigest: step.requestDigest ?? '',
    })
    return outcome
  }

  let outcome: CallOutcome
  const disposer = ctx.scope.set(SAGA_STEP_CONTEXT, { sagaId, stepId: step.stepId })
  try {
    outcome = await deps.dispatch(step)
  } catch (error) {
    outcome = {
      kind: 'unknown',
      code: error instanceof Error ? error.message : String(error),
    }
  } finally {
    disposer()
  }

  commitSegment(ctx, (tx) => {
    const next: StepState =
      outcome.kind === 'ok' ? 'EXECUTED' : outcome.kind === 'unknown' ? 'UNKNOWN' : 'FAILED'
    tx.updateStep({
      ...step,
      state: next,
      attempts,
      ...(outcome.kind === 'ok' ? { responseDigest: outcome.responseDigest } : {}),
    })
    if (outcome.kind === 'ok') {
      idem.completeIn(tx, step.idempotencyKey, outcome.responseDigest, '')
    }
    ctx.get(SAGA_AUDIT).append(sagaId, 'saga/call-result', {
      sagaId,
      stepId: step.stepId,
      outcome: outcome.kind,
      requestDigest: step.requestDigest ?? '',
      ...(outcome.kind === 'ok' ? { responseDigest: outcome.responseDigest } : {}),
    })
  })

  ctx.events.emit('saga/call-result', {
    sagaId,
    stepId: step.stepId,
    outcome: outcome.kind,
    requestDigest: step.requestDigest ?? '',
    ...(outcome.kind === 'ok' ? { responseDigest: outcome.responseDigest } : {}),
  })

  return outcome
}

/**
 * barrier 汇聚：全部 ok 且全部步骤收敛 → SUCCEEDED；
 * 任一非 ok → 落 `saga/comp-decided` 并 CAS 到 COMPENSATING（补偿执行属 SA-10）。
 */
async function settleSaga(
  ctx: Context,
  sagaId: string,
  snapshot: SagaTransaction,
  outcomes: readonly CallOutcome[],
  deps: CoordinatorDeps,
): Promise<void> {
  const store = ctx.get(SAGA_STORE)
  const at = ctx.get(SAGA_CLOCK).now()
  const steps = store.listSteps(sagaId)

  if (outcomes.every((outcome) => outcome.kind === 'ok') && steps.every((step) => SETTLED.has(step.state))) {
    advance(store, sagaId, 'RUNNING', 'SUCCEEDED', snapshot.version, at)
    return
  }

  const failedIndex = outcomes.findIndex((outcome) => outcome.kind !== 'ok')
  if (failedIndex < 0) return
  const failedStep = steps.find((step) => !SETTLED.has(step.state))
  const failedOutcome = outcomes[failedIndex] as CallOutcome
  const payload = {
    sagaId,
    stepId: failedStep?.stepId ?? '',
    decide: 'compensate' as const,
    reason: failedOutcome.kind === 'err' ? failedOutcome.code : 'unknown',
  }

  // 治理平面可拦截自动补偿（SA-10）；批 2 无监听器时原样放行。
  const decision = await ctx.events.waterfall('saga/comp-decided', payload)
  const to =
    decision.decide === 'hold'
      ? 'GATE_HOLDING'
      : decision.decide === 'manual'
        ? 'COMPENSATION_DLQ'
        : 'COMPENSATING'
  commitSegment(ctx, (tx) => {
    ctx.get(SAGA_AUDIT).append(sagaId, 'saga/comp-decided', {
      sagaId,
      stepId: payload.stepId,
      decide: decision.decide,
      reason: payload.reason,
    })
    if (!tx.casState(sagaId, 'RUNNING', to, snapshot.version, at)) {
      throw new BahError('version-conflict', `bah-saga: version-conflict: ${sagaId}@v${snapshot.version}`, {
        sagaId,
        version: snapshot.version,
      })
    }
  })

  // SA-10 §3.2：自动路径在结算段之后直接进入反向屏障补偿；手动路径复用 issueComp。
  if (to === 'COMPENSATING' && deps.compensation !== undefined) {
    await runCompensation(ctx, sagaId, deps.settings, deps.compensation)
  }
}
