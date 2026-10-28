/**
 * 链行租户（租户与鉴权 01 · TA-15）。
 *
 * 三条要证明的事：
 * 1. 新行带 `tenant`，历史行没有也能读（**向后兼容**，不许把老证据判死）；
 * 2. `tenant` **进哈希**——把它改掉必须断链，否则这一列只是没人校验的注释；
 * 3. 一处断链必须能被 `verifyContinuity` 精确指到 `brokenAt`（防"改两层扫描"的钉子：扫不到 = 没问题）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createSagaAudit, type ChainRecord } from './index.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-chain-tenant-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 建链句柄（默认不签名：本文件验的是哈希与租户字段）。 */
function chain(dir: string, tenant?: string) {
  return createSagaAudit({
    now: () => 1_700_000_000_000,
    rootDir: dir,
    fsync: false,
    signedTypes: [],
    warn: () => undefined,
    ...(tenant === undefined ? {} : { tenant }),
  })
}

function rowsOf(dir: string, sagaId: string): ChainRecord[] {
  return readFileSync(join(dir, sagaId, 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ChainRecord)
}

describe('ChainRecord.tenant', () => {
  it('TA-15-1 新行带租户；路径仍是 <root>/<saga>/audit.jsonl（扫描口径不变）', () => {
    const dir = tempDir()
    const writer = chain(dir, 'acme-bank')
    writer.append('s-1', 'tool/call', { callId: 'call-1' })
    const rows = rowsOf(dir, 's-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tenant).toBe('acme-bank')
    expect(writer.verifyContinuity('s-1')).toEqual({ ok: true })
  })

  it('TA-15-2 改 tenant 字段 → 断链（租户进哈希，不是没人校验的注释）', () => {
    const dir = tempDir()
    const writer = chain(dir, 'acme')
    writer.append('s-1', 'tool/call', { callId: 'call-1' })
    writer.append('s-1', 'tool/result', { callId: 'call-1' })

    const path = join(dir, 's-1', 'audit.jsonl')
    const rows = rowsOf(dir, 's-1')
    rows[0] = { ...(rows[0] as ChainRecord), tenant: 'other' }
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    expect(chain(dir).verifyContinuity('s-1')).toMatchObject({ ok: false, brokenAt: 1 })
  })

  it('TA-15-3 历史行（没有 tenant）仍可校验：向后兼容，不把老链判死', () => {
    const dir = tempDir()
    chain(dir).append('s-old', 'saga/created', { sagaId: 's-old' })
    expect(rowsOf(dir, 's-old')[0]).not.toHaveProperty('tenant')
    expect(chain(dir).verifyContinuity('s-old')).toEqual({ ok: true })
  })

  it('TA-15-4 同一目录下有租户行与历史行：各自哈希都对，连续性不误报', () => {
    const dir = tempDir()
    chain(dir).append('s-legacy', 'saga/created', { sagaId: 's-legacy' })
    chain(dir, 'demo').append('s-new', 'saga/created', { sagaId: 's-new' })

    const reader = chain(dir)
    expect(reader.verifyContinuity('s-legacy')).toEqual({ ok: true })
    expect(reader.verifyContinuity('s-new')).toEqual({ ok: true })
    // 全量扫描也必须是绿的（两层/一层扫描口径混用会在这里红）
    expect(reader.verifyContinuity()).toEqual({ ok: true })
  })
})
