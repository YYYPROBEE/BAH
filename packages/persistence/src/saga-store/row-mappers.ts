/**
 * sqlite 行 → 领域对象（持久化边界的唯一校验面）。
 *
 * 从 `index.ts` 拆出：SQL/事务/store 与"列名 + 类型校验"是两种变化原因，
 * 混在一个 900 行文件里会让行映射的 fail-loud 口径被 SQL 改动淹没。
 */

import { BahError } from '@bah/util'

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
} from './types.ts'

export type Row = Record<string, unknown>

/** 标量列读取（store 的计数/摘要查询复用同一套 fail-loud 校验）。 */
export const rowString = (value: unknown): string => str(value)
export const rowNumber = (value: unknown): number => num(value)

function invalidRow(column: string, expected: string, value: unknown): BahError {
  const where = column === '?' ? '行值' : `列 ${column}`
  return new BahError('invalid-row', `bah-saga: invalid-row: ${where}必须是${expected}`, {
    column,
    expected,
    value,
  })
}

const str = (value: unknown): string => {
  if (typeof value !== 'string') throw invalidRow('?', '字符串', value)
  return value
}

const num = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidRow('?', '有限数字', value)
  }
  return value
}

const optStr = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : str(value)

const optNum = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : num(value)

function parseStringArray(raw: unknown): readonly string[] {
  const parsed: unknown = JSON.parse(str(raw))
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new BahError('invalid-row', 'bah-saga: invalid-row: JSON 列必须是字符串数组', { raw })
  }
  return parsed
}

export function mapTransaction(row: Row): SagaTransaction {
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

export function mapStep(row: Row): SagaStep {
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

export function mapTemplate(row: Row): CompTemplate {
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

export function mapTarget(row: Row): TargetSystemRow {
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

export function mapCompensation(row: Row): CompensatingAction {
  return {
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

export function mapIdempotency(row: Row): IdempotencyRecord {
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

export function mapDlq(row: Row): DlqEntry {
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

export function mapTicket(row: Row): SuspensionTicket {
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

export function mapResidual(row: Row): ResidualLedgerEntry {
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

export function mapSnapshot(row: Row): StateSnapshot {
  return {
    snapshotId: str(row['snapshot_id']),
    sagaId: str(row['saga_id']),
    stepSeq: optNum(row['step_seq']),
    contextDigest: str(row['context_digest']),
    contextVaultRef: optStr(row['context_vault_ref']),
    llmDecisionDigest: optStr(row['llm_decision_digest']),
  }
}
