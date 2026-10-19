/**
 * `@bah/saga` 的服务键、接缝与事件键（SA-07 §4/§5 冻结面）。
 *
 * 纪律：跨包只认 `ServiceKey` 的 `id` 字符串与事件名，插件之间不互相 import 实现类。
 * 后续施工单只许**引用**本文件；新增成员必须先回写 SA-00 / SA-07。
 */

import { defineService } from '@bah/core'

import type {
  CompKind,
  CompTemplate,
  CompensatingAction,
  DlqEntry,
  IdempotencyRecord,
  ResidualLedgerEntry,
  SagaState,
  SagaStep,
  SagaTransaction,
  StateSnapshot,
  SuspensionTicket,
  TargetSystem,
  VaultSensitive,
} from './types.ts'

/* ────────────────────────────── 存储接缝 ────────────────────────────── */

/** 状态/幂等/模板表的读写接缝（sqlite 事务唯一入口）。 */
export interface SagaStore {
  /** 单提交段（BEGIN IMMEDIATE → COMMIT/ROLLBACK）。 */
  tx<T>(fn: (tx: SagaTx) => T): T
  loadTransaction(sagaId: string): SagaTransaction | undefined
  casState(sagaId: string, from: SagaState, to: SagaState, version: number, at: number): boolean
  listSteps(sagaId: string): readonly SagaStep[]
  upsertStep(step: SagaStep): void
  /** `idx_saga_active` 命中（非终态）。 */
  activeSagas(): readonly string[]
  listAllSagas(filter?: { readonly state?: SagaState; readonly businessType?: string }): readonly SagaTransaction[]
  // 模板注册表（配置期；SA-07 §4 批 3 回写）
  /** 写入一条模板版本；重复 `(templateId, templateVersion)` 由调用方先查重（版本不可覆盖）。 */
  insertTemplate(template: CompTemplate): void
  /** ACTIVE 模板的最新版本（按 `target_tool`）；配置期读，不开事务。 */
  findActiveTemplate(toolName: string): CompTemplate | undefined
  /** 按计划期冻结的 `(templateId, templateVersion)` 读回。 */
  readTemplate(templateId: string, templateVersion: number): CompTemplate | undefined
  // 目标系统登记（SA-16 §8 批 6 回写：消除 `bah:target-registry` 无提供者）
  /** 读一条目标系统承诺；未登记返回 `undefined`（补偿侧按 `unknown-target` 拒自动补偿）。 */
  readTarget(targetSystem: string): TargetSystem | undefined
  listTargets(): readonly TargetSystem[]
  /** 运维/装配期登记目标（补偿自动化的前置事实）。 */
  upsertTarget(target: TargetSystem): void
}

/**
 * 单提交段内的**行级原语**（SA-08/09/10/11/12/13 全部按本签名调用）。
 *
 * 纪律一：只提供"读窄表 / 写窄表 / 取号"三类操作，不提供跨段事务；调用方不得自行开事务
 * （`reserve` 一类的复合写入必须提供 tx 内版本，避免嵌套 `BEGIN`）。
 * 纪律二：需要"成败判定"的原语返回 `boolean`（插入/接管/CAS），其余均为 `void`。
 * **本清单已冻结**：任何新单新增成员必须回写 SA-07 §4。
 */
