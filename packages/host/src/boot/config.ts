/**
 * boot 配置校验原语（fail-loud，错误一律带 `bah-boot: ` 前缀）。
 *
 * 为什么不用 schemastery：内核的 `ConfigSchema` 是"可选"能力（`resolveConfig` 只在插件声明
 * `config` 时走它）；boot 面要在**建 ctx 之前**就把"这一行配置写错了"报出来，
 * 所以这里用零依赖的手写校验，并把补默认值的动作一并做掉（"未写字段由插件默认值兜底"）。
 *
 * 纪律：所有错误都是结构化 `BahError` + `bah-boot: ` 前缀，绝不静默回退。
 */

import {
  BahError,
  readConfigBoolean,
  readConfigEnum,
  readConfigPositiveInteger,
  rejectUnknownConfigKeys,
} from '@bah/util'

/** boot 错误统一前缀。 */
export const BOOT_PREFIX = 'bah-boot: '

const invalidConfig = (message: string, detail: Readonly<Record<string, unknown>>): never => {
  throw bootError('invalid-config', message, detail)
}
const unknownConfig = (message: string, detail: Readonly<Record<string, unknown>>): never => {
  throw bootError('unknown-config-key', message, detail)
}

/**
 * 构造 boot 错误。
 *
 * @param code 可读理由码（kebab-case），如 `unknown-config-key`
 * @param message 面向开发者的理由（不带前缀）
 * @param detail 结构化上下文（配置位置 / 未知键列表），不参与文案
 */
export function bootError(code: string, message: string, detail?: unknown): BahError {
  return new BahError(code, `${BOOT_PREFIX}${message}`, detail)
}

/**
 * 断言"必须是对象"。
 *
 * @throws `BahError('invalid-config')` 非对象 / 数组 / null
 */
export function asRecord(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bootError('invalid-config', `${where} 必须是对象（收到 ${describeValue(value)}）`, { where })
  }
  return value as Readonly<Record<string, unknown>>
}

/**
 * 拒绝 schema 未声明的键。
 *
 * @throws `BahError('unknown-config-key')` 存在未声明键
 */
export function rejectUnknownKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
): void {
  rejectUnknownConfigKeys(record, allowed, where, unknownConfig)
}

/**
 * 读字符串。
 *
 * @returns 未写时 `undefined`
 * @throws `BahError('invalid-config')` 不是字符串 / 空串
 */
export function readString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw bootError('invalid-config', `${where}.${key} 必须是非空字符串（收到 ${describeValue(value)}）`, {
      where,
      key,
    })
  }
  return value.trim()
}

/**
 * 读字符串（**不 trim**）。
 *
 * 用于"首尾空白有意义"的值（如展示前缀）。其余字符串一律走 `readString`：
 * 配置里的多余空白几乎总是笔误，trim 掉比静默保留更好。
 *
 * @throws `BahError('invalid-config')` 不是字符串
 */
export function readRawString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw bootError('invalid-config', `${where}.${key} 必须是字符串（收到 ${describeValue(value)}）`, {
      where,
      key,
    })
  }
  return value
}

/**
 * 读必填字符串。
 *
 * @throws `BahError('invalid-config')` 未写 / 不是字符串 / 空串
 */
export function readRequiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string {
  const value = readString(record, key, where)
  if (value === undefined) {
    throw bootError('invalid-config', `${where}.${key} 必填（未写）`, { where, key })
  }
  return value
}

/**
 * 读布尔（未写取 `fallback`）。
 *
 * @throws `BahError('invalid-config')` 不是布尔
 */
export function readBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  fallback: boolean,
): boolean {
  return readConfigBoolean(record, key, where, fallback, invalidConfig)
}

/**
 * 读正整数（未写返回 `undefined`）。
 *
 * @throws `BahError('invalid-config')` 不是正整数
 */
export function readPositiveInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): number | undefined {
  return readConfigPositiveInteger(record, key, where, undefined, invalidConfig)
}

/**
 * 读字符串数组（未写返回 `undefined`）。
 *
 * @throws `BahError('invalid-config')` 不是字符串数组 / 含空串
 */
export function readStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): readonly string[] | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw bootError('invalid-config', `${where}.${key} 必须是字符串数组（收到 ${describeValue(value)}）`, {
      where,
      key,
    })
  }
  const items = value as readonly string[]
  if (items.some((item) => item.length === 0)) {
    throw bootError('invalid-config', `${where}.${key} 不允许空串成员`, { where, key })
  }
  return [...items]
}

/**
 * 读"单值枚举"（未写返回 `undefined`）。
 *
 * @throws `BahError('invalid-config')` 值不在允许集合里
 */
export function readEnum<T extends string>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  allowed: readonly T[],
): T | undefined {
  return readConfigEnum(record, key, where, allowed, undefined, invalidConfig)
}

/**
 * 把配置值渲染成可读文本（错误文案用）。
 *
 * 字符串加引号，便于区分 `undefined` 与字面量 `"undefined"`。
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      // 循环引用 / BigInt 等不可序列化值：退化成 String，错误文案仍可读（不静默失败）
      return String(value)
    }
  }
  return String(value)
}
