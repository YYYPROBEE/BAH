/**
 * `@bah/saga` 包入口：装配函数 + 公开类型 + 服务键（SA-07 §2.3）。
 *
 * 纪律：跨包只认服务键与事件名（SA-00 §4.5）。
 */

import { installIdempotency } from './idempotency/index.ts'
import { SAGA_CLOCK } from './seams.ts'
import { installTemplates } from './templates/index.ts'

import type { Context } from '@bah/core'

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
  initialProjection,
  isTerminal,
  reduceSaga,
  SAGA_TRANSITIONS,
} from './state-machine/index.ts'
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
export { probeStep } from './probe/index.ts'
export type { ProbeObservation, ProbeTransport, ProbeVerdict, StepRef } from './probe/index.ts'
export { classify, mustDeadLetter, RETRYABLE } from './probe/classify.ts'
export type { FailureClass } from './probe/classify.ts'
export { escalateToDlq, settleCall } from './probe/settle.ts'
export type { EscalateInput, SettleInput, CallOutcome as SettleCallOutcome } from './probe/settle.ts'

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
  void settings
  ctx.provide(SAGA_CLOCK, systemClock)
  installIdempotency(ctx)
  installTemplates(ctx)
}
