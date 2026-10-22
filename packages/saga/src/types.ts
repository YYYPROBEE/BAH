/**
 * `@bah/saga` 的公开类型与状态字典（SA-00 §4 为唯一事实源）。
 *
 * 本文件只放**契约形状**，不放转移逻辑；状态合法出边在 `state-machine/`。
 * 行字段与 SA-07 §3.2 的 sqlite 列一一对应（camelCase ↔ snake_case）。
 */

/* ────────────────────────────── 状态字典（SA-00 §4.1–4.3） ────────────────────────────── */

/** Transaction 状态（11 态，顺序即 SA-00 §4.1 的书写顺序）。 */
export const SAGA_STATES = [
  'CREATED',
  'RUNNING',
  'SUCCEEDED',
  'ABORTED_CLEAN',
  'COMPENSATING',
  'COMPENSATED',
  'PARTIALLY_COMPENSATED',
  'PENDING_RISK_REVIEW',
  'GATE_HOLDING',
  'COMPENSATION_DLQ',
  'MANUALLY_CLOSED',
] as const

/** Transaction 状态。 */
export type SagaState = (typeof SAGA_STATES)[number]

/** 终态（无出边）。 */
export const TERMINAL_STATES = ['SUCCEEDED', 'ABORTED_CLEAN', 'COMPENSATED', 'MANUALLY_CLOSED'] as const

/** 终态。 */
export type TerminalState = (typeof TERMINAL_STATES)[number]

/** Step 状态（10 态）。 */
export const STEP_STATES = [
  'PLANNED',
  'CALLING',
  'EXECUTED',
  'FAILED',
  'SKIPPED',
  'UNKNOWN',
  'PROBING',
  'UNRESOLVED',
  'COMP_ISSUED',
  'COMPENSATED',
] as const

/** Step 状态。 */
export type StepState = (typeof STEP_STATES)[number]

/** CompAction 状态（7 态）。 */
export const COMP_STATES = ['PENDING', 'ISSUED', 'OK', 'ERR', 'UNKNOWN', 'PROBING', 'DLQ'] as const

/** CompAction 状态。 */
export type CompState = (typeof COMP_STATES)[number]

/** 副作用分类（决定补偿模板与闸门）。 */
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

/** 幂等命名空间（双键：正向 / 补偿）。 */
export type IdemNamespace = 'FWD' | 'COMP'

/* ───────────────────────────────── 行类型 ───────────────────────────────── */

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
  /** JSON（脱敏后）；明文走 vault。 */
  readonly initiator: string
  /** 1 = 冻结：拦新步骤发射，不改状态。 */
  readonly frozen: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** `saga_step` 行。 */
export interface SagaStep {
  readonly stepId: string
  readonly sagaId: string
  readonly seqNo: number
  /** JSON 数组解析后的 step_id[]。 */
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

/** `comp_template` 行（版本冻结）。 */
export interface CompTemplate {
  readonly templateId: string
  readonly templateVersion: number
  readonly targetTool: string
  readonly compKind: CompKind
  readonly compEndpoint: string
  readonly compIdempotent: boolean
  readonly deadlineRule?: string
  /** JSON 数组解析后的残差类型白名单。 */
  readonly residualRules: readonly string[]
  readonly approvalRequired: boolean
  readonly amountThreshold?: number
  /** JSON 字段映射（`PayloadProjection`）。 */
  readonly payloadProjection: string
  readonly status: string
}

/** `compensating_action` 行（计划期冻结的模板绑定 + 运行期状态）。 */
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
  /** JSON。 */
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

/** `target_system_registry` 行。 */
export interface TargetSystem {
  readonly targetSystem: string
  readonly idempotencySupport: 'STRONG' | 'WEAK' | 'NONE'
  readonly idempotencyTtlS?: number
  /** `undefined` = 禁止自动补偿。 */
  readonly probeEndpoint?: string
  /** > 0 = 探诊需 LAG 窗口二次确认。 */
  readonly lagSeconds: number
  readonly attestDigest?: string
  readonly registeredAt: number
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

/** 模板的声明式载荷映射（SA-10 §3.1）。 */
export interface PayloadFieldRule {
  readonly from: string
  readonly to: string
  readonly default?: unknown
}

/** 模板的声明式载荷映射。 */
export interface PayloadProjection {
  readonly fields: readonly PayloadFieldRule[]
}

/* ────────────────────────────── 投影与事件记录 ────────────────────────────── */

/** 离线回放/投影的中间态（运行时与回放共用）。 */
export interface SagaProjection {
  readonly sagaId: string
  readonly state: SagaState
  readonly steps: Readonly<Record<string, StepState>>
}

/** 链记录中参与转移判定的最小事件面。 */
export interface SagaEventRecord {
  readonly sagaId: string
  readonly seqInSaga: number
  readonly type: string
  readonly subjectRef: string
  readonly happensBefore: readonly number[]
  readonly payloadDigest: string
}

/** 唯一转移函数签名（实现落 `state-machine/reduce.ts`，SA-08）。 */
export type ReduceSaga = (state: SagaProjection, event: SagaEventRecord) => SagaProjection

/* ───────────────────────────────── 配置 ───────────────────────────────── */

/** 补偿退避策略。 */
export interface CompBackoffSettings {
  readonly baseMs: number
  readonly maxMs: number
  readonly jitter: number
}

/** 批次特性开关（回滚 = 关开关，DDL 不回滚）。 */
export interface SagaFeatureFlags {
  readonly b1: boolean
  readonly b2: boolean
  readonly b3: boolean
  readonly b4: boolean
}

/** `bank:saga` 的最终配置（默认值已由 `parseSagaSettings` 补齐）。 */
export interface SagaSettings {
  readonly dbPath: string
  readonly maxParallelBranches: number
  readonly maxAttempts: number
  readonly probeTimeoutMs: number
  readonly probeLagFactor: number
  readonly compBackoff: CompBackoffSettings
  readonly softSlaMs: number
  readonly hardSlaMs: number
  readonly forceCloseMs: number
  readonly reconBatchSize: number
  readonly dlqAlertDepth: number
  readonly dlqPhoneDepth: number
  readonly signingKeyPath: string
  readonly keyVersion: number
  readonly anchorIntervalMs: number
  readonly features: SagaFeatureFlags
}
