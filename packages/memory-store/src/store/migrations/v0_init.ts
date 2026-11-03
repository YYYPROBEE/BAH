/**
 * `v0_init`：建 3 张表 + `schema_migrations`（设计文档 §2 逐字 DDL）。
 *
 * AccessLog 不入库：它是 append-only 的 ndjson，审计面独立于查询面（§2 注）。
 */

import { RETENTION_BASIS } from '../../words.ts'

import type { DatabaseSync } from 'node:sqlite'

/** 当前 schema 版本（迁移链单调递增）。 */
export const CURRENT_SCHEMA_VERSION = 1

export const V0_INIT_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE memory_unit (
  unit_id         TEXT PRIMARY KEY,
  tenant          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  unit_type       TEXT NOT NULL CHECK (unit_type IN ('entity_fact','preference')),
  scene_tags      TEXT NOT NULL,
  sensitivity     INTEGER NOT NULL CHECK (sensitivity BETWEEN 0 AND 3),
  state           TEXT NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active','superseded','frozen')),
  subject         TEXT NOT NULL,
  predicate       TEXT NOT NULL,
  object          TEXT NOT NULL,
  valid_from      TEXT NOT NULL,
  valid_to        TEXT,
  superseded_by   TEXT,
  source_type     TEXT NOT NULL CHECK (source_type IN ('user_statement')),
  confidence      REAL NOT NULL DEFAULT 0.9,
  provenance      TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_verified_at TEXT,
  CHECK (NOT (state='superseded' AND superseded_by IS NULL)),
  CHECK (NOT (state='active' AND superseded_by IS NOT NULL))
);
CREATE INDEX idx_mu_query ON memory_unit(tenant, user_id, subject, predicate, state);
CREATE INDEX idx_mu_scene  ON memory_unit(tenant, user_id, scene_tags, state);
CREATE INDEX idx_mu_hash   ON memory_unit(content_hash);

CREATE TABLE procedural_unit (
  proc_id         TEXT PRIMARY KEY,
  tenant          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  trigger_desc    TEXT NOT NULL,
  action_desc     TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending_confirm'
                    CHECK (state IN ('pending_confirm','active','retired')),
  version         INTEGER NOT NULL DEFAULT 1,
  confirmations   TEXT NOT NULL DEFAULT '[]',
  provenance      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE retention_basis (
  predicate            TEXT PRIMARY KEY,
  allowed_sensitivity  INTEGER NOT NULL,
  max_retention_days   INTEGER NOT NULL,
  scene_whitelist      TEXT NOT NULL,
  erasure_policy       TEXT NOT NULL DEFAULT 'logical_then_physical'
);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`

/** 库内已存在的表名（判断空库用）。 */
export function existingTables(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string
  }[]
  return rows.map((row) => row.name)
}

/**
 * 建表并灌 `retention_basis` 种子。
 *
 * 种子**从 `words.ts` 导入**而不是在 SQL 里写死：词表是唯一真源，两处各存一份必然漂移
 * （改了谓词白名单却忘了改种子 → G2 依据门按旧数据放行，是最难发现的假绿）。
 */
export function applyV0(db: DatabaseSync, now: string): void {
  db.exec(V0_INIT_SQL)

  const insert = db.prepare(
    `INSERT INTO retention_basis
       (predicate, allowed_sensitivity, max_retention_days, scene_whitelist, erasure_policy)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const row of RETENTION_BASIS) {
    insert.run(
      row.predicate,
      row.allowedSensitivity,
      row.maxRetentionDays,
      JSON.stringify(row.sceneWhitelist),
      row.erasurePolicy,
    )
  }
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
    CURRENT_SCHEMA_VERSION,
    now,
  )
}
