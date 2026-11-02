import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { merkleRootOf } from '@bah/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAnchorsAudit, readAnchors } from './audit-anchors.ts'

import type { ChainRecord } from '@bah/persistence'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-anchors-'))
  cleanup.push(dir)
  return dir
}

const NOV = Date.UTC(2023, 10, 1)
const DEC = Date.UTC(2023, 11, 1)

function row(s: string, q: number, recordedAt: number, r: string): ChainRecord {
  return {
    s,
    q,
    t: 'saga/created',
    sub: s,
    hb: [],
    d: 'd',
    keyVersion: 1,
    p: '',
    r,
    recordedAt,
  }
}

const ROWS = [row('a', 1, NOV, 'r1'), row('a', 2, NOV, 'r2'), row('b', 1, DEC, 'r3')]
const NOV_ROOT = merkleRootOf(['r1', 'r2'])
const DEC_ROOT = merkleRootOf(['r3'])

function ledger(dir: string, value: unknown): void {
  writeFileSync(join(dir, 'anchors.json'), JSON.stringify(value), 'utf8')
}

describe('readAnchors', () => {
  it('缺失 → missing', () => {
    expect(readAnchors(root())).toEqual({ state: 'missing', roots: new Map() })
  })

  it('合法对象 → ok', () => {
    const dir = root()
    ledger(dir, { '2023-11': NOV_ROOT })
    expect(readAnchors(dir)).toEqual({ state: 'ok', roots: new Map([['2023-11', NOV_ROOT]]) })
  })

  it('非 JSON → invalid', () => {
    const dir = root()
    writeFileSync(join(dir, 'anchors.json'), '{', 'utf8')
    expect(readAnchors(dir).state).toBe('invalid')
  })

  it('数组 / null / 非字符串值 → invalid', () => {
    for (const value of [[], null, { '2023-11': 42 }]) {
      const dir = root()
      ledger(dir, value)
      expect(readAnchors(dir).state).toBe('invalid')
    }
  })
})

describe('buildAnchorsAudit', () => {
  it('台账与全局根一致 → matches', () => {
    const dir = root()
    ledger(dir, { '2023-11': NOV_ROOT, '2023-12': DEC_ROOT })
    const result = buildAnchorsAudit(ROWS, dir)
    expect(result.ledgerState).toBe('ok')
    expect(result.entries).toEqual([
      { period: '2023-11', merkleRoot: NOV_ROOT, state: 'matches' },
      { period: '2023-12', merkleRoot: DEC_ROOT, state: 'matches' },
    ])
  })

  it('根不一致 → mismatch', () => {
    const dir = root()
    ledger(dir, { '2023-11': 'wrong', '2023-12': DEC_ROOT })
    const result = buildAnchorsAudit(ROWS, dir)
    expect(result.entries[0]).toMatchObject({ period: '2023-11', state: 'mismatch' })
  })

  it('台账缺 period → ledger-missing（不是异常）', () => {
    const dir = root()
    ledger(dir, { '2023-11': NOV_ROOT })
    const result = buildAnchorsAudit(ROWS, dir)
    expect(result.entries).toEqual([
      { period: '2023-11', merkleRoot: NOV_ROOT, state: 'matches' },
      { period: '2023-12', merkleRoot: DEC_ROOT, state: 'ledger-missing' },
    ])
  })

  it('台账缺文件 → 每个链上 period 都是 ledger-missing', () => {
    const result = buildAnchorsAudit(ROWS, root())
    expect(result.ledgerState).toBe('missing')
    expect(result.entries.map((entry) => entry.state)).toEqual(['ledger-missing', 'ledger-missing'])
  })

  it('台账损坏 → ledger-invalid，且逐 period 标注', () => {
    const dir = root()
    writeFileSync(join(dir, 'anchors.json'), '{', 'utf8')
    const result = buildAnchorsAudit(ROWS, dir)
    expect(result.ledgerState).toBe('invalid')
    expect(result.entries).toEqual([
      { period: '2023-11', merkleRoot: NOV_ROOT, state: 'ledger-invalid' },
      { period: '2023-12', merkleRoot: DEC_ROOT, state: 'ledger-invalid' },
    ])
  })

  it('台账有 period、链上无叶子 → orphan-ledger', () => {
    const dir = root()
    ledger(dir, { '2023-11': NOV_ROOT, '2024-01': 'orphan' })
    const result = buildAnchorsAudit(ROWS, dir)
    expect(result.entries).toContainEqual({
      period: '2024-01',
      merkleRoot: null,
      state: 'orphan-ledger',
    })
  })

  it('空链 + 空台账 → 无条目；空链 + 有台账 → orphan', () => {
    const emptyDir = root()
    ledger(emptyDir, {})
    expect(buildAnchorsAudit([], emptyDir)).toEqual({ ledgerState: 'ok', entries: [] })

    const orphanDir = root()
    ledger(orphanDir, { '2024-01': 'orphan' })
    expect(buildAnchorsAudit([], orphanDir).entries).toEqual([
      { period: '2024-01', merkleRoot: null, state: 'orphan-ledger' },
    ])
  })

  it('锚定叶子按 (sagaId, seqInSaga) 排序，与 anchor() 同口径', () => {
    const dir = root()
    const unsorted = [row('b', 1, DEC, 'r3'), row('a', 2, NOV, 'r2'), row('a', 1, NOV, 'r1')]
    ledger(dir, { '2023-11': NOV_ROOT, '2023-12': DEC_ROOT })
    const result = buildAnchorsAudit(unsorted, dir)
    expect(result.entries.every((entry) => entry.state === 'matches')).toBe(true)
  })
})
