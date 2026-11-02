/**
 * 投影重算的只读入口。
 *
 * 零写纪律（R159/R163）：
 * - 干净库：`file:...?immutable=1` + `readOnly` 打开，不生成 `-wal` / `-shm`；
 * - 有活动 `-wal`：把 `db` + `-wal`（以及存在的 `-shm`）复制到临时目录，
 *   打开副本完成查询后删除；源目录一个字节都不写。
 * - 禁止 saga 存储构造函数：它会建库、`migrate`、切 WAL。
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createContext } from '@bah/core'
import { BahError, reasonOf } from '@bah/util'
import { PROJECTION_STORE, loadSqlite, projectionDiff } from '@bah/persistence'
import { reduceSaga } from '@bah/saga'

import type { ChainFile, ProjectionReducer } from '@bah/persistence'

/** 一条链的投影结论。 */
export type ProjectionState =
  | 'diff-zero'
  | 'diff-nonzero'
  | 'runtime-missing'
  | 'skipped-no-db'
  | 'skipped-disabled'
  | 'skipped-chain-broken'
  | 'diff-error'
  | 'db-invalid'

/** 单链投影结果。 */
export interface ProjectionEntry {
  readonly state: ProjectionState
  readonly diff: number | null
}

/** 目录级投影结果。 */
export interface ProjectionAudit {
  readonly bySaga: ReadonlyMap<string, ProjectionEntry>
  readonly reverseGaps: readonly string[]
  readonly dbPath: string
  readonly dbState: 'ok' | 'missing' | 'disabled' | 'invalid'
}

/** 单链投影输入。 */
export interface ChainProjectionInput {
  readonly sagaId: string
  readonly hasEvents: boolean
  readonly chainOk: boolean
}

/** 投影 diff 端口：测试注入假实现，生产注入 `projectionDiffFor`。 */
export type ProjectionDiff = (chain: ChainFile, sagaId: string, state: string) => number

/** 用真实 `reduceSaga` + 已读运行时状态重算一条链。 */
export function projectionDiffFor(chain: ChainFile, sagaId: string, state: string): number {
  const ctx = createContext()
  ctx.provide(PROJECTION_STORE as never, {
    loadTransaction: (id: string) => (id === sagaId ? { state } : undefined),
  })
  return projectionDiff(ctx, chain, sagaId, reduceSaga as unknown as ProjectionReducer)
}

/** 库里有、链上没有（或链为空）的事务：运行时状态失去证据链背书。 */
export function reverseGapsOf(chainIds: Iterable<string>, dbIds: Iterable<string>): string[] {
  const chains = new Set(chainIds)
  return [...new Set(dbIds)].filter((sagaId) => !chains.has(sagaId)).sort()
}

/**
 * 读 `saga_transaction` 的两列。
 *
 * 不做恢复、不迁移、不建文件；任何打开/查询失败都归一为 `db-invalid`。
 */
export function readTransactionStates(dbPath: string): Map<string, string> {
  const walPath = `${dbPath}-wal`
  const hasLiveWal = existsSync(walPath) && statSync(walPath).size > 0
  if (!hasLiveWal) {
    return queryStates(`${pathToFileURL(dbPath).href}?immutable=1`, true, dbPath)
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'bah-audit-db-'))
  try {
    const copy = join(tempDir, 'saga.sqlite')
    copyFileSync(dbPath, copy)
    copyFileSync(walPath, `${copy}-wal`)
    const shmPath = `${dbPath}-shm`
    if (existsSync(shmPath)) copyFileSync(shmPath, `${copy}-shm`)
    return queryStates(copy, false, dbPath)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function queryStates(location: string, readOnly: boolean, original: string): Map<string, string> {
  const { DatabaseSync } = loadSqlite()
  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    db = new DatabaseSync(location, readOnly ? { readOnly: true } : {})
    const rows = db
      .prepare('SELECT saga_id AS sagaId, state FROM saga_transaction')
      .all() as Array<{ sagaId: string; state: string }>
    return new Map(rows.map((row) => [row.sagaId, row.state]))
  } catch (error) {
    throw new BahError('db-invalid', `bah-audit: db-invalid: ${reasonOf(error)}`, {
      dbPath: original,
    })
  } finally {
    db?.close()
  }
}

/** 目录级投影审计。 */
export function projectionFor(
  chain: ChainFile,
  chains: readonly ChainProjectionInput[],
  dbPath: string,
  options: { readonly noProjection: boolean; readonly diff: ProjectionDiff },
): ProjectionAudit {
  if (options.noProjection) return allSkipped(chains, 'skipped-disabled', 'disabled', dbPath)
  if (!existsSync(dbPath)) return allSkipped(chains, 'skipped-no-db', 'missing', dbPath)

  let states: Map<string, string>
  try {
    states = readTransactionStates(dbPath)
  } catch {
    return allSkipped(chains, 'db-invalid', 'invalid', dbPath)
  }

  const bySaga = new Map<string, ProjectionEntry>()
  for (const input of chains) {
    if (!input.chainOk) {
      bySaga.set(input.sagaId, { state: 'skipped-chain-broken', diff: null })
      continue
    }
    if (!input.hasEvents || !states.has(input.sagaId)) {
      bySaga.set(input.sagaId, { state: 'runtime-missing', diff: null })
      continue
    }
    try {
      const diff = options.diff(chain, input.sagaId, states.get(input.sagaId) as string)
      bySaga.set(input.sagaId, { state: diff === 0 ? 'diff-zero' : 'diff-nonzero', diff })
    } catch {
      bySaga.set(input.sagaId, { state: 'diff-error', diff: null })
    }
  }

  return {
    bySaga,
    reverseGaps: reverseGapsOf(
      chains.filter((input) => input.hasEvents).map((input) => input.sagaId),
      states.keys(),
    ),
    dbPath,
    dbState: 'ok',
  }
}

function allSkipped(
  chains: readonly ChainProjectionInput[],
  state: ProjectionState,
  dbState: ProjectionAudit['dbState'],
  dbPath: string,
): ProjectionAudit {
  const bySaga = new Map<string, ProjectionEntry>()
  for (const input of chains) bySaga.set(input.sagaId, { state, diff: null })
  return { bySaga, reverseGaps: [], dbPath, dbState }
}
