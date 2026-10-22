/**
 * 标识符生成：ULID（Crockford Base32）。
 *
 * 为什么不用 `randomUUID`：`memory_unit` 的血统链（`superseded_by`）在答辩时要按时间
 * 顺序读，UUIDv4 无序、读出来是乱的。ULID 前 10 字符是 48 位毫秒时间戳，字典序即时序，
 * 且不引入任何依赖。
 *
 * 取舍：本实现**不做**同毫秒单调递增（那需要一个模块级可变状态）。冲突概率由 80 位
 * 随机承担，且业务排序一律走 `valid_from`，不依赖 id 比较。
 */

import { randomBytes } from 'node:crypto'

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENCODING_LEN = 32
const TIME_LEN = 10
const RANDOM_LEN = 16

function encodeTime(epochMs: number, length: number): string {
  let remaining = Math.max(0, Math.floor(epochMs))
  let out = ''
  for (let index = 0; index < length; index += 1) {
    const mod = remaining % ENCODING_LEN
    out = ENCODING.charAt(mod) + out
    remaining = (remaining - mod) / ENCODING_LEN
  }
  return out
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += ENCODING.charAt((bytes[index] ?? 0) % ENCODING_LEN)
  }
  return out
}

/** 26 字符 ULID。 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, TIME_LEN) + encodeRandom(RANDOM_LEN)
}

/** `memory_unit` 主键。 */
export function memoryUnitId(now: number = Date.now()): string {
  return `mu_${ulid(now)}`
}

/** `procedural_unit` 主键。 */
export function proceduralId(now: number = Date.now()): string {
  return `pr_${ulid(now)}`
}
