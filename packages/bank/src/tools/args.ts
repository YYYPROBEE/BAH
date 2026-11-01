/**
 * 工具参数读取原语（description 质量差会导致模型误调，参数校验必须 fail-loud）。
 *
 * 模型给的参数是**不可信输入**：类型错、缺字段、多字段都可能发生。所有读取都抛出
 * 结构化 `BahError('tool-args-invalid')`，由七段管线归一化成 `isError` 结果回灌给模型，
 * 而不是让一个 `undefined` 流进账本。
 */

import { BahError } from '@bah/util'

/** 参数读取失败（统一理由码）。 */
export function argsError(message: string, detail?: unknown): BahError {
  return new BahError('tool-args-invalid', `bank-tools: ${message}`, detail)
}

/** 读普通对象（数组 / null 都不接受）。 */
export function readObject(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): Readonly<Record<string, unknown>> {
  const value = source[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw argsError(`${where}.${key} 必须是对象`, { key, where })
  }
  return value as Readonly<Record<string, unknown>>
}

/** 读可选对象。 */
export function readOptionalObject(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): Readonly<Record<string, unknown>> | undefined {
  if (source[key] === undefined) return undefined
  return readObject(source, key, where)
}

/** 单个字符串参数的默认上限（防止模型把 10MB 文本塞进落盘与 wire）。 */
const MAX_STRING_LENGTH = 4096

/** 读非空字符串。 */
export function readString(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  maxLength: number = MAX_STRING_LENGTH,
): string {
  const value = source[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw argsError(`${where}.${key} 必须是非空字符串`, { key, where })
  }
  if (value.length > maxLength) {
    throw argsError(`${where}.${key} 超过长度上限 ${maxLength}（收到 ${value.length}）`, {
      key,
      where,
      maxLength,
      length: value.length,
    })
  }
  return value.trim()
}

/** 读可选字符串（空串视为未给）。 */
export function readOptionalString(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  maxLength: number = MAX_STRING_LENGTH,
): string | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw argsError(`${where}.${key} 必须是字符串`, { key, where })
  }
  if (value.length > maxLength) {
    throw argsError(`${where}.${key} 超过长度上限 ${maxLength}（收到 ${value.length}）`, {
      key,
      where,
      maxLength,
      length: value.length,
    })
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 读有限数字。 */
export function readNumber(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw argsError(`${where}.${key} 必须是有限数字`, { key, where })
  }
  return value
}

/** 读可选正整数。 */
export function readOptionalPositiveInteger(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): number | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw argsError(`${where}.${key} 必须是正整数`, { key, where })
  }
  return value
}

/** 读可选整数（**允许负数**：账期偏移 -1 = 上个月）。 */
export function readOptionalInteger(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): number | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw argsError(`${where}.${key} 必须是整数`, { key, where })
  }
  return value
}

/** 读枚举（大小写不敏感，返回小写）。 */
export function readEnum<T extends string>(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  allowed: readonly T[],
): T | undefined {
  const value = readOptionalString(source, key, where)
  if (value === undefined) return undefined
  const normalized = value.toLowerCase() as T
  if (!allowed.includes(normalized)) {
    throw argsError(`${where}.${key} 只能是 ${allowed.join(' / ')}（收到 ${value}）`, {
      key,
      where,
      allowed,
    })
  }
  return normalized
}

/** 读必填枚举。 */
export function readRequiredEnum<T extends string>(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  allowed: readonly T[],
): T {
  const value = readEnum(source, key, where, allowed)
  if (value === undefined) {
    throw argsError(`${where}.${key} 必填（可写：${allowed.join(' / ')}）`, { key, where })
  }
  return value
}

/** 读字符串数组（非空、无空串）。 */
export function readStringArray(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string[] {
  const value = source[key]
  if (!Array.isArray(value) || value.length === 0) {
    throw argsError(`${where}.${key} 必须是非空字符串数组`, { key, where })
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw argsError(`${where}.${key}[${index}] 必须是非空字符串`, { key, where, index })
    }
    return item.trim()
  })
}

/** 读布尔（未给取 `fallback`）。 */
export function readBoolean(
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  fallback: boolean,
): boolean {
  const value = source[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw argsError(`${where}.${key} 必须是布尔`, { key, where })
  }
  return value
}
