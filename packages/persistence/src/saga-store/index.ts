/**
 * sqlite 状态底座（SA-07 §3/§4）：`SagaStore` + `SagaTx` 的唯一实现。
 *
 * 事务纪律：`tx` 用 `BEGIN IMMEDIATE`；调用方不得自行开事务，复合写入必须走 `tx` 内的
 * `reserveIn` / `completeIn`（嵌套 BEGIN 会报错）。
 */

import { BahError, canonicalJson, sha256Hex } from '@bah/util'

import { migrate } from './migrations/index.ts'
import { loadSqlite } from './sqlite.ts'

import type { DatabaseSync } from 'node:sqlite'

import type {
  CompKind,
  CompState,
  CompTemplate,
  CompensatingAction,
  CompStrategy,
  DlqEntry,
  IdemNamespace,
  IdempotencyRecord,
  ResidualLedgerEntry,
  SagaState,
  SagaStep,
  SagaTransaction,
  SideEffectClass,
  StateSnapshot,
  StepState,
  SuspensionTicket,
  TargetSystemRow,
  VaultSensitive,
} from './types.ts'

/** 打开 store 的输入。 */
export interface SagaStoreOptions {
  /** sqlite 文件路径；`:memory:` 用于测试。 */
  readonly dbPath: string
  /** 确定性时钟（租约过期判定）；缺省 `Date.now`。 */
  readonly now?: () => number
}

/** 单提交段的内部钩子（协调器用于在 COMMIT 前落审计/fsync）。 */
export interface TxHooks {
  readonly beforeCommit?: () => void
}

/** `@bah/persistence` 侧暴露的 store 句柄（结构与 `@bah/saga` 的 `SagaStore` 兼容）。 */
export interface SagaStoreHandle {
  tx<T>(fn: (tx: SagaTxHandle) => T, hooks?: TxHooks): T
  loadTransaction(sagaId: string): SagaTransaction | undefined
  casState(sagaId: string, from: SagaState, to: SagaState, version: number, at: number): boolean
  listSteps(sagaId: string): readonly SagaStep[]
  upsertStep(step: SagaStep): void
  activeSagas(): readonly string[]
  listAllSagas(filter?: { readonly state?: SagaState; readonly businessType?: string }): readonly SagaTransaction[]
  /** 模板注册表（配置期）：写入一条版本。 */
  insertTemplate(template: CompTemplate): void
  /** ACTIVE 模板的最新版本（按 `target_tool`）。 */
  findActiveTemplate(toolName: string): CompTemplate | undefined
  /** 按 `(template_id, template_version)` 读回冻结版本。 */
  readTemplate(templateId: string, templateVersion: number): CompTemplate | undefined
  /** 目标系统登记读取（SA-16 §8：批 6 补，供 host 提供 `bah:target-registry`）。 */
  readTarget(targetSystem: string): TargetSystemRow | undefined
  listTargets(): readonly TargetSystemRow[]
  /** 运维/装配期登记目标（补偿自动化的前置事实）。 */
  upsertTarget(target: TargetSystemRow): void
  /** 关闭连接（宿主插件在 dispose 时调用）。 */
  close(): void
}

/** 单提交段内的行级原语（结构与 `@bah/saga` 的 `SagaTx` 兼容）。 */
export interface SagaTxHandle {
  insertTransaction(row: SagaTransaction): void
  readTransaction(sagaId: string): SagaTransaction | undefined
  casState(sagaId: string, from: SagaState, to: SagaState, version: number, at: number): boolean
  loadTransactionByTicket(ticketId: string): SagaTransaction | undefined
  listAllSagas(filter?: { readonly state?: SagaState; readonly businessType?: string }): readonly SagaTransaction[]
  insertStep(row: SagaStep): void
  readStep(stepId: string): SagaStep | undefined
  listSteps(sagaId: string): readonly SagaStep[]
  updateStep(row: SagaStep): void
  bindCompensation(sagaId: string, stepId: string, template: CompTemplate): void
  listCompensations(sagaId: string): readonly CompensatingAction[]
  updateCompensation(row: CompensatingAction): void
  insertIdempotency(row: IdempotencyRecord): boolean
  readIdempotency(idemKey: string): IdempotencyRecord | undefined
  takeoverIdempotency(idemKey: string, owner: string, leaseExpiry: number): boolean
  completeIdempotency(idemKey: string, responseDigest: string, fingerprint: string): void
  insertDlq(row: DlqEntry): void
  insertTicket(row: SuspensionTicket): void
  readTicket(ticketId: string): SuspensionTicket | undefined
  insertResidual(row: ResidualLedgerEntry): void
  listResiduals(sagaId: string): readonly ResidualLedgerEntry[]
  insertSnapshot(row: StateSnapshot): void
  readLatestSnapshot(sagaId: string): StateSnapshot | undefined
  putVault(vaultId: string, cipherText: Uint8Array, keyVersion: number, classification: string): void
  readVault(vaultId: string): VaultSensitive | undefined
  dlqDepth(): number
  listDlqPending(): readonly DlqEntry[]
  readDlq(dlqId: string): DlqEntry | undefined
  recordTicketDecision(ticketId: string, decision: string, approverId: string, at: number): void
  freezeSaga(sagaId: string, frozen: boolean, at: number): void
}

