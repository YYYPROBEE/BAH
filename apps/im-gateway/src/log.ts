/**
 * 网关日志（施工单 02 §2.15）。
 *
 * 三条纪律：
 * 1. 只走 `@bah/util` 的 `logJson`（`console.*` 在 packages 面被 `verify-observability` 判红，
 *    网关沿用同一出口，日志格式与宿主一致）；
 * 2. **不打平台用户标识原文**（openid 是可关联 PII）：调用方只能传 `sessionKey`；
 *    本模块对 `userId` / `openid` / `fromUser` / `toUser` 做**整条丢弃**（不是打码——打码泄漏长度）；
 * 3. code 是事件名（`im-child-start` 形态），不是错误原文。
 */

import { logJson, type LogLevel } from '@bah/util'

/** 日志级别序（本模块自己判级：全局 `configureLogging` 的级别留给宿主）。 */
const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

/** 02 §2.15 的 code 闭集（新增码必须同批登记到 `docs/log-codes.md`）。 */
export const IM_LOG_CODES = [
  'im-gateway-start',
  'im-platform-unknown',
  'im-sig-invalid',
  'im-xml-rejected',
  'im-duplicate',
  'im-child-start',
  'im-child-ready',
  'im-child-exit',
  'im-child-reap',
  'im-turn-failed',
  'im-push-fallback',
  'im-push-failed',
  'im-ratelimited',
  'im-untrusted',
  'im-config-invalid',
] as const

/** 日志码类型。 */
export type ImLogCode = (typeof IM_LOG_CODES)[number]

/** 禁止入日志的字段（平台用户标识与凭证）。 */
const FORBIDDEN_FIELDS = /^(?:userId|openid|fromUser|toUser|token|secret|authorization|cookie)$/i

/** 日志接口。 */
export interface ImLogger {
  debug(code: ImLogCode, fields?: Readonly<Record<string, unknown>>): void
  info(code: ImLogCode, fields?: Readonly<Record<string, unknown>>): void
  warn(code: ImLogCode, fields?: Readonly<Record<string, unknown>>): void
  error(code: ImLogCode, fields?: Readonly<Record<string, unknown>>): void
}

/** 脱敏：只保留可安全入日志的标量字段。 */
export function sanitizeImLogFields(
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_FIELDS.test(key)) continue
    if (value === undefined) continue
    result[key] = value
  }
  return result
}

/**
 * 造一个按级别过滤的日志器。
 *
 * 传 `sink` 只为测试断言：生产不注入，直接走 `logJson`。
 */
export function createImLogger(
  level: LogLevel,
  sink: (level: LogLevel, code: string, fields: Record<string, unknown>) => void = (lvl, code, fields) => {
    logJson(lvl, code, fields)
  },
): ImLogger {
  const emit = (
    lvl: LogLevel,
    code: ImLogCode,
    fields: Readonly<Record<string, unknown>> = {},
  ): void => {
    if ((RANK[lvl] ?? 0) < (RANK[level] ?? 0)) return
    sink(lvl, code, sanitizeImLogFields(fields))
  }
  return {
    debug: (code, fields) => emit('debug', code, fields),
    info: (code, fields) => emit('info', code, fields),
    warn: (code, fields) => emit('warn', code, fields),
    error: (code, fields) => emit('error', code, fields),
  }
}
