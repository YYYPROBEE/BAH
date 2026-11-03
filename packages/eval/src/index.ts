/**
 * 评测平面公开出口（`@bah/eval`）。
 *
 * 只做 re-export，不含逻辑：调用方要么拿判定器单独用（M0），要么拿记录/快照/证据
 * 三件套跑一次 episode（M1 起）。
 */

export type {
  CheckpointKind,
  ComponentVerdict,
  EvidencePack,
  FlatState,
  Snapshot,
  SnapshotReason,
  TrajectoryEvent,
  TrajectoryRecord,
  Verdict,
  VerdictComponent,
  VerdictInputs,
} from './types.ts'
export { COMPONENT_ORDER } from './types.ts'

export { assertNever } from './assert-never.ts'
export { buildVerdict, isUndecidable } from './verdict.ts'
export type { BuildVerdictInput, ComponentLocators } from './verdict.ts'

export { checkCsa } from './deciders/CSA.ts'
export type { CsaFailure, CsaFailureKind, CsaInput, CsaResult } from './deciders/CSA.ts'

export { diffTsd, valueEquals } from './deciders/TSD.ts'
export type { TsdInput, TsdResult, TsdViolation } from './deciders/TSD.ts'

export { scanFrs } from './deciders/FRS.ts'
export type { FrsInput, FrsResult, ResiduePredicate } from './deciders/FRS.ts'

export { assertPsa } from './deciders/PSA.ts'
export type {
  DomainSpec,
  EnumDomain,
  NumberDomain,
  PsaInput,
  PsaResult,
  PsaViolation,
} from './deciders/PSA.ts'

export { redactRecord, redactText, redactValue, tokenize, TOKEN_PREFIX } from './redact/redact.ts'
export type { RedactKind, RedactOptions } from './redact/redact.ts'

export { DEFAULT_RUNS_DIR, TrajectoryRecorder } from './recorder/TrajectoryRecorder.ts'
export type {
  ToolCallRecordInput,
  TrajectoryRecorderOptions,
} from './recorder/TrajectoryRecorder.ts'

export { SnapshotChain } from './snapshot/SnapshotChain.ts'
export type { SnapshotChainOptions, SnapshotPair } from './snapshot/SnapshotChain.ts'

export {
  buildEvidencePack,
  checkCompleteness,
  EVIDENCE_SCHEMA_VERSION,
  sealEvidencePack,
  verdictFromComponents,
  writeEvidencePack,
} from './evidence/EvidencePack.ts'
export type {
  BuildEvidencePackInput,
  BuiltEvidencePack,
  CompletenessInput,
  CompletenessReport,
} from './evidence/EvidencePack.ts'

export { attachSeamBridge } from './adapters/seam-bridge.ts'
export type { SeamBridgeHandle, SeamBridgeOptions } from './adapters/seam-bridge.ts'
export { flattenSagaProjection, flattenState } from './adapters/flatten-state.ts'
export type { FlattenOptions } from './adapters/flatten-state.ts'
export type { EventSourcePort, SeamListener, SeamNext, StateReader } from './adapters/ports.ts'

export type {
  ScenarioApproval,
  ScenarioExpectation,
  ScenarioFamily,
  ScenarioMetric,
  ScenarioSpec,
} from './scenario/spec.ts'

export {
  CheckpointConfigError,
  DEFAULT_CHECKPOINTS_PATH,
  isCheckpointAvailable,
  isIrreversibleFrom,
  loadCheckpointsConfig,
  parseCheckpointsConfig,
} from './config/checkpoints.ts'
export type {
  CheckpointAvailability,
  CheckpointsConfig,
  CheckpointStatus,
} from './config/checkpoints.ts'

export { deepClone } from './deep-clone.ts'
export { isPlainObject } from './plain-object.ts'

// W13：场景 runner / 60 场景 / 四项指标（`scripts/eval.ts` 的公开面）
export {
  runEval,
  runEvalReport,
  renderSummary,
  SCENARIO_TIMEOUT_MS,
  runWithTimeout,
  classifyEvalFailure,
  evaluateExpectations,
} from './scenario/runner.ts'
export type { EvalReport, EvalTiming, EvalRunResult, RunEvalOptions } from './scenario/runner.ts'
export { FAMILY_COUNTS, TOTAL_SCENARIOS, validateScenarios } from './scenario/validate.ts'
export type { ValidationResult } from './scenario/validate.ts'
export type { EvalScenario, ScenarioAction, SagaStepFixture } from './scenario/types.ts'
export {
  aggregateMetrics,
  countsByFamily,
  formatRate,
  percentile95,
} from './metrics/aggregate.ts'
export type { Metrics, Rate, ScenarioOutcome } from './metrics/aggregate.ts'
export { ALL_SCENARIOS } from './scenarios/index.ts'

// W14：对抗集（45 例）
export {
  ADVERSARIAL_META,
  ADVERSARIAL_SCENARIOS,
  familyLabel,
  validateAdversarial,
  renderAdversarialSummary,
  runAdversarial,
} from './adversarial/index.ts'
export type {
  AdversarialAttribution,
  AdversarialCaseResult,
  AdversarialExpectation,
  AdversarialFamily,
  AdversarialMeta,
  AdversarialReport,
  AdversarialRunResult,
  AdversarialSource,
} from './adversarial/index.ts'

// W15：监管证据包与 Merkle 包含证明
export * from './evidence/SessionEvidencePack.ts'
export * from './snapshot/merkle.ts'

// W15：eval 基线与劣化比较
export * from './baseline.ts'
