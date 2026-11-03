/**
 * 幂等键：`sha256(tenant|user|subject|predicate|object)`（设计文档 §5 第 4 步）。
 *
 * `object` 必须先**规范化**再参与哈希：键序不同的同一份 JSON 若算出两个 hash，
 * 幂等就形同虚设（`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 是同一条记忆）。
 */

import { createHash } from 'node:crypto'

/** 递归按键名排序后的稳定 JSON；`undefined` 视作缺省键，与 `JSON.stringify` 一致。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'null'
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

export interface ContentHashParts {
  readonly tenant: string
  readonly userId: string
  readonly subject: string
  readonly predicate: string
  readonly object: unknown
}

export function contentHash(parts: ContentHashParts): string {
  const material = [
    parts.tenant,
    parts.userId,
    parts.subject,
    parts.predicate,
    stableStringify(parts.object),
  ].join('|')
  return createHash('sha256').update(material, 'utf8').digest('hex')
}
