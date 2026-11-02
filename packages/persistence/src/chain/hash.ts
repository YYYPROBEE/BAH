/**
 * 审计链的**纯哈希判定**（W15 抽出）：不 import `@bah/core`，供独立重放使用。
 *
 * 算法与 `chain/index.ts` 的写入端逐字一致（同 `canonicalOf` / `rowHash`）；
 * `chain/index.ts` 改为从本文件导入，避免"重放验链"与"写入验链"两套实现。
 */

import { sha256Hex, canonicalJson } from '@bah/util'

import type { ChainRecord } from './chain-file.ts'

/**
 * 参与哈希的 unsigned 投影（v1 八键；v2 额外四字段；`tenant` 有才算）。
 *
 * `tenant` **不能**无条件进投影：历史行没有这个字段，无条件加会让所有老链
 * 重算哈希不匹配（等于把已有证据判成"被篡改"）。也不能完全不加——那样
 * 改租户字段不会断链，审计链上的"这条属于谁"就退化成一句没人校验的注释。
 * 所以规则是"**有则入哈希**"，与写入端逐字一致（写入端只在新行上带 tenant）。
 */
export function canonicalOf(row: ChainRecord): Record<string, unknown> {
  const base = {
    s: row.s,
    q: row.q,
    t: row.t,
    sub: row.sub,
    hb: row.hb,
    d: row.d,
    keyVersion: row.keyVersion,
    recordedAt: row.recordedAt,
    ...(row.tenant === undefined ? {} : { tenant: row.tenant }),
  }
  if (row.version !== 2) return base
  return {
    ...base,
    version: 2,
    subject: row.subject,
    decision: row.decision,
    policyVersion: row.policyVersion,
    prevHash: row.prevHash,
  }
}

/** `recordHash = sha256(prevHash | canonicalJson(unsigned))`。 */
export function rowHash(prev: string, row: ChainRecord): string {
  return sha256Hex(`${prev}|${canonicalJson(canonicalOf(row))}`)
}

/** 单行是否断链（前驱 + v2 prevHash 别名 + 记录哈希）。 */
export function isBrokenRow(prev: string, row: ChainRecord): boolean {
  if (row.p !== prev) return true
  if (row.version === 2 && row.prevHash !== row.p) return true
  return row.r !== rowHash(prev, row)
}

/**
 * 验一组链记录的连续性（按 saga 分组、按 q 排序）。
 *
 * @returns 首个断点（`brokenAt` 是链内序号 q，不是数组下标）
 */
export function verifyChainRows(
  rows: readonly ChainRecord[],
): { ok: boolean; brokenAt?: number } {
  const bySaga = new Map<string, ChainRecord[]>()
  for (const row of rows) {
    const bucket = bySaga.get(row.s) ?? []
    bucket.push(row)
    bySaga.set(row.s, bucket)
  }
  for (const bucket of bySaga.values()) {
    bucket.sort((left, right) => left.q - right.q)
    let prev = ''
    for (const row of bucket) {
      if (isBrokenRow(prev, row)) return { ok: false, brokenAt: row.q }
      prev = row.r
    }
  }
  return { ok: true }
}
