/**
 * 存储层（设计文档 §2）：SQLite 实现。
 *
 * 复用 `@bah/persistence` 的 `loadSqlite()`——仓库里已经有 `node:sqlite` 的加载口
 * （含 ExperimentalWarning 过滤），抄一份只会多一处需要跟着 Node 版本改的地方。
 * **零新增依赖**：不引 `better-sqlite3`。
 *
 * 层的边界：本文件只做「行 ↔ 对象」的搬运与事务，**不做任何判决**。哪些行该被过滤、
 * 过滤原因是什么，全在 `read/filter.ts` 的纯函数里——判决与副作用分离，才能单独测。
 */

import { BahError } from '@bah/util'
import { loadSqlite } from '@bah/persistence'

import { RETENTION_BASIS } from '../words.ts'
import { CURRENT_SCHEMA_VERSION, applyV0, existingTables } from './migrations/v0_init.ts'

import type { DatabaseSync } from 'node:sqlite'
import type {
  ConfirmationRecord,
  ProceduralUnit,
  Provenance,
  Scene,
  SourceType,
  UnitState,
  UnitType,
  VaultState,
} from '../types.ts'

/** `memory_unit` 的一行（JSON 列已解析成对象）。 */
export interface MemoryUnitRow {
  readonly unitId: string
  readonly tenant: string
  readonly userId: string
  readonly unitType: UnitType
  readonly sceneTags: readonly Scene[]
  readonly sensitivity: number
  readonly state: UnitState
  readonly subject: string
  readonly predicate: string
  readonly object: unknown
  readonly validFrom: string
  readonly validTo: string | null
  readonly supersededBy: string | null
  readonly sourceType: SourceType
  readonly confidence: number
  readonly provenance: Provenance
  readonly contentHash: string
  readonly createdAt: string
  readonly lastVerifiedAt: string | null
}

export interface MemoryStoreOptions {
  /** sqlite 文件路径；`:memory:` 仅用于测试。 */
  readonly dbPath: string
  /** 时钟注入：测试要造"30 天前的记忆"，不能靠 `Date.now()`。 */
  readonly now?: () => number
}

export interface MemoryStore {
  close(): void
  /** 幂等键查询：命中任意状态的行都算命中（`IDEMPOTENT_SKIP` 的判据）。 */
  findUnitByHash(tenant: string, userId: string, hash: string): MemoryUnitRow | undefined
  /**
   * 同键的全部现行行。
   *
   * 返回**数组**而不是单条：正常写入下最多一条，但历史脏数据或并发写入可能留下多条，
   * 而"只淘汰第一条"会让其余继续 active——读取时同一个问题召回两个互相矛盾的答案，
   * 比召不回来更糟。宁可在写入时多淘汰一行，也不能让读取面对自相矛盾的事实。
   */
  listActiveUnits(
    tenant: string,
    userId: string,
    subject: string,
    predicate: string,
  ): MemoryUnitRow[]
  /**
   * 单事务写入：先标记旧行为 superseded，再插入新行。
   *
   * 拆成两次调用会让"旧行已废、新行未写"成为可能状态——那一刻用户既没有旧记忆也没有
   * 新记忆，跨会话记忆层最不该出现的窗口。
   */
  writeUnit(row: MemoryUnitRow, supersededIds: readonly string[]): void
  /** 该用户全部行（过滤判定交给 `read/filter.ts`）。 */
  listUnits(tenant: string, userId: string, limit?: number): MemoryUnitRow[]
  /** 影子核验成功后回写时间戳（M3 使用）。 */
  markVerified(unitId: string, at: string): void
  /** `retention_basis` 当前行（复位后要能证明种子被完整重灌）。 */
  listBasis(): { readonly predicate: string; readonly allowedSensitivity: number }[]
  reset(): void

  insertProcedural(row: ProceduralUnit): void
  saveProcedural(row: ProceduralUnit): void
  listProcedural(tenant: string, userId: string): ProceduralUnit[]
}

