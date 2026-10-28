/**
 * 结构化日志（可观测性 02 / S2.1）。
 *
 * 三条纪律（与 01 的遥测同源）：
 *
 * 1. **一条日志一行 JSON**：拼接串在事后只能靠正则捞，"谁在什么时候用哪个 code 失败了"
 *    才是排障的第一问题；
 * 2. **不出原文**：`FORBIDDEN_KEYS` 的字段**整条丢弃**，不打码——打码会泄漏长度；
 * 3. **先判级再序列化**：被级别过滤掉的日志不 `JSON.stringify`，省 CPU。
 *
 * 级别过滤、文件轮转、统计全部在**本模块**（零第三方依赖，只用 Node 内建）。
 * host 的 `plugins/log.ts` 只做 re-export，9 个既有调用点的签名一个字都不用改。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'

/** 日志级别（与常见分级对齐，不做自定义）。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 可选的日志上下文（由 `runWithLogContext` 注入，自动合并进每一行）。 */
export interface LogContext {
  readonly sessionId?: string
  readonly traceId?: string
  readonly turn?: number
  readonly spanId?: string
  /** 'core' | 'runtime' | 'host' | 'saga' | 'policy' | 'bank' | 'persistence' */
  readonly component?: string
}

/** 日志统计（`bah_log_lines_total` 的输入）。 */
export interface LogStats {
  readonly byLevel: Readonly<Record<LogLevel, number>>
  /** 被级别过滤掉的行数（不序列化，只计数）。 */
  readonly suppressed: number
  /** 文件出口写失败次数（stderr 永远不受影响）。 */
  readonly writeErrors: number
}

/** 配置（只在 host 启动时设一次；重复调用是幂等的）。 */
export interface LoggingSettings {
  readonly level?: string | null
  readonly file?: string | null
  /** 轮转阈值（字节，缺省 8 MiB；测试用小值，避免真写 8 MB）。 */
  readonly maxFileBytes?: number
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

/** 禁止入日志的字段名（粗粒度但够用：宁可少记，不可漏记）。 */
const FORBIDDEN_KEYS = /^(?:key|apiKey|token|secret|password|authorization|cookie)$/i

/** 固定字段不能被 `fields` 覆盖（否则事件 code 会被字段名的 `code` 顶掉）。 */
const RESERVED_FIELDS = new Set(['ts', 'code'])

/** 文件轮转：固定 8 MiB × 3 份（无第三方）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024

const als = new AsyncLocalStorage<LogContext>()

let configuredLevel: LogLevel = 'info'
let configuredFile: string | null = null
let configuredMaxBytes = MAX_FILE_BYTES
let stats = { debug: 0, info: 0, warn: 0, error: 0, suppressed: 0, writeErrors: 0 }

/** 解析级别；非法值回落 `info`（并留一条 warn，不阻断启动）。 */
function parseLevel(value: string | null | undefined): { level: LogLevel; invalid: boolean } {
  if (value === undefined || value === null || value.trim() === '') return { level: 'info', invalid: false }
  const lower = value.trim().toLowerCase()
  if ((LEVELS as readonly string[]).includes(lower)) return { level: lower as LogLevel, invalid: false }
  return { level: 'info', invalid: true }
}

/** 配置日志出口；`file` 为空/未配置 = 只写 stderr。 */
export function configureLogging(settings: LoggingSettings = {}): void {
  const parsed = parseLevel(settings.level)
  configuredLevel = parsed.level
  const file = settings.file?.trim()
  configuredFile = file === undefined || file.length === 0 ? null : file
  configuredMaxBytes =
    settings.maxFileBytes !== undefined && Number.isInteger(settings.maxFileBytes) && settings.maxFileBytes > 0
      ? settings.maxFileBytes
      : MAX_FILE_BYTES
  if (parsed.invalid) {
    // 不递归进文件出口：配置错时文件可能还没准备好。
    logJson('warn', 'logging.env-invalid', { key: 'BAH_LOG_LEVEL', value: String(settings.level) })
  }
}

/** 当前配置（测试与启动日志用）。 */
export function loggingConfig(): { level: LogLevel; file: string | null } {
  return { level: configuredLevel, file: configuredFile }
}

/** 文件出口：超 8 MiB 轮转 `.1` → `.2`，失败只计数。 */
function appendToFile(line: string): void {
  const file = configuredFile
  if (file === null) return
  try {
    if (existsSync(file) && statSync(file).size >= configuredMaxBytes) {
      rotate(file)
    }
    appendFileSync(file, `${line}\n`, 'utf8')
  } catch {
    stats.writeErrors += 1
  }
}

/** 把 `file` → `.1`，原 `.1` → `.2`；删除 `.2`。 */
function rotate(file: string): void {
  const one = `${file}.1`
  const two = `${file}.2`
  try {
    if (existsSync(two)) unlinkSync(two)
    if (existsSync(one)) renameSync(one, two)
    renameSync(file, one)
  } catch {
    // 轮转失败不阻断写（下一次 append 会继续往原文件追加）。
  }
}

/** 在日志上下文里跑一段逻辑（AsyncLocalStorage；Node 内建，不算依赖）。 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return als.run(context, fn)
}

/** 当前上下文（没有则返回空对象）。 */
export function currentLogContext(): LogContext {
  return als.getStore() ?? {}
}

/**
 * 打一条结构化日志。
 *
 * 键序固定：`ts, level, code, ...context, ...fields`；`fields` 覆盖 context 的同名键。
 * 走 `console.error` 而不是 `process.stderr.write`：两者都落 stderr，但前者能被
 * `vi.spyOn(console, 'error')` 接住——否则"日志有没有打出来"就没法测。
 */
export function logJson(
  level: LogLevel,
  code: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLevel]) {
    stats.suppressed += 1
    return
  }

  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    code,
    ...currentLogContext(),
  }
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.test(key) || RESERVED_FIELDS.has(key)) continue
    if (value === undefined) continue
    payload[key] = value
  }
  const line = JSON.stringify(payload)
  console.error(line)
  stats[level] += 1
  appendToFile(line)
}

/** 日志统计快照（`bah_log_lines_total` 用）。 */
export function logStats(): LogStats {
  return {
    byLevel: { debug: stats.debug, info: stats.info, warn: stats.warn, error: stats.error },
    suppressed: stats.suppressed,
    writeErrors: stats.writeErrors,
  }
}

/** 清空统计（测试用；生产不调用）。 */
export function resetLogStats(): void {
  stats = { debug: 0, info: 0, warn: 0, error: 0, suppressed: 0, writeErrors: 0 }
}