/* ─────────────────────────────── 行映射 ─────────────────────────────── */

type Row = Record<string, unknown>

const str = (value: unknown): string => value as string
const num = (value: unknown): number => value as number
const optStr = (value: unknown): string | undefined => (value === null ? undefined : (value as string))
const optNum = (value: unknown): number | undefined => (value === null ? undefined : (value as number))

function parseStringArray(raw: unknown): readonly string[] {
  const parsed: unknown = JSON.parse(str(raw))
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new BahError('invalid-row', 'bah-saga: invalid-row: JSON 列必须是字符串数组', { raw })
  }
  return parsed
}

function mapTransaction(row: Row): SagaTransaction {
  return {
    sagaId: str(row['saga_id']),
    parentSagaId: optStr(row['parent_saga_id']),
    businessType: str(row['business_type']),
    traceId: str(row['trace_id']),
    state: str(row['state']) as SagaState,
    version: num(row['version']),
    timeoutBudgetMs: num(row['timeout_budget_ms']),
    compStrategy: str(row['comp_strategy']) as CompStrategy,
    initiator: str(row['initiator']),
    frozen: num(row['frozen']) === 1,
    createdAt: num(row['created_at']),
    updatedAt: num(row['updated_at']),
  }
}

function mapStep(row: Row): SagaStep {
  return {
    stepId: str(row['step_id']),
    sagaId: str(row['saga_id']),
    seqNo: num(row['seq_no']),
    topologyDeps: parseStringArray(row['topology_deps']),
    toolName: str(row['tool_name']),
    endpoint: str(row['endpoint']),
    sideEffectClass: str(row['side_effect_class']) as SideEffectClass,
    idempotencyKey: str(row['idempotency_key']),
    idempotencyNonce: str(row['idempotency_nonce']),
    state: str(row['state']) as StepState,
    attempts: num(row['attempts']),
    maxAttempts: num(row['max_attempts']),
    probeEndpoint: optStr(row['probe_endpoint']),
    deadlineMs: num(row['deadline_ms']),
    requestDigest: optStr(row['request_digest']),
    responseDigest: optStr(row['response_digest']),
  }
}

function mapTemplate(row: Row): CompTemplate {
  return {
    templateId: str(row['template_id']),
    templateVersion: num(row['template_version']),
    targetTool: str(row['target_tool']),
    compKind: str(row['comp_kind']) as CompKind,
    compEndpoint: str(row['comp_endpoint']),
    compIdempotent: num(row['comp_idempotent']) === 1,
    deadlineRule: optStr(row['deadline_rule']),
    residualRules: parseStringArray(row['residual_rules']),
    approvalRequired: num(row['approval_required']) === 1,
    amountThreshold: optNum(row['amount_threshold']),
    payloadProjection: str(row['payload_projection']),
    status: str(row['status']),
  }
}

function mapTarget(row: Row): TargetSystemRow {
  return {
    targetSystem: str(row['target_system']),
    idempotencySupport: str(row['idempotency_support']) as TargetSystemRow['idempotencySupport'],
    idempotencyTtlS: optNum(row['idempotency_ttl_s']),
    probeEndpoint: optStr(row['probe_endpoint']),
    lagSeconds: num(row['lag_seconds']),
    attestDigest: optStr(row['attest_digest']),
    registeredAt: num(row['registered_at']),
  }
}

