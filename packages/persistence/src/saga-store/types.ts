/**
 * `@bah/persistence/saga-store` 的行类型（与 `@bah/saga` 的公开行类型**结构兼容**）。
 *
 * 为什么不 import `@bah/saga` 的类型：`@bah/saga` 把 persistence 放在 devDependencies
 * （测试用真实实现），若 persistence 反向 import 会形成 TS project reference 环。
 * 运行时真相是服务键 `id`（`bah:saga-store`）；此处只保留结构相同的一份行形状。
 */

/** Transaction 状态（与 SA-00 §4.1 逐字一致）。 */
export type SagaState =
  | 'CREATED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'ABORTED_CLEAN'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'PARTIALLY_COMPENSATED'
  | 'PENDING_RISK_REVIEW'
  | 'GATE_HOLDING'
  | 'COMPENSATION_DLQ'
  | 'MANUALLY_CLOSED'

/** Step 状态（与 SA-00 §4.2 逐字一致）。 */
export type StepState =
  | 'PLANNED'
  | 'CALLING'
  | 'EXECUTED'
  | 'FAILED'
  | 'SKIPPED'
  | 'UNKNOWN'
  | 'PROBING'
  | 'UNRESOLVED'
  | 'COMP_ISSUED'
  | 'COMPENSATED'

/** CompAction 状态（与 SA-00 §4.3 逐字一致）。 */
export type CompState = 'PENDING' | 'ISSUED' | 'OK' | 'ERR' | 'UNKNOWN' | 'PROBING' | 'DLQ'

/** 副作用分类。 */
export type SideEffectClass = 'NONE' | 'REVERSIBLE' | 'EXTERNAL_UNDOABLE' | 'IRREVERSIBLE'

/** 补偿形态。 */
export type CompKind =
  | 'FULL_REFUND'
  | 'PARTIAL'
  | 'CANCEL_BOOKING'
  | 'CANCEL_IN_FLIGHT'
  | 'RELEASE_LOCK'
  | 'NO_OP'
  | 'MANUAL_ONLY'

/** 事务补偿策略。 */
export type CompStrategy = 'AUTO' | 'MANUAL_REQUIRED' | 'HYBRID'

/** 幂等命名空间。 */
export type IdemNamespace = 'FWD' | 'COMP'

/** `saga_transaction` 行。 */
export interface SagaTransaction {
  readonly sagaId: string
  readonly parentSagaId?: string
  readonly businessType: string
  readonly traceId: string
  readonly state: SagaState
  readonly version: number
  readonly timeoutBudgetMs: number
  readonly compStrategy: CompStrategy
  readonly initiator: string
  readonly frozen: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** `saga_step` 行。 */
export interface SagaStep {
  readonly stepId: string
  readonly sagaId: string
  readonly seqNo: number
  readonly topologyDeps: readonly string[]
  readonly toolName: string
  readonly endpoint: string
  readonly sideEffectClass: SideEffectClass
  readonly idempotencyKey: string
  readonly idempotencyNonce: string
  readonly state: StepState
  readonly attempts: number
  readonly maxAttempts: number
  readonly probeEndpoint?: string
  readonly deadlineMs: number
  readonly requestDigest?: string
  readonly responseDigest?: string
}

/** `comp_template` 行。 */
export interface CompTemplate {
  readonly templateId: string
  readonly templateVersion: number
  readonly targetTool: string
  readonly compKind: CompKind
  readonly compEndpoint: string
  readonly compIdempotent: boolean
  readonly deadlineRule?: string
  readonly residualRules: readonly string[]
  readonly approvalRequired: boolean
  readonly amountThreshold?: number
  readonly payloadProjection: string
  readonly status: string
}

/** `compensating_action` 行。 */
export interface CompensatingAction {
  readonly compId: string
  readonly sagaId: string
  readonly stepId: string
  readonly templateId: string
  readonly templateVersion: number
  readonly compKind: CompKind
  readonly compIdempotencyKey: string
  readonly payloadDigest: string
  readonly state: CompState
  readonly attempts: number
  readonly maxAttempts: number
  readonly backoffPolicy: string
  readonly compDeadline?: number
  readonly approverId?: string
  readonly residualAmount: number
  readonly residualType?: string
  readonly costEstimate?: number
}

/** `idempotency_record` 行。 */
export interface IdempotencyRecord {
  readonly idemKey: string
  readonly namespace: IdemNamespace
  readonly sagaId: string
  readonly targetSystem: string
  readonly requestDigest: string
  readonly responseDigest?: string
  readonly fingerprint?: string
  readonly status: 'RESERVED' | 'DONE' | 'FAILED'
  readonly leaseOwner?: string
  readonly leaseExpiry?: number
}

/** `dlq_entry` 行。 */
export interface DlqEntry {
  readonly dlqId: string
  readonly sagaId: string
  readonly source: 'STEP' | 'COMP' | 'PROBE'
  readonly reason: string
  readonly contextRef?: string
  readonly replayGuide?: string
  readonly enteredAt: number
  readonly slaDeadline: number
  readonly disposition?: string
}

/** `suspension_ticket` 行。 */
export interface SuspensionTicket {
  readonly ticketId: string
  readonly sagaId: string
  readonly reason: 'RISK_REVIEW' | 'GATE_APPROVAL' | 'COST_DECISION' | 'UNRESOLVED' | 'DLQ_ESCALATION'
  readonly contextSnapshotRef?: string
  readonly costCompare?: string
  readonly slaDeadline: number
  readonly approverId?: string
  readonly decision?: string
  readonly decidedAt?: number
}

/** `residual_ledger` 行。 */
export interface ResidualLedgerEntry {
  readonly residualId: string
  readonly sagaId: string
  readonly compId?: string
  readonly residualType: string
  readonly amount: number
  readonly note?: string
  readonly reconciled: boolean
}

/** `state_snapshot` 行。 */
export interface StateSnapshot {
  readonly snapshotId: string
  readonly sagaId: string
  readonly stepSeq?: number
  readonly contextDigest: string
  readonly contextVaultRef?: string
  readonly llmDecisionDigest?: string
}

/** `vault_sensitive` 行。 */
export interface VaultSensitive {
  readonly vaultId: string
  readonly cipherText: Uint8Array
  readonly keyVersion: number
  readonly classification: string
}

/** `target_system_registry` 行（SA-16 §8：批 6 补齐读取入口，消除 `service-missing`）。 */
export interface TargetSystemRow {
  readonly targetSystem: string
  readonly idempotencySupport: 'STRONG' | 'WEAK' | 'NONE'
  readonly idempotencyTtlS?: number
  /** `undefined` = 禁止自动补偿。 */
  readonly probeEndpoint?: string
  readonly lagSeconds: number
  readonly attestDigest?: string
  readonly registeredAt: number
}
