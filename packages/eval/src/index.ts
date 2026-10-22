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

export { assertNever } from './assertNever.ts'
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

export { attachSeamBridge } from './adapters/seamBridge.ts'
export type { SeamBridgeHandle, SeamBridgeOptions } from './adapters/seamBridge.ts'
export { flattenSagaProjection, flattenState } from './adapters/flattenState.ts'
export type { FlattenOptions } from './adapters/flattenState.ts'
export type { EventSourcePort, SeamListener, SeamNext, StateReader } from './adapters/ports.ts'

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

export { deepClone } from './deepClone.ts'
export { isPlainObject } from './plainObject.ts'