function mapCompensation(row: Row): CompensatingAction {  return {
    compId: str(row['comp_id']),
    sagaId: str(row['saga_id']),
    stepId: str(row['step_id']),
    templateId: str(row['template_id']),
    templateVersion: num(row['template_version']),
    compKind: str(row['comp_kind']) as CompKind,
    compIdempotencyKey: str(row['comp_idempotency_key']),
    payloadDigest: str(row['payload_digest']),
    state: str(row['state']) as CompState,
    attempts: num(row['attempts']),
    maxAttempts: num(row['max_attempts']),
    backoffPolicy: str(row['backoff_policy']),
    compDeadline: optNum(row['comp_deadline']),
    approverId: optStr(row['approver_id']),
    residualAmount: num(row['residual_amount']),
    residualType: optStr(row['residual_type']),
    costEstimate: optNum(row['cost_estimate']),
  }
}

function mapIdempotency(row: Row): IdempotencyRecord {
  return {
    idemKey: str(row['idem_key']),
    namespace: str(row['namespace']) as IdemNamespace,
    sagaId: str(row['saga_id']),
    targetSystem: str(row['target_system']),
    requestDigest: str(row['request_digest']),
    responseDigest: optStr(row['response_digest']),
    fingerprint: optStr(row['fingerprint']),
    status: str(row['status']) as IdempotencyRecord['status'],
    leaseOwner: optStr(row['lease_owner']),
    leaseExpiry: optNum(row['lease_expiry']),
  }
}

function mapDlq(row: Row): DlqEntry {
  return {
    dlqId: str(row['dlq_id']),
    sagaId: str(row['saga_id']),
    source: str(row['source']) as DlqEntry['source'],
    reason: str(row['reason']),
    contextRef: optStr(row['context_ref']),
    replayGuide: optStr(row['replay_guide']),
    enteredAt: num(row['entered_at']),
    slaDeadline: num(row['sla_deadline']),
    disposition: optStr(row['disposition']),
  }
}

function mapTicket(row: Row): SuspensionTicket {
  return {
    ticketId: str(row['ticket_id']),
    sagaId: str(row['saga_id']),
    reason: str(row['reason']) as SuspensionTicket['reason'],
    contextSnapshotRef: optStr(row['context_snapshot_ref']),
    costCompare: optStr(row['cost_compare']),
    slaDeadline: num(row['sla_deadline']),
    approverId: optStr(row['approver_id']),
    decision: optStr(row['decision']),
    decidedAt: optNum(row['decided_at']),
  }
}

function mapResidual(row: Row): ResidualLedgerEntry {
  return {
    residualId: str(row['residual_id']),
    sagaId: str(row['saga_id']),
    compId: optStr(row['comp_id']),
    residualType: str(row['residual_type']),
    amount: num(row['amount']),
    note: optStr(row['note']),
    reconciled: num(row['reconciled']) === 1,
  }
}

function mapSnapshot(row: Row): StateSnapshot {
  return {
    snapshotId: str(row['snapshot_id']),
    sagaId: str(row['saga_id']),
    stepSeq: optNum(row['step_seq']),
    contextDigest: str(row['context_digest']),
    contextVaultRef: optStr(row['context_vault_ref']),
    llmDecisionDigest: optStr(row['llm_decision_digest']),
  }
}

/* ─────────────────────────────── store ─────────────────────────────── */

class SqliteSagaStore implements SagaStoreHandle {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private inTransaction = false