export interface SagaTx {
  // 事务
  insertTransaction(row: SagaTransaction): void
  readTransaction(sagaId: string): SagaTransaction | undefined
  casState(sagaId: string, from: SagaState, to: SagaState, version: number, at: number): boolean
  loadTransactionByTicket(ticketId: string): SagaTransaction | undefined
  listAllSagas(filter?: { readonly state?: SagaState; readonly businessType?: string }): readonly SagaTransaction[]
  // 步骤
  insertStep(row: SagaStep): void
  readStep(stepId: string): SagaStep | undefined
  listSteps(sagaId: string): readonly SagaStep[]
  updateStep(row: SagaStep): void
  // 补偿绑定
  bindCompensation(sagaId: string, stepId: string, template: CompTemplate): void
  listCompensations(sagaId: string): readonly CompensatingAction[]
  updateCompensation(row: CompensatingAction): void
  // 幂等信封
  /** true = 本条插入成功（键未被占用）。 */
  insertIdempotency(row: IdempotencyRecord): boolean
  readIdempotency(idemKey: string): IdempotencyRecord | undefined
  /** true = 租约过期成功接管。 */
  takeoverIdempotency(idemKey: string, owner: string, leaseExpiry: number): boolean
  completeIdempotency(idemKey: string, responseDigest: string, fingerprint: string): void
  // 处置与账本
  insertDlq(row: DlqEntry): void
  insertTicket(row: SuspensionTicket): void
  readTicket(ticketId: string): SuspensionTicket | undefined
  insertResidual(row: ResidualLedgerEntry): void
  listResiduals(sagaId: string): readonly ResidualLedgerEntry[]
  // 快照与金库
  insertSnapshot(row: StateSnapshot): void
  readLatestSnapshot(sagaId: string): StateSnapshot | undefined
  putVault(vaultId: string, cipherText: Uint8Array, keyVersion: number, classification: string): void
  readVault(vaultId: string): VaultSensitive | undefined
  // 处置与冻结（SA-10 / SA-12 / SA-13 共用）
  /** 未处置 DLQ 条数（告警阈值判定用）。 */
  dlqDepth(): number
  listDlqPending(): readonly DlqEntry[]
  readDlq(dlqId: string): DlqEntry | undefined
  recordTicketDecision(ticketId: string, decision: string, approverId: string, at: number): void
  /** 冻结只拦新发射，不改状态（SA-12）。 */
  freezeSaga(sagaId: string, frozen: boolean, at: number): void
}

/* ────────────────────────────── 审计/时钟/模板/幂等 ────────────────────────────── */

/** 审计链接缝（append / verify / anchor）。 */
export interface SagaAudit {
  append(
    sagaId: string,
    type: string,
    data: unknown,
    refs?: { happensBefore?: readonly number[]; vaultRef?: string },
  ): { seqInSaga: number; recordHash: string }
  verify(sagaId?: string): { ok: boolean; brokenAt?: number }
  anchor(period: string): Promise<{ merkleRoot: string; targets: readonly string[] }>
}

/** 确定性时钟（测试可注入；全链路的唯一时间来源，对应 A6）。 */
export interface SagaClock {
  now(): number
  sleep(ms: number): Promise<void>
}

/** 模板注册表（版本冻结查询）。 */
export interface SagaTemplates {
  findActive(toolName: string): CompTemplate | undefined
  /** 计划期绑定：把命中的模板（含版本）冻结进 `compensating_action`。 */
  bind(sagaId: string, stepId: string, template: CompTemplate): void
  /** 补偿期读回计划期已冻结的绑定（沿用原版本，不重新选版）。 */
  boundFor(sagaId: string, stepId: string): CompTemplate | undefined
}

/**
 * 幂等信封（双命名空间 + nonce + 租约）。
 *
 * 事务纪律：`reserve` / `complete` 是带自身事务的便利版（内部 `store.tx`）；
 * 调用方若已在提交段内（如 SA-08 `commitSegment`），**必须**改用 `reserveIn` / `completeIn`
 * ——sqlite 的 `BEGIN IMMEDIATE` 不允许嵌套。
 */
export interface SagaIdempotency {
  makeKey(namespace: 'FWD' | 'COMP', sagaId: string, localId: string, nonce: string): string
  reserve(key: string, input: IdempotencyRecord, ttlMs: number): { ok: true } | { ok: false; reason: 'lease-held' | 'key-conflict' }
  complete(key: string, responseDigest: string, fingerprint: string): void
  /** tx 内版本：不自开事务，直接在当前 `tx` 上做插入/接管判定。 */
  reserveIn(tx: SagaTx, key: string, input: IdempotencyRecord, ttlMs: number): { ok: true } | { ok: false; reason: 'lease-held' | 'key-conflict' }
  /** tx 内版本：不自开事务。 */
  completeIn(tx: SagaTx, key: string, responseDigest: string, fingerprint: string): void
}

/** 外部系统承诺登记。 */
export interface TargetRegistry {
  get(targetSystem: string): TargetSystem | undefined
  list(): readonly TargetSystem[]
}

