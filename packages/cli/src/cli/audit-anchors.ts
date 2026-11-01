/**
 * 锚定台账比对。
 *
 * 叶子集与 `anchor()` 同口径：对目录下**全部链**按 `(sagaId, seqInSaga)` 稳定排序，
 * 再按 `periodOf(recordedAt)` 分组取 `recordHash`。`--saga` 不改变叶子集。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { merkleRootOf, periodOf } from '@bah/persistence'

import type { ChainRecord } from '@bah/persistence'

/** 锚定五态。 */
export type AnchorState = 'matches' | 'mismatch' | 'ledger-missing' | 'ledger-invalid' | 'orphan-ledger'

/** 单个 period 的比对结论。 */
export interface AnchorEntry {
  readonly period: string
  readonly merkleRoot: string | null
  readonly state: AnchorState
}

/** 目录级锚定结论。 */
export interface AnchorsAudit {
  readonly entries: readonly AnchorEntry[]
  readonly ledgerState: 'ok' | 'missing' | 'invalid'
}

/** 读 `<dir>/anchors.json`；损坏与缺失必须分开。 */
export function readAnchors(dir: string): {
  readonly state: 'ok' | 'missing' | 'invalid'
  readonly roots: ReadonlyMap<string, string>
} {
  const path = join(resolve(dir), 'anchors.json')
  if (!existsSync(path)) return { state: 'missing', roots: new Map() }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { state: 'invalid', roots: new Map() }
    }
    const roots = new Map<string, string>()
    for (const [period, root] of Object.entries(parsed)) {
      if (typeof root !== 'string') return { state: 'invalid', roots: new Map() }
      roots.set(period, root)
    }
    return { state: 'ok', roots }
  } catch {
    return { state: 'invalid', roots: new Map() }
  }
}

/** 对目录下全部链做一次锚定比对。 */
export function buildAnchorsAudit(rows: readonly ChainRecord[], dir: string): AnchorsAudit {
  const ledger = readAnchors(dir)
  const sorted = [...rows].sort((left, right) => {
    if (left.s !== right.s) return left.s < right.s ? -1 : 1
    return left.q - right.q
  })
  const byPeriod = new Map<string, string[]>()
  for (const row of sorted) {
    const period = periodOf(row.recordedAt)
    const leaves = byPeriod.get(period) ?? []
    leaves.push(row.r)
    byPeriod.set(period, leaves)
  }

  const periods = new Set([...byPeriod.keys(), ...ledger.roots.keys()])
  if (ledger.state === 'invalid') {
    return {
      ledgerState: 'invalid',
      entries: [...byPeriod.keys()].sort().map((period) => ({
        period,
        merkleRoot: merkleRootOf(byPeriod.get(period) as string[]),
        state: 'ledger-invalid',
      })),
    }
  }

  const entries: AnchorEntry[] = []
  for (const period of [...periods].sort()) {
    const leaves = byPeriod.get(period) ?? []
    const anchored = ledger.roots.get(period)
    if (anchored === undefined) {
      if (leaves.length > 0) {
        entries.push({ period, merkleRoot: merkleRootOf(leaves), state: 'ledger-missing' })
      }
      continue
    }
    if (leaves.length === 0) {
      entries.push({ period, merkleRoot: null, state: 'orphan-ledger' })
      continue
    }
    const merkleRoot = merkleRootOf(leaves)
    entries.push({
      period,
      merkleRoot,
      state: merkleRoot === anchored ? 'matches' : 'mismatch',
    })
  }
  return { ledgerState: ledger.state, entries }
}
