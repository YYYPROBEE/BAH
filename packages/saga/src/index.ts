/**
 * `@bah/saga` 包入口：装配函数 + 公开类型 + 服务键（SA-07 §2.3）。
 *
 * 纪律：跨包只认服务键与事件名（SA-00 §4.5）。
 */

import { page, provideAlertBus } from './alert/index.ts'
import { noopAlertSink } from './alert/sink.ts'
import { installGates } from './gates/index.ts'
import { installIdempotency } from './idempotency/index.ts'
import { runJanitor } from './janitor/index.ts'
import { runReconJob } from './recon/index.ts'
import { SAGA_AUDIT, SAGA_CLOCK } from './seams.ts'
import { installTemplates } from './templates/index.ts'
import { installTick } from './tick/index.ts'
import { registerTickJob } from './tick/registry.ts'

import type { Context } from '@bah/core'

import type { AlertSink } from './alert/sink.ts'
import type { ForceCloseManifest } from './janitor/index.ts'
import type { ExternalStatement, ReconDeps } from './recon/index.ts'
import type { SagaClock } from './seams.ts'
import type { SagaSettings } from './types.ts'

export {
  SAGA_STORE,
  SAGA_AUDIT,
  SAGA_CLOCK,
  SAGA_TEMPLATES,
  SAGA_IDEMPOTENCY,
  TARGET_REGISTRY,
  SAGA_STEP_CONTEXT,
  SAGA_EVENT_KEYS,
} from './seams.ts'

export type {
  SagaStore,
  SagaTx,
  SagaAudit,
  SagaClock,
  SagaTemplates,
  SagaIdempotency,
  TargetRegistry,
  SagaEventKey,
} from './seams.ts'

export type {
  SagaState,
  TerminalState,
  StepState,
  CompState,
  SideEffectClass,
  CompKind,
  CompStrategy,
  IdemNamespace,
  SagaTransaction,
  SagaStep,
  CompensatingAction,
  CompTemplate,
  IdempotencyRecord,
  TargetSystem,
  DlqEntry,
  SuspensionTicket,
  ResidualLedgerEntry,
  StateSnapshot,
  VaultSensitive,
  PayloadProjection,
  PayloadFieldRule,
  SagaProjection,
  SagaEventRecord,
  ReduceSaga,
  CompBackoffSettings,
  SagaFeatureFlags,
  SagaSettings,
} from './types.ts'

export { SAGA_STATES, TERMINAL_STATES, STEP_STATES, COMP_STATES } from './types.ts'
export {
  advance,
  assertTransition,
  canTransition,
  initialProjection,
  isTerminal,
  reduceSaga,
  SAGA_TRANSITIONS,
} from './state-machine/index.ts'
export { SAGA_FINAL_SUBJECT_PREFIX } from './state-machine/reduce.ts'
export { parseSagaSettings } from './settings.ts'
export { commitSegment, planSaga, runSaga, mapPool, readySteps } from './coordinator/index.ts'
export type { CallDispatcher, CallOutcome, CoordinatorDeps, PlannedStep, SagaPlan } from './coordinator/index.ts'
export { recoverAll } from './recovery/index.ts'
export type { RecoveryAction, RecoveryReport } from './recovery/index.ts'
export { installIdempotency, makeKey, makeNonce, reserveInTx, seed } from './idempotency/index.ts'
export {
  bindAtPlan,
  installTemplates,
  projectPayload,
  registerTemplate,
  validateTemplate,
} from './templates/index.ts'
export {
  barrierCheck,
  compBackoffDelay,
  downstreamOf,
  issueComp,
  reverseLayers,
  runCompensation,
} from './compensation/index.ts'
export type { CompensationDeps, CompensationInvocation } from './compensation/index.ts'
export {
  assertManualOnlyTail,
  assertNotModelVisible,
  buildTraceparent,
  checkBusinessRule,
  checkRisk,
  checkSchema,
  compensationEndpointName,
  dlqDepthVerdict,
  installDlqAlerts,
  installGates,
  provideParamGates,
  provideTraceparentInjection,
  spanIdOf,
  submitDecision,
  toW3cTraceId,
  traceparentOf,
  withTraceparent,
} from './gates/index.ts'
export type { DecisionOutcome, ParamGateName, ParamGateVerdict, StaleDetail } from './gates/index.ts'
export { probeStep } from './probe/index.ts'
export type { ProbeObservation, ProbeTransport, ProbeVerdict, StepRef } from './probe/index.ts'
export { classify, mustDeadLetter, RETRYABLE } from './probe/classify.ts'
export type { FailureClass } from './probe/classify.ts'
export { escalateToDlq, settleCall } from './probe/settle.ts'
export type { EscalateInput, SettleInput, CallOutcome as SettleCallOutcome } from './probe/settle.ts'
export { noopAlertSink } from './alert/sink.ts'
export type { AlertLevel, AlertSink } from './alert/sink.ts'
export { forceClose, hardEscalationIds, runJanitor } from './janitor/index.ts'
export type { ForceCloseManifest, JanitorCounts } from './janitor/index.ts'
export {
  createAmendmentSaga,
  isDrillWindow,
  reconcileBatch,
  reconPeriodOf,
  runReconJob,
} from './recon/index.ts'
export type {
  ChainRow,
  ExternalStatement,
  ExternalStatementRow,
  ReconBatch,
  ReconDeps,
  ReconJobOptions,
  ReconJobResult,
  ReconResult,
} from './recon/index.ts'
export {
  dayEndResidualDiff,
  recordResidual,
  RESIDUAL_ALERT_RATE,
  RESIDUAL_P0_RATE,
  RESIDUAL_WHITELIST,
} from './recon/residual.ts'
export type {
  ResidualInput,
  ResidualStatement,
  ResidualStatementRow,
} from './recon/residual.ts'
export {
  hasTickJob,
  lastJobHeartbeat,
  recordJobHeartbeat,
  registerTickJob,
  runTickJob,
  unregisterTickJob,
} from './tick/registry.ts'
export type { TickJobName } from './tick/registry.ts'
export { dispatchTick, hasRunTick, installTick } from './tick/index.ts'
export type { TickPayload } from './tick/index.ts'