/**
 * **作用域键**（不是服务键）：当前 in-flight 步骤的 saga 绑定。
 *
 * 协调器派发工具体前 `ctx.scope.set(SAGA_STEP_CONTEXT, { sagaId, stepId })`，派发返回后清除。
 */
export const SAGA_STEP_CONTEXT = defineService<{ readonly sagaId: string; readonly stepId: string }>(
  'bah:saga-step-context',
)

export const SAGA_STORE = defineService<SagaStore>('bah:saga-store')
export const SAGA_AUDIT = defineService<SagaAudit>('bah:saga-audit')
export const SAGA_CLOCK = defineService<SagaClock>('bah:saga-clock')
export const SAGA_TEMPLATES = defineService<SagaTemplates>('bah:saga-templates')
export const SAGA_IDEMPOTENCY = defineService<SagaIdempotency>('bah:saga-idempotency')
export const TARGET_REGISTRY = defineService<TargetRegistry>('bah:target-registry')

/* ────────────────────────────── 事件键（SA-00 §4.4） ────────────────────────────── */

declare module '@bah/core' {
  interface BahEventMap {
    /** @mode emit */
    'saga/created': { sagaId: string; businessType: string; traceId: string; timeoutBudgetMs: number }
    /** @mode emit */
    'saga/step-planned': { sagaId: string; stepId: string; seqNo: number; toolName: string; sideEffectClass: string; idemKey: string }
    /** @mode emit */
    'saga/param-validated': { sagaId: string; stepId: string; verdict: 'pass' | 'reject'; gate: 'schema' | 'rule' | 'risk'; code?: string }
    /** @mode emit */
    'saga/call-result': { sagaId: string; stepId: string; outcome: 'ok' | 'err' | 'unknown'; requestDigest: string; responseDigest?: string }
    /** @mode emit */
    'saga/unknown-probe': { sagaId: string; stepId: string; ladder: 'L1' | 'L2'; endpoint?: string; verdict: string; lagWaitMs?: number }
    /** @mode waterfall */
    'saga/comp-decided': { sagaId: string; stepId: string; decide: 'compensate' | 'hold' | 'manual'; reason: string }
    /** @mode emit */
    'saga/comp-issued': { sagaId: string; compId: string; templateId: string; templateVersion: number; compKind: CompKind; compKey: string; payloadDigest: string }
    /** @mode emit */
    'saga/comp-result': { sagaId: string; compId: string; outcome: 'ok' | 'err' | 'unknown'; residualAmount?: number }
    /** @mode emit */
    'saga/dlq-escalated': { sagaId: string; dlqId: string; source: 'step' | 'comp' | 'probe'; reason: string; slaDeadline: number }
    /** @mode emit */
    'saga/residual-recorded': { sagaId: string; compId: string; residualType: string; amount: number }
    /** @mode emit */
    'saga/reconciled': { batchId: string; sagaId?: string; diffCount: number; amendmentSagaId?: string }
    /** @mode emit */
    'saga/manually-closed': { sagaId: string; operator: string; manifestRef: string; reason: string }
    /** @mode emit */
    'saga/vault-accessed': { sagaId?: string; vaultId: string; keyVersion: number; purpose: string }
    /** @mode emit */
    'saga/recovered': { sagaId: string; stepId: string; from: 'CALLING' | 'UNKNOWN' | 'EXECUTED'; action: string }
    /** @mode emit */
    'saga/anchor-published': { period: string; merkleRoot: string; targets: readonly string[] }
    /** @mode serial */
    'saga/tick': { now: number; dueJobs: readonly ('janitor' | 'recon' | 'anchor')[] }
  }
}

/** 供 SA-08/SA-13 引用的事件键字面量集合（与上方声明逐字一致）。 */
export const SAGA_EVENT_KEYS = [
  'saga/created',
  'saga/step-planned',
  'saga/param-validated',
  'saga/call-result',
  'saga/unknown-probe',
  'saga/comp-decided',
  'saga/comp-issued',
  'saga/comp-result',
  'saga/dlq-escalated',
  'saga/residual-recorded',
  'saga/reconciled',
  'saga/manually-closed',
  'saga/vault-accessed',
  'saga/recovered',
  'saga/anchor-published',
  'saga/tick',
] as const

/** 事件键。 */
export type SagaEventKey = (typeof SAGA_EVENT_KEYS)[number]
