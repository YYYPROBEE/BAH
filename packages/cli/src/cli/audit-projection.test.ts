import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChainFile, loadSqlite } from '@bah/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import {
  projectionDiffFor,
  projectionFor,
  readTransactionStates,
  reverseGapsOf,
} from './audit-projection.ts'

import type { ChainProjectionInput, ProjectionDiff } from './audit-projection.ts'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-projection-'))
  cleanup.push(dir)
  return dir
}

function sqlite(): ReturnType<typeof loadSqlite>['DatabaseSync'] {
  return loadSqlite().DatabaseSync
}

function createDb(path: string, rows: ReadonlyArray<readonly [string, string]>): void {
  const Database = sqlite()
  const db = new Database(path)
  db.exec('CREATE TABLE saga_transaction (saga_id TEXT PRIMARY KEY, state TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO saga_transaction (saga_id, state) VALUES (?, ?)')
  for (const [sagaId, state] of rows) insert.run(sagaId, state)
  db.close()
}

function entries(dir: string): string[] {
  return readdirSync(dir).sort()
}

function chain(): ChainFile {
  return new ChainFile({ rootDir: join(root(), 'chains'), fsync: false, warn: () => undefined })
}

const INPUTS: readonly ChainProjectionInput[] = [
  { sagaId: 'ok', hasEvents: true, chainOk: true },
  { sagaId: 'drift', hasEvents: true, chainOk: true },
  { sagaId: 'missing', hasEvents: true, chainOk: true },
  { sagaId: 'broken', hasEvents: true, chainOk: false },
  { sagaId: 'empty', hasEvents: false, chainOk: true },
  { sagaId: 'error', hasEvents: true, chainOk: true },
]

const DIFF: ProjectionDiff = (_chain, sagaId) => {
  if (sagaId === 'error') throw new Error('boom')
  return sagaId === 'drift' ? 1 : 0
}

describe('reverseGapsOf', () => {
  it('只保留库里有、链上没有的 saga，并排序', () => {
    expect(reverseGapsOf(['a', 'b'], ['b', 'c', 'a', 'c'])).toEqual(['c'])
  })
})

describe('readTransactionStates', () => {
  it('干净库：immutable 只读，零 sidecar', () => {
    const dir = root()
    const dbPath = join(dir, 'saga.sqlite')
    createDb(dbPath, [['s1', 'CREATED']])
    const before = entries(dir)

    expect(readTransactionStates(dbPath)).toEqual(new Map([['s1', 'CREATED']]))
    expect(entries(dir)).toEqual(before)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
  })

  it('活动 WAL：复制到临时目录读取，源目录条目不变', () => {
    const dir = root()
    const dbPath = join(dir, 'saga.sqlite')
    const Database = sqlite()
    const db = new Database(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA wal_autocheckpoint = 0')
    db.exec('CREATE TABLE saga_transaction (saga_id TEXT PRIMARY KEY, state TEXT NOT NULL)')
    db.prepare('INSERT INTO saga_transaction (saga_id, state) VALUES (?, ?)').run('s1', 'RUNNING')
    expect(existsSync(`${dbPath}-wal`)).toBe(true)
    const before = entries(dir)

    expect(readTransactionStates(dbPath)).toEqual(new Map([['s1', 'RUNNING']]))
    expect(entries(dir)).toEqual(before)
    db.close()
  })

  it('非 Sqlite / 缺表 → db-invalid', () => {
    const dir = root()
    const bad = join(dir, 'bad.sqlite')
    createDb(bad, [])
    const Database = sqlite()
    const db = new Database(bad)
    db.exec('DROP TABLE saga_transaction')
    db.close()

    expect(() => readTransactionStates(bad)).toThrow(/db-invalid/)
  })

  it('目录当库路径 → db-invalid', () => {
    const dir = root()
    expect(() => readTransactionStates(dir)).toThrow(/db-invalid/)
  })
})

describe('projectionDiffFor', () => {
  it('空链：运行时 CREATED → diff=0；其他状态 → diff=1', () => {
    const chainFile = chain()
    expect(projectionDiffFor(chainFile, 's1', 'CREATED')).toBe(0)
    expect(projectionDiffFor(chainFile, 's1', 'SUCCEEDED')).toBe(1)
  })
})

describe('projectionFor', () => {
  it('--no-projection → skipped-disabled', () => {
    const result = projectionFor(chain(), INPUTS, join(root(), 'missing.sqlite'), {
      noProjection: true,
      diff: DIFF,
    })
    expect(result.dbState).toBe('disabled')
    expect(result.bySaga.get('ok')).toEqual({ state: 'skipped-disabled', diff: null })
    expect(result.reverseGaps).toEqual([])
  })

  it('库不存在 → skipped-no-db，不计异常', () => {
    const result = projectionFor(chain(), INPUTS, join(root(), 'missing.sqlite'), {
      noProjection: false,
      diff: DIFF,
    })
    expect(result.dbState).toBe('missing')
    expect(result.bySaga.get('ok')).toEqual({ state: 'skipped-no-db', diff: null })
  })

  it('库不可读 → 逐链 db-invalid', () => {
    const dir = root()
    const bad = join(dir, 'bad.sqlite')
    createDb(bad, [])
    const Database = sqlite()
    const db = new Database(bad)
    db.exec('DROP TABLE saga_transaction')
    db.close()

    const result = projectionFor(chain(), INPUTS, bad, { noProjection: false, diff: DIFF })
    expect(result.dbState).toBe('invalid')
    expect(result.bySaga.get('ok')).toEqual({ state: 'db-invalid', diff: null })
  })

  it('覆盖 diff-zero / diff-nonzero / runtime-missing / broken / diff-error 与反向缺口', () => {
    const dir = root()
    const dbPath = join(dir, 'saga.sqlite')
    createDb(dbPath, [
      ['ok', 'CREATED'],
      ['drift', 'CREATED'],
      ['broken', 'CREATED'],
      ['empty', 'CREATED'],
      ['error', 'CREATED'],
      ['extra', 'CREATED'],
    ])

    const result = projectionFor(chain(), INPUTS, dbPath, { noProjection: false, diff: DIFF })
    expect(result.dbState).toBe('ok')
    expect(result.bySaga.get('ok')).toEqual({ state: 'diff-zero', diff: 0 })
    expect(result.bySaga.get('drift')).toEqual({ state: 'diff-nonzero', diff: 1 })
    expect(result.bySaga.get('missing')).toEqual({ state: 'runtime-missing', diff: null })
    expect(result.bySaga.get('broken')).toEqual({ state: 'skipped-chain-broken', diff: null })
    expect(result.bySaga.get('empty')).toEqual({ state: 'runtime-missing', diff: null })
    expect(result.bySaga.get('error')).toEqual({ state: 'diff-error', diff: null })
    expect(result.reverseGaps).toEqual(['empty', 'extra'])
  })
})
