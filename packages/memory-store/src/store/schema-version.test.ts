/**
 * 打开既有库的版本闸门（施工文档 §2：「版本相等」是唯一可接受状态）。
 *
 * 旧代码读新库会把新列当不存在，静默丢字段；低版本库没有迁移路径时同理。
 * 两种都必须在 open 时 fail-loud——这里把两条拒绝路径钉住，避免「先兼容一下」
 * 变成静默降级。与 `saga-store.test.ts` 的 T-SA07-004 同口径。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { createMemoryStore } from './index.ts'
import { CURRENT_SCHEMA_VERSION } from './migrations/v0_init.ts'

const FIXED_NOW = Date.parse('2026-10-22T10:00:00.000Z')

function withDatabaseFile(run: (dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bah-memory-version-'))
  try {
    const dbPath = join(dir, 'memory.sqlite')
    createMemoryStore({ dbPath, now: () => FIXED_NOW }).close()
    run(dbPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function forceVersion(dbPath: string, version: number): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('UPDATE schema_migrations SET version = ?').run(version)
  } finally {
    db.close()
  }
}

describe('schema 版本闸门', () => {
  it('库版本高于当前代码 → 拒绝打开（schema-version-too-new）', () => {
    withDatabaseFile((dbPath) => {
      forceVersion(dbPath, CURRENT_SCHEMA_VERSION + 1)
      expect(() => createMemoryStore({ dbPath, now: () => FIXED_NOW })).toThrow(
        /schema-version-too-new/,
      )
    })
  })

  it('库版本低于当前代码且无迁移路径 → 拒绝打开（schema-version-unsupported）', () => {
    withDatabaseFile((dbPath) => {
      forceVersion(dbPath, 0)
      expect(() => createMemoryStore({ dbPath, now: () => FIXED_NOW })).toThrow(
        /schema-version-unsupported/,
      )
    })
  })
})