export {
  alertSoft,
  checkChainHealth,
  collectSloMetrics,
  emitAlert,
  heartbeat,
  legacyAlertSink,
  page,
  provideAlertBus,
  registerAlertSink,
  sloVerdict,
  SLO_METRICS,
} from './alert/index.ts'
export type {
  AlertBus,
  AlertEvent,
  AlertEventSink,
  SloMetric,
  SloObservations,
  SloSample,
} from './alert/index.ts'

export {
  bucketOf,
  buildApprovalCard,
  FIVE_STATE_BUCKETS,
  listSagas,
  sagaTimeline,
} from './view/index.ts'
export type {
  ApprovalCardData,
  ApprovalCardInput,
  FiveStateBucket,
  SagaTimelineRow,
} from './view/index.ts'
export { causalDag, isAcyclic } from './view/causality.ts'
export type { CausalDag, CausalEdge, CausalNode } from './view/causality.ts'

export { assertReplayDiffZero, replay, replayDiff } from './replay/index.ts'
export type { ReplayDeps, ReplayResult } from './replay/index.ts'

/** 默认系统时钟：生产路径的唯一时间来源；测试注入 `SagaClock` 覆盖。 */
export const systemClock: SagaClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * 装配 saga 插件（host 侧的 `apply` 调用它；默认值已由 host 的 validate 补齐）。
 *
 * 批 2 注册确定性时钟与幂等信封；存储/审计由独立插件提供，幂等实现按服务键惰性取用。
 * 启动期恢复需要存储与审计同时就绪，由 host 侧用 `ctx.whenReady` 调度（见 saga 插件）。
 */
export function provideSaga(ctx: Context, settings: SagaSettings): void {
  ctx.provide(SAGA_CLOCK, systemClock)
  installIdempotency(ctx)
  installTemplates(ctx)
  // 工具面治理（三道闸 / traceparent）与模板注册同属 b2 批次特性；
  // 关开关即回滚挂点，DDL 不回滚（SA-00 §10）。
  if (settings.features.b2) {
    ctx.effect(installGates(ctx))
  }
  // SA-13：告警总线 + `saga/tick` 唯一派发点 + anchor job（批 6）。
  if (settings.features.b4) {
    installObservability(ctx, settings)
  }
}

/**
 * 观测面装配（SA-13 §3.4 / §3.5）：
 * - 告警汇 + 真实 DLQ 升级监听；
 * - `saga/tick` 唯一 `serial` 派发点；
 * - anchor job 登记（period 按 UTC 月度；重复锚定由 anchor 自身幂等）。
 *
 * 只登记，不立即执行；janitor / recon 仍由 `installConvergence` 登记。
 */
export function installObservability(ctx: Context, settings: SagaSettings): void {
  provideAlertBus(ctx, settings)
  installTick(ctx)
  ctx.effect(
    registerTickJob('anchor', () => {
      const at = ctx.get(SAGA_CLOCK).now()
      const period = new Date(at).toISOString().slice(0, 7)
      void ctx
        .get(SAGA_AUDIT)
        .anchor(period)
        .catch((error: unknown) => {
          page(ctx, 'P0', `anchor-failed:${error instanceof Error ? error.message : String(error)}`)
        })
    }),
  )
}

/**
 * 收敛闭环装配（SA-12 §3.4，批 5）。
 *
 * 只登记 janitor / recon 两个 job；`saga/tick` 的唯一派发点与 host 的
 * `ReconDeps` / 对账单注入属批 6。`features.b3` 关闭即回滚挂点。
 *
 * 注意：`ctx.effect` 的参数只在 dispose 时执行——这里直接传入
 * `registerTickJob(...)` 返回的 disposer，不能包成 `ctx.effect(() => ...)`。
 */
export function installConvergence(
  ctx: Context,
  settings: SagaSettings,
  manifestOf: (sagaId: string) => ForceCloseManifest | undefined,
  statement: ExternalStatement,
  deps: ReconDeps,
  alerts: AlertSink = noopAlertSink,
): void {
  if (!settings.features.b3) return

  ctx.effect(
    registerTickJob('janitor', () => {
      runJanitor(ctx, settings, manifestOf, alerts)
    }),
  )

  ctx.effect(
    registerTickJob('recon', () => {
      void runReconJob(ctx, settings, statement, deps, alerts).catch((error: unknown) => {
        alerts('P0', `recon-job-failed:${error instanceof Error ? error.message : String(error)}`)
      })
    }),
  )
}