interface MemoryUnitRecord {
  unit_id: string
  tenant: string
  user_id: string
  unit_type: UnitType
  scene_tags: string
  sensitivity: number
  state: UnitState
  subject: string
  predicate: string
  object: string
  valid_from: string
  valid_to: string | null
  superseded_by: string | null
  source_type: SourceType
  confidence: number
  provenance: string
  content_hash: string
  created_at: string
  last_verified_at: string | null
}

interface ProceduralRecord {
  proc_id: string
  tenant: string
  user_id: string
  trigger_desc: string
  action_desc: string
  state: VaultState
  version: number
  confirmations: string
  provenance: string
  created_at: string
}

function toUnitRow(record: MemoryUnitRecord): MemoryUnitRow {
  return {
    unitId: record.unit_id,
    tenant: record.tenant,
    userId: record.user_id,
    unitType: record.unit_type,
    sceneTags: JSON.parse(record.scene_tags) as Scene[],
    sensitivity: record.sensitivity,
    state: record.state,
    subject: record.subject,
    predicate: record.predicate,
    object: JSON.parse(record.object) as unknown,
    validFrom: record.valid_from,
    validTo: record.valid_to,
    supersededBy: record.superseded_by,
    sourceType: record.source_type,
    confidence: record.confidence,
    provenance: JSON.parse(record.provenance) as Provenance,
    contentHash: record.content_hash,
    createdAt: record.created_at,
    lastVerifiedAt: record.last_verified_at,
  }
}

function toProcedural(record: ProceduralRecord): ProceduralUnit {
  return {
    procId: record.proc_id,
    tenant: record.tenant,
    userId: record.user_id,
    triggerDesc: record.trigger_desc,
    actionDesc: record.action_desc,
    state: record.state,
    version: record.version,
    confirmations: JSON.parse(record.confirmations) as ConfirmationRecord[],
    provenance: JSON.parse(record.provenance) as Provenance,
    createdAt: record.created_at,
  }
}