  constructor(options: SagaStoreOptions) {
    const { DatabaseSync: Database } = loadSqlite()
    const db = new Database(options.dbPath)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('PRAGMA journal_mode = WAL')
      migrate(db)
    } catch (error) {
      db.close()
      throw error
    }
    this.db = db
    this.now = options.now ?? Date.now
  }

  close(): void {
    this.db.close()
  }

  tx<T>(fn: (tx: SagaTxHandle) => T, hooks?: TxHooks): T {
    if (this.inTransaction) {
      throw new BahError('transaction-nested', 'bah-saga: transaction-nested: 不允许嵌套 BEGIN IMMEDIATE')
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.inTransaction = true
    try {
      const result = fn(this)
      hooks?.beforeCommit?.()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 事务已被 sqlite 自动回滚（或 COMMIT 已失败）：保留原始错误，不掩盖。
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  /* ── 事务 ── */

  insertTransaction(row: SagaTransaction): void {
    this.db
      .prepare(
        `INSERT INTO saga_transaction
          (saga_id, parent_saga_id, business_type, trace_id, state, version, timeout_budget_ms,
           comp_strategy, initiator, frozen, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.sagaId,
        row.parentSagaId ?? null,
        row.businessType,
        row.traceId,
        row.state,
        row.version,
        row.timeoutBudgetMs,
        row.compStrategy,
        row.initiator,
        row.frozen ? 1 : 0,
        row.createdAt,
        row.updatedAt,
      )
  }

  loadTransaction(sagaId: string): SagaTransaction | undefined {
    return this.readTransaction(sagaId)
  }

  readTransaction(sagaId: string): SagaTransaction | undefined {
    const row = this.db.prepare('SELECT * FROM saga_transaction WHERE saga_id = ?').get(sagaId) as
      | Row
      | undefined
    return row === undefined ? undefined : mapTransaction(row)
  }

  casState(sagaId: string, from: SagaState, to: SagaState, version: number, at: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE saga_transaction
            SET state = ?, version = version + 1, updated_at = ?
          WHERE saga_id = ? AND state = ? AND version = ?`,
      )
      .run(to, at, sagaId, from, version)
    return result.changes === 1
  }

  loadTransactionByTicket(ticketId: string): SagaTransaction | undefined {
    const row = this.db
      .prepare(
        `SELECT t.* FROM saga_transaction t
           JOIN suspension_ticket s ON s.saga_id = t.saga_id
          WHERE s.ticket_id = ?`,
      )
      .get(ticketId) as Row | undefined
    return row === undefined ? undefined : mapTransaction(row)
  }

  listAllSagas(
    filter: { readonly state?: SagaState; readonly businessType?: string } = {},
  ): readonly SagaTransaction[] {
    const clauses: string[] = []
    const params: string[] = []
    if (filter.state !== undefined) {
      clauses.push('state = ?')
      params.push(filter.state)
    }
    if (filter.businessType !== undefined) {
      clauses.push('business_type = ?')
      params.push(filter.businessType)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM saga_transaction${where} ORDER BY created_at, saga_id`)
      .all(...params) as Row[]
    return rows.map(mapTransaction)
  }

  activeSagas(): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT saga_id FROM saga_transaction
          WHERE state NOT IN ('SUCCEEDED','ABORTED_CLEAN','COMPENSATED','MANUALLY_CLOSED')
          ORDER BY created_at, saga_id`,
      )
      .all() as Row[]
    return rows.map((row) => str(row['saga_id']))
  }

  /* ── 模板注册表（配置期） ── */

  insertTemplate(row: CompTemplate): void {
    this.db
      .prepare(
        `INSERT INTO comp_template
          (template_id, template_version, target_tool, comp_kind, comp_endpoint,
           comp_idempotent, deadline_rule, residual_rules, approval_required,
           amount_threshold, payload_projection, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.templateId,
        row.templateVersion,
        row.targetTool,
        row.compKind,
        row.compEndpoint,
        row.compIdempotent ? 1 : 0,
        row.deadlineRule ?? null,
        JSON.stringify(row.residualRules),
        row.approvalRequired ? 1 : 0,
        row.amountThreshold ?? null,
        row.payloadProjection,
        row.status,
      )
  }

  findActiveTemplate(toolName: string): CompTemplate | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM comp_template
          WHERE target_tool = ? AND status = 'ACTIVE'
          ORDER BY template_version DESC
          LIMIT 1`,
      )
      .get(toolName) as Row | undefined
    return row === undefined ? undefined : mapTemplate(row)
  }

  readTemplate(templateId: string, templateVersion: number): CompTemplate | undefined {
    const row = this.db
      .prepare('SELECT * FROM comp_template WHERE template_id = ? AND template_version = ?')
      .get(templateId, templateVersion) as Row | undefined
    return row === undefined ? undefined : mapTemplate(row)
  }

  /* ── 目标系统登记（SA-16 §8：批 6 补读取入口） ── */

  readTarget(targetSystem: string): TargetSystemRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM target_system_registry WHERE target_system = ?')
      .get(targetSystem) as Row | undefined
    return row === undefined ? undefined : mapTarget(row)
  }

  listTargets(): readonly TargetSystemRow[] {
    const rows = this.db
      .prepare('SELECT * FROM target_system_registry ORDER BY target_system')
      .all() as Row[]
    return rows.map(mapTarget)
  }

  upsertTarget(target: TargetSystemRow): void {
    this.db
      .prepare(
        `INSERT INTO target_system_registry
          (target_system, idempotency_support, idempotency_ttl_s, probe_endpoint,
           lag_seconds, attest_digest, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_system) DO UPDATE SET
           idempotency_support = excluded.idempotency_support,
           idempotency_ttl_s = excluded.idempotency_ttl_s,
           probe_endpoint = excluded.probe_endpoint,
           lag_seconds = excluded.lag_seconds,
           attest_digest = excluded.attest_digest,
           registered_at = excluded.registered_at`,
      )
      .run(
        target.targetSystem,
        target.idempotencySupport,
        target.idempotencyTtlS ?? null,
        target.probeEndpoint ?? null,
        target.lagSeconds,
        target.attestDigest ?? null,
        target.registeredAt,
      )
  }

  /* ── 步骤 ── */

  insertStep(row: SagaStep): void {
    this.db
      .prepare(
        `INSERT INTO saga_step
          (step_id, saga_id, seq_no, topology_deps, tool_name, endpoint, side_effect_class,
           idempotency_key, idempotency_nonce, state, attempts, max_attempts, probe_endpoint,
           deadline_ms, request_digest, response_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.stepId,
        row.sagaId,
        row.seqNo,
        JSON.stringify(row.topologyDeps),
        row.toolName,
        row.endpoint,
        row.sideEffectClass,
        row.idempotencyKey,
        row.idempotencyNonce,
        row.state,
        row.attempts,
        row.maxAttempts,
        row.probeEndpoint ?? null,
        row.deadlineMs,
        row.requestDigest ?? null,
        row.responseDigest ?? null,
      )
  }

  upsertStep(row: SagaStep): void {
    this.db
      .prepare(
        `INSERT INTO saga_step
          (step_id, saga_id, seq_no, topology_deps, tool_name, endpoint, side_effect_class,
           idempotency_key, idempotency_nonce, state, attempts, max_attempts, probe_endpoint,
           deadline_ms, request_digest, response_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(step_id) DO UPDATE SET
           seq_no = excluded.seq_no,
           topology_deps = excluded.topology_deps,
           tool_name = excluded.tool_name,
           endpoint = excluded.endpoint,
           side_effect_class = excluded.side_effect_class,
           idempotency_key = excluded.idempotency_key,
           idempotency_nonce = excluded.idempotency_nonce,
           state = excluded.state,
           attempts = excluded.attempts,
           max_attempts = excluded.max_attempts,
           probe_endpoint = excluded.probe_endpoint,
           deadline_ms = excluded.deadline_ms,
           request_digest = excluded.request_digest,
           response_digest = excluded.response_digest`,
      )
      .run(
        row.stepId,
        row.sagaId,
        row.seqNo,
        JSON.stringify(row.topologyDeps),
        row.toolName,
        row.endpoint,
        row.sideEffectClass,
        row.idempotencyKey,
        row.idempotencyNonce,
        row.state,
        row.attempts,
        row.maxAttempts,
        row.probeEndpoint ?? null,
        row.deadlineMs,
        row.requestDigest ?? null,
        row.responseDigest ?? null,
      )
  }

  readStep(stepId: string): SagaStep | undefined {
    const row = this.db.prepare('SELECT * FROM saga_step WHERE step_id = ?').get(stepId) as
      | Row
      | undefined
    return row === undefined ? undefined : mapStep(row)
  }

  listSteps(sagaId: string): readonly SagaStep[] {
    const rows = this.db
      .prepare('SELECT * FROM saga_step WHERE saga_id = ? ORDER BY seq_no')
      .all(sagaId) as Row[]
    return rows.map(mapStep)
  }

  updateStep(row: SagaStep): void {
    this.db
      .prepare(
        `UPDATE saga_step SET
           seq_no = ?, topology_deps = ?, tool_name = ?, endpoint = ?, side_effect_class = ?,
           idempotency_key = ?, idempotency_nonce = ?, state = ?, attempts = ?, max_attempts = ?,
           probe_endpoint = ?, deadline_ms = ?, request_digest = ?, response_digest = ?
         WHERE step_id = ?`,
      )
      .run(
        row.seqNo,
        JSON.stringify(row.topologyDeps),
        row.toolName,
        row.endpoint,
        row.sideEffectClass,
        row.idempotencyKey,
        row.idempotencyNonce,
        row.state,
        row.attempts,
        row.maxAttempts,
        row.probeEndpoint ?? null,
        row.deadlineMs,
        row.requestDigest ?? null,
        row.responseDigest ?? null,
        row.stepId,
      )
  }

  /* ── 补偿绑定 ── */

  bindCompensation(sagaId: string, stepId: string, template: CompTemplate): void {
    const compId = `comp:${sagaId}:${stepId}`
    const payloadDigest = sha256Hex(
      canonicalJson({
        sagaId,
        stepId,
        templateId: template.templateId,
        templateVersion: template.templateVersion,
      }),
    )
    this.db
      .prepare(
        `INSERT INTO compensating_action
          (comp_id, saga_id, step_id, template_id, template_version, comp_kind,
           comp_idempotency_key, payload_digest, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      )
      .run(
        compId,
        sagaId,
        stepId,
        template.templateId,
        template.templateVersion,
        template.compKind,
        `COMP:${sagaId}:${stepId}`,
        payloadDigest,
      )
  }

  listCompensations(sagaId: string): readonly CompensatingAction[] {
    const rows = this.db
      .prepare('SELECT * FROM compensating_action WHERE saga_id = ? ORDER BY comp_id')
      .all(sagaId) as Row[]
    return rows.map(mapCompensation)
  }

  updateCompensation(row: CompensatingAction): void {
    this.db
      .prepare(
        `UPDATE compensating_action SET
           template_id = ?, template_version = ?, comp_kind = ?, comp_idempotency_key = ?,
           payload_digest = ?, state = ?, attempts = ?, max_attempts = ?, backoff_policy = ?,
           comp_deadline = ?, approver_id = ?, residual_amount = ?, residual_type = ?, cost_estimate = ?
         WHERE comp_id = ?`,
      )
      .run(
        row.templateId,
        row.templateVersion,
        row.compKind,
        row.compIdempotencyKey,
        row.payloadDigest,
        row.state,
        row.attempts,
        row.maxAttempts,
        row.backoffPolicy,
        row.compDeadline ?? null,
        row.approverId ?? null,
        row.residualAmount,
        row.residualType ?? null,
        row.costEstimate ?? null,
        row.compId,
      )
  }

  /* ── 幂等信封 ── */

  insertIdempotency(row: IdempotencyRecord): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_record
          (idem_key, namespace, saga_id, target_system, request_digest, response_digest,
           fingerprint, status, lease_owner, lease_expiry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.idemKey,
        row.namespace,
        row.sagaId,
        row.targetSystem,
        row.requestDigest,
        row.responseDigest ?? null,
        row.fingerprint ?? null,
        row.status,
        row.leaseOwner ?? null,
        row.leaseExpiry ?? null,
      )
    return result.changes === 1
  }

  readIdempotency(idemKey: string): IdempotencyRecord | undefined {
    const row = this.db.prepare('SELECT * FROM idempotency_record WHERE idem_key = ?').get(idemKey) as
      | Row
      | undefined
    return row === undefined ? undefined : mapIdempotency(row)
  }

  takeoverIdempotency(idemKey: string, owner: string, leaseExpiry: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE idempotency_record
            SET lease_owner = ?, lease_expiry = ?
          WHERE idem_key = ? AND status = 'RESERVED'
            AND (lease_expiry IS NULL OR lease_expiry < ?)`,
      )
      .run(owner, leaseExpiry, idemKey, this.now())
    return result.changes === 1
  }

  completeIdempotency(idemKey: string, responseDigest: string, fingerprint: string): void {
    this.db
      .prepare(
        `UPDATE idempotency_record
            SET status = 'DONE', response_digest = ?, fingerprint = ?
          WHERE idem_key = ?`,
      )
      .run(responseDigest, fingerprint, idemKey)
  }

  /* ── 处置与账本 ── */

  insertDlq(row: DlqEntry): void {
    this.db
      .prepare(
        `INSERT INTO dlq_entry
          (dlq_id, saga_id, source, reason, context_ref, replay_guide, entered_at, sla_deadline, disposition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.dlqId,
        row.sagaId,
        row.source,
        row.reason,
        row.contextRef ?? null,
        row.replayGuide ?? null,
        row.enteredAt,
        row.slaDeadline,
        row.disposition ?? null,
      )
  }

  insertTicket(row: SuspensionTicket): void {
    this.db
      .prepare(
        `INSERT INTO suspension_ticket
          (ticket_id, saga_id, reason, context_snapshot_ref, cost_compare, sla_deadline,
           approver_id, decision, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.ticketId,
        row.sagaId,
        row.reason,
        row.contextSnapshotRef ?? null,
        row.costCompare ?? null,
        row.slaDeadline,
        row.approverId ?? null,
        row.decision ?? null,
        row.decidedAt ?? null,
      )
  }

  readTicket(ticketId: string): SuspensionTicket | undefined {
    const row = this.db.prepare('SELECT * FROM suspension_ticket WHERE ticket_id = ?').get(ticketId) as
      | Row
      | undefined
    return row === undefined ? undefined : mapTicket(row)
  }

  insertResidual(row: ResidualLedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO residual_ledger
          (residual_id, saga_id, comp_id, residual_type, amount, note, reconciled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.residualId,
        row.sagaId,
        row.compId ?? null,
        row.residualType,
        row.amount,
        row.note ?? null,
        row.reconciled ? 1 : 0,
      )
  }

  listResiduals(sagaId: string): readonly ResidualLedgerEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM residual_ledger WHERE saga_id = ? ORDER BY residual_id')
      .all(sagaId) as Row[]
    return rows.map(mapResidual)
  }

  /* ── 快照与金库 ── */

  insertSnapshot(row: StateSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO state_snapshot
          (snapshot_id, saga_id, step_seq, context_digest, context_vault_ref, llm_decision_digest)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.snapshotId,
        row.sagaId,
        row.stepSeq ?? null,
        row.contextDigest,
        row.contextVaultRef ?? null,
        row.llmDecisionDigest ?? null,
      )
  }

  readLatestSnapshot(sagaId: string): StateSnapshot | undefined {
    const row = this.db
      .prepare('SELECT * FROM state_snapshot WHERE saga_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(sagaId) as Row | undefined
    return row === undefined ? undefined : mapSnapshot(row)
  }

  putVault(vaultId: string, cipherText: Uint8Array, keyVersion: number, classification: string): void {
    this.db
      .prepare(
        `INSERT INTO vault_sensitive (vault_id, cipher_text, key_version, classification)
         VALUES (?, ?, ?, ?)`,
      )
      .run(vaultId, cipherText, keyVersion, classification)
  }

  readVault(vaultId: string): VaultSensitive | undefined {
    const row = this.db.prepare('SELECT * FROM vault_sensitive WHERE vault_id = ?').get(vaultId) as
      | Row
      | undefined
    if (row === undefined) return undefined
    return {
      vaultId: str(row['vault_id']),
      cipherText: new Uint8Array(row['cipher_text'] as Uint8Array),
      keyVersion: num(row['key_version']),
      classification: str(row['classification']),
    }
  }

  /* ── 处置与冻结 ── */

  dlqDepth(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM dlq_entry WHERE disposition IS NULL')
      .get() as { n: number }
    return row.n
  }

  listDlqPending(): readonly DlqEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM dlq_entry WHERE disposition IS NULL ORDER BY entered_at, dlq_id')
      .all() as Row[]
    return rows.map(mapDlq)
  }

  readDlq(dlqId: string): DlqEntry | undefined {
    const row = this.db.prepare('SELECT * FROM dlq_entry WHERE dlq_id = ?').get(dlqId) as
      | Row
      | undefined
    return row === undefined ? undefined : mapDlq(row)
  }

  recordTicketDecision(ticketId: string, decision: string, approverId: string, at: number): void {
    this.db
      .prepare(
        `UPDATE suspension_ticket
            SET decision = ?, approver_id = ?, decided_at = ?
          WHERE ticket_id = ?`,
      )
      .run(decision, approverId, at, ticketId)
  }

  freezeSaga(sagaId: string, frozen: boolean, at: number): void {
    this.db
      .prepare('UPDATE saga_transaction SET frozen = ?, updated_at = ? WHERE saga_id = ?')
      .run(frozen ? 1 : 0, at, sagaId)
  }
}

/**
 * 打开（并按需迁移）sqlite 状态底座。
 *
 * @throws `BahError('schema-exists')` / `('schema-version-too-new')` 版本不匹配
 */
export function createSagaStore(options: SagaStoreOptions): SagaStoreHandle {
  return new SqliteSagaStore(options)
}
