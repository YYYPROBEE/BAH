/**
 * 确定性 JSON 序列化与 SHA-256（SA-00 §11 / SA-11 §3.1）。
 *
 * 为什么归位 `@bah/util`：审计链、补偿载荷投影与屏障判定都要把**同一个对象**算成
 * **同一个摘要**。两处各自实现 canonicalJson，就会出现两份哈希口径，链与投影立刻分叉。
 *
 * 口径（与 SA-11 冻结一致）：
 * - 对象键按 Unicode 码元排序后输出，无空白、无尾逗号；
 * - 值为 `undefined` 的对象属性**剔除**；数组中的 `undefined` 按 JSON 语义记为 `null`；
 * - 字符串与键做 NFC 归一（同一个字符的组合式/分解式得到同一摘要）；
 * - 非有限数、BigInt、函数、Symbol、循环引用一律拒绝（不静默降级成 `null`）。
 */

import { createHash } from 'node:crypto'

import { BahError } from './errors.ts'

/**
 * 把值编码为确定性 JSON 文本。
 *
 * @throws `BahError('invalid-canonical-json')` 值不属于可稳定序列化的 JSON 形态
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<unknown>(), '$')
}

/**
 * 对 UTF-8 文本或字节序列求 SHA-256（小写 hex）。
 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function encode(value: unknown, seen: Set<unknown>, path: string): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'))
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw invalid(path, `数字必须是有限值（收到 ${String(value)}）`)
      }
      return JSON.stringify(value)
    case 'object':
      return encodeObject(value, seen, path)
    default:
      throw invalid(path, `不支持的类型：${typeof value}`)
  }
}

function encodeObject(value: object, seen: Set<unknown>, path: string): string {
  if (seen.has(value)) throw invalid(path, '出现循环引用')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.map((item, index) =>
        item === undefined ? 'null' : encode(item, seen, `${path}[${index}]`),
      )
      return `[${items.join(',')}]`
    }

    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()

    const entries = keys.map((key) => {
      const encodedKey = JSON.stringify(key.normalize('NFC'))
      return `${encodedKey}:${encode(record[key], seen, `${path}.${key}`)}`
    })
    return `{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function invalid(path: string, reason: string): BahError {
  return new BahError('invalid-canonical-json', `bah-util: invalid-canonical-json: ${path} ${reason}`, {
    path,
  })
}