class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(options: MemoryStoreOptions) {
    const { DatabaseSync: Database } = loadSqlite()
    const db = new Database(options.dbPath)
    this.now = options.now ?? Date.now
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA foreign_keys = ON')
      this.migrate(db)
    } catch (error) {
      db.close()
      throw error
    }
    this.db = db
  }

  /**
   * 迁移：空库走 v0；已有库只接受**版本相等**。
   *
   * 高版本一律拒绝（fail-loud）：旧代码读新库会把新列当不存在，静默丢字段比启动失败更危险。
   */
  private migrate(db: DatabaseSync): void {
    const tables = existingTables(db)
    if (!tables.includes('schema_migrations')) {
      applyV0(db, new Date(this.now()).toISOString())
      return
    }
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      | { version: number | null }
      | undefined
    const version = row?.version ?? 0
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new BahError(
        'schema-version-too-new',
        `bah-memory: schema-version-too-new: 库版本 ${version} 高于代码支持的 ${CURRENT_SCHEMA_VERSION}，拒绝打开`,
        { version, supported: CURRENT_SCHEMA_VERSION },
      )
    }
    if (version < CURRENT_SCHEMA_VERSION) {
      throw new BahError(
        'schema-version-unsupported',
        `bah-memory: schema-version-unsupported: 库版本 ${version} 缺少到 ${CURRENT_SCHEMA_VERSION} 的迁移路径`,
        { version, supported: CURRENT_SCHEMA_VERSION },
      )
    }
  }

  close(): void {
    this.db.close()
  }

  findUnitByHash(tenant: string, userId: string, hash: string): MemoryUnitRow | undefined {
    const record = this.db
      .prepare('SELECT * FROM memory_unit WHERE tenant = ? AND user_id = ? AND content_hash = ? LIMIT 1')
      .get(tenant, userId, hash) as MemoryUnitRecord | undefined
    return record === undefined ? undefined : toUnitRow(record)
  }

  listActiveUnits(
    tenant: string,
    userId: string,
    subject: string,
    predicate: string,
  ): MemoryUnitRow[] {
    const records = this.db
      .prepare(
        `SELECT * FROM memory_unit
          WHERE tenant = ? AND user_id = ? AND subject = ? AND predicate = ? AND state = 'active'`,
      )
      .all(tenant, userId, subject, predicate) as unknown as MemoryUnitRecord[]
    return records.map(toUnitRow)
  }

  writeUnit(row: MemoryUnitRow, supersededIds: readonly string[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const supersede = this.db.prepare(
        `UPDATE memory_unit
            SET state = 'superseded', superseded_by = ?, valid_to = ?
          WHERE unit_id = ? AND state = 'active'`,
      )
      for (const oldId of supersededIds) {
        supersede.run(row.unitId, row.validFrom, oldId)
      }
      this.db
        .prepare(
          `INSERT INTO memory_unit
            (unit_id, tenant, user_id, unit_type, scene_tags, sensitivity, state, subject, predicate,
             object, valid_from, valid_to, superseded_by, source_type, confidence, provenance,
             content_hash, created_at, last_verified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.unitId,
          row.tenant,
          row.userId,
          row.unitType,
          JSON.stringify(row.sceneTags),
          row.sensitivity,
          row.state,
          row.subject,
          row.predicate,
          JSON.stringify(row.object),
          row.validFrom,
          row.validTo,
          row.supersededBy,
          row.sourceType,
          row.confidence,
          JSON.stringify(row.provenance),
          row.contentHash,
          row.createdAt,
          row.lastVerifiedAt,
        )
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // sqlite 可能已自动回滚：保留原始错误，不掩盖。
      }
      throw error
    }
  }

  listUnits(tenant: string, userId: string, limit = 500): MemoryUnitRow[] {
    const records = this.db
      .prepare(
        `SELECT * FROM memory_unit
          WHERE tenant = ? AND user_id = ?
          ORDER BY confidence DESC, valid_from DESC
          LIMIT ?`,
      )
      .all(tenant, userId, limit) as unknown as MemoryUnitRecord[]
    return records.map(toUnitRow)
  }

  markVerified(unitId: string, at: string): void {
    this.db.prepare('UPDATE memory_unit SET last_verified_at = ? WHERE unit_id = ?').run(at, unitId)
  }

  listBasis(): { predicate: string; allowedSensitivity: number }[] {
    return this.db
      .prepare('SELECT predicate, allowed_sensitivity AS allowedSensitivity FROM retention_basis ORDER BY predicate')
      .all() as unknown as { predicate: string; allowedSensitivity: number }[]
  }

  /**
   * 沙箱复位：清空两张业务表 + `retention_basis` 重灌种子。
   *
   * `retention_basis` 选择"清空重灌"而不是 UPSERT：种子只能有一个来源（`words.ts`），
   * 增量更新会留下已被删除的旧谓词，让 G2 依据门按不存在的规则放行。
   */
  reset(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM memory_unit')
      this.db.exec('DELETE FROM procedural_unit')
      this.db.exec('DELETE FROM retention_basis')
      const insert = this.db.prepare(
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
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 同上：不掩盖原始错误。
      }
      throw error
    }
  }

  insertProcedural(row: ProceduralUnit): void {
    this.db
      .prepare(
        `INSERT INTO procedural_unit
           (proc_id, tenant, user_id, trigger_desc, action_desc, state, version, confirmations,
            provenance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.procId,
        row.tenant,
        row.userId,
        row.triggerDesc,
        row.actionDesc,
        row.state,
        row.version,
        JSON.stringify(row.confirmations),
        JSON.stringify(row.provenance),
        row.createdAt,
      )
  }

  saveProcedural(row: ProceduralUnit): void {
    this.db
      .prepare(
        `UPDATE procedural_unit
            SET state = ?, version = ?, confirmations = ?
          WHERE proc_id = ?`,
      )
      .run(row.state, row.version, JSON.stringify(row.confirmations), row.procId)
  }

  listProcedural(tenant: string, userId: string): ProceduralUnit[] {
    const records = this.db
      .prepare(
        `SELECT * FROM procedural_unit
          WHERE tenant = ? AND user_id = ?
          ORDER BY created_at ASC`,
      )
      .all(tenant, userId) as unknown as ProceduralRecord[]
    return records.map(toProcedural)
  }
}

export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  return new SqliteMemoryStore(options)
}
