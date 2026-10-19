/**
 * `v0_init`：建 11 张业务表 + `schema_migrations`（SA-07 §3.2 逐字 DDL）。
 *
 * 审计事实不建表：由 append-only JSONL 链记录承载；sqlite 只承载需要唯一约束与 CAS 的窄表。
 */

import { BahError } from '@bah/util'

import type { DatabaseSync } from 'node:sqlite'

/** 当前 schema 版本（迁移链单调递增）。 */
export const CURRENT_SCHEMA_VERSION = 1

/** v0 的施工级完整 DDL。 */
export const V0_INIT_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE saga_transaction (
  saga_id           TEXT PRIMARY KEY,
  parent_saga_id    TEXT REFERENCES saga_transaction(saga_id),
  business_type     TEXT NOT NULL,
  trace_id          TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('CREATED','RUNNING','SUCCEEDED','ABORTED_CLEAN',
                      'COMPENSATING','COMPENSATED','PARTIALLY_COMPENSATED','PENDING_RISK_REVIEW',
                      'GATE_HOLDING','COMPENSATION_DLQ','MANUALLY_CLOSED')),
  version           INTEGER NOT NULL DEFAULT 1,
  timeout_budget_ms INTEGER NOT NULL,
  comp_strategy     TEXT NOT NULL DEFAULT 'AUTO',
  initiator         TEXT NOT NULL,
  frozen            INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_saga_active ON saga_transaction(state)
  WHERE state NOT IN ('SUCCEEDED','ABORTED_CLEAN','COMPENSATED','MANUALLY_CLOSED');

CREATE TABLE saga_step (
  step_id           TEXT PRIMARY KEY,
  saga_id           TEXT NOT NULL REFERENCES saga_transaction(saga_id),
  seq_no            INTEGER NOT NULL,
  topology_deps     TEXT NOT NULL DEFAULT '[]',
  tool_name         TEXT NOT NULL,
  endpoint          TEXT NOT NULL,
  side_effect_class TEXT NOT NULL CHECK (side_effect_class IN
                      ('NONE','REVERSIBLE','EXTERNAL_UNDOABLE','IRREVERSIBLE')),
  idempotency_key   TEXT NOT NULL,
  idempotency_nonce TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('PLANNED','CALLING','EXECUTED','FAILED',
                      'SKIPPED','UNKNOWN','PROBING','UNRESOLVED','COMP_ISSUED','COMPENSATED')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  probe_endpoint    TEXT,
  deadline_ms       INTEGER NOT NULL,
  request_digest    TEXT,
  response_digest   TEXT,
  UNIQUE (saga_id, seq_no),
  UNIQUE (idempotency_key)
);

CREATE TABLE comp_template (
  template_id       TEXT NOT NULL,
  template_version  INTEGER NOT NULL,
  target_tool       TEXT NOT NULL,
  comp_kind         TEXT NOT NULL CHECK (comp_kind IN ('FULL_REFUND','PARTIAL','CANCEL_BOOKING',
                      'CANCEL_IN_FLIGHT','RELEASE_LOCK','NO_OP','MANUAL_ONLY')),
  comp_endpoint     TEXT NOT NULL,
  comp_idempotent   INTEGER NOT NULL DEFAULT 1,
  deadline_rule     TEXT,
  residual_rules    TEXT NOT NULL DEFAULT '[]',
  approval_required INTEGER NOT NULL DEFAULT 0,
  amount_threshold  REAL,
  payload_projection TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  PRIMARY KEY (template_id, template_version)
);

CREATE TABLE compensating_action (
  comp_id              TEXT PRIMARY KEY,
  saga_id              TEXT NOT NULL REFERENCES saga_transaction(saga_id),
  step_id              TEXT NOT NULL REFERENCES saga_step(step_id),
  template_id          TEXT NOT NULL,
  template_version     INTEGER NOT NULL,
  comp_kind            TEXT NOT NULL,
  comp_idempotency_key TEXT NOT NULL UNIQUE,
  payload_digest       TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('PENDING','ISSUED','OK','ERR','UNKNOWN','PROBING','DLQ')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 3,
  backoff_policy       TEXT NOT NULL DEFAULT '{"baseMs":30000,"maxMs":3600000,"jitter":0.3}',
  comp_deadline        INTEGER,
  approver_id          TEXT,
  residual_amount      REAL DEFAULT 0,
  residual_type        TEXT,
  cost_estimate        REAL
);

