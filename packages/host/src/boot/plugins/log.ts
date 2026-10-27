/**
 * 结构化日志出口（D2）。
 *
 * 只做一件事：把一条事件打成**单行 JSON** 写到 stderr。
 *
 * 为什么不用 `console.error('...' + reason)`：拼接式日志在事后只能靠正则捞，
 * 而"谁在什么时候用哪个 code 失败了"是排障的第一问题。单行 JSON 让 `code` 可枚举、
 * 字段可过滤，且**不需要**引入日志框架（宪法 R-2：零运行时依赖）。
 *
 * 纪律：
 * - **不写 PII**：不放 prompt、工具结果、账号、姓名；只放 code + 标量上下文；
 * - **不写密钥**：任何 `key` / `token` / `secret` 字段一律不入；
 * - stderr 是唯一出口：stdout 被 CLI 的输出占用，混进去会破坏管道。
 *   走 `console.error` 而不是 `process.stderr.write`：两者都落 stderr，
 *   但前者能被 `vi.spyOn(console, 'error')` 接住——否则"日志有没有打出来"就没法测。
 */

/** 日志级别（与常见分级对齐，不做自定义）。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 一条结构化日志的固定字段。 */
interface LogLine {
  readonly ts: string
  readonly level: LogLevel
  readonly code: string
  readonly [key: string]: unknown
}

/** 禁止入日志的字段名（粗粒度但够用：宁可少记，不可漏记）。 */
const FORBIDDEN_KEYS = /^(?:key|apiKey|token|secret|password|authorization|cookie)$/i

/** 打一条结构化日志（`fields` 里的禁止字段会被丢弃，而不是打码——打码也会泄漏长度）。 */
export function logJson(level: LogLevel, code: string, fields: Readonly<Record<string, unknown>> = {}): void {
  const line: LogLine = { ts: new Date().toISOString(), level, code }
  const payload: Record<string, unknown> = { ...line }
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.test(key)) continue
    if (value === undefined) continue
    payload[key] = value
  }
  console.error(JSON.stringify(payload))
}