CREATE TABLE idempotency_record (
  idem_key        TEXT PRIMARY KEY,
  namespace       TEXT NOT NULL CHECK (namespace IN ('FWD','COMP')),
  saga_id         TEXT NOT NULL,
  target_system   TEXT NOT NULL,
  request_digest  TEXT NOT NULL,
  response_digest TEXT,
  fingerprint     TEXT,
  status          TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','DONE','FAILED')),
  lease_owner     TEXT,
  lease_expiry    INTEGER
);

CREATE TABLE residual_ledger (
  residual_id   TEXT PRIMARY KEY,
  saga_id       TEXT NOT NULL,
  comp_id       TEXT,
  residual_type TEXT NOT NULL,
  amount        REAL NOT NULL,
  note          TEXT,
  reconciled    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE suspension_ticket (
  ticket_id            TEXT PRIMARY KEY,
  saga_id              TEXT NOT NULL,
  reason               TEXT NOT NULL CHECK (reason IN ('RISK_REVIEW','GATE_APPROVAL',
                         'COST_DECISION','UNRESOLVED','DLQ_ESCALATION')),
  context_snapshot_ref TEXT,
  cost_compare         TEXT,
  sla_deadline         INTEGER NOT NULL,
  approver_id          TEXT,
  decision             TEXT,
  decided_at           INTEGER
);

CREATE TABLE dlq_entry (
  dlq_id      TEXT PRIMARY KEY,
  saga_id     TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('STEP','COMP','PROBE')),
  reason      TEXT NOT NULL,
  context_ref TEXT,
  replay_guide TEXT,
  entered_at  INTEGER NOT NULL,
  sla_deadline INTEGER NOT NULL,
  disposition TEXT
);

CREATE TABLE vault_sensitive (
  vault_id    TEXT PRIMARY KEY,
  cipher_text BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  classification TEXT NOT NULL
);

CREATE TABLE state_snapshot (
  snapshot_id        TEXT PRIMARY KEY,
  saga_id            TEXT NOT NULL,
  step_seq           INTEGER,
  context_digest     TEXT NOT NULL,
  context_vault_ref  TEXT,
  llm_decision_digest TEXT
);

CREATE TABLE target_system_registry (
  target_system       TEXT PRIMARY KEY,
  idempotency_support TEXT NOT NULL CHECK (idempotency_support IN ('STRONG','WEAK','NONE')),
  idempotency_ttl_s   INTEGER,
  probe_endpoint      TEXT,
  lag_seconds         INTEGER NOT NULL DEFAULT 0,
  attest_digest       TEXT,
  registered_at       INTEGER NOT NULL
);

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
INSERT INTO schema_migrations(version, applied_at) VALUES (1, 0);
`

/** v0 涉及的业务表（`schema_migrations` 单列）。 */
export const V0_BUSINESS_TABLES = [
  'saga_transaction',
  'saga_step',
  'comp_template',
  'compensating_action',
  'idempotency_record',
  'residual_ledger',
  'suspension_ticket',
  'dlq_entry',
  'vault_sensitive',
  'state_snapshot',
  'target_system_registry',
] as const

/**
 * 在空库上执行 v0。
 *
 * @throws `BahError('schema-exists')` 库内已有任何 saga 表 / 迁移表
 */
export function applyV0(db: DatabaseSync): void {
  const existing = existingTables(db)
  const clash = existing.filter(
    (name) => name === 'schema_migrations' || (V0_BUSINESS_TABLES as readonly string[]).includes(name),
  )
  if (clash.length > 0) {
    throw new BahError(
      'schema-exists',
      `bah-saga: schema-exists: 目标库已存在 saga 表（${clash.join(', ')}），拒绝重复执行 v0_init`,
      { tables: clash },
    )
  }
  db.exec(V0_INIT_SQL)
}

/** 查询库内用户表名。 */
export function existingTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]
  return rows.map((row) => row.name)
}
