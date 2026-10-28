/**
 * 稳定 JSON 导出。
 *
 * "稳定"的三个含义，缺一个就没法做快照式断言：
 *
 * 1. **键顺序固定**（不依赖对象字面量的插入顺序，也不依赖 JS 引擎）；
 * 2. **属性按键名 `localeCompare('en')` 排序**（`attributes` 是 Record，键序本来不可控）；
 * 3. **`null` 显式输出**——`endMs: null`（未闭合）与 `code: null`（无理由码）
 *    都必须出现在文本里，否则"没有这个字段"与"这个字段是空"在下游会混成一种。
 *
 * 输出是**裸数组**：`[{...}, {...}]`，不包 `{spans: [...]}`。
 * 包一层会让 02 的 `?format=json` 与 03 的 CLI 各自决定"到底读哪一层"，迟早不一致。
 */

import type { TelemetrySpan } from './span.ts'

/** 固定键顺序（改这个顺序等于改导出格式，下游断言会红）。 */
const KEY_ORDER = [
  'traceId',
  'spanId',
  'parentSpanId',
  'name',
  'startMs',
  'endMs',
  'status',
  'code',
  'attributes',
  'source',
] as const

/** 属性键排序口径（显式 `en`：不同 locale 的排序规则会让同一份数据输出两种字节）。 */
export function compareAttributeKeys(a: string, b: string): number {
  return a.localeCompare(b, 'en')
}

/** span → 稳定键序的普通对象（便于 `JSON.stringify` 或直接给 HTTP 层用）。 */
export function toJsonRow(span: TelemetrySpan): Record<string, unknown> {
  const attributes: Record<string, string | number | boolean> = {}
  for (const key of Object.keys(span.attributes).sort(compareAttributeKeys)) {
    attributes[key] = span.attributes[key] as string | number | boolean
  }
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    startMs: span.startMs,
    endMs: span.endMs,
    status: span.status,
    code: span.code ?? null,
    attributes,
    source: span.source,
  }
}

/** 稳定序列化（同一输入两次调用逐字节相等）。 */
export function toJsonTrace(spans: readonly TelemetrySpan[]): string {
  const rows = spans.map(toJsonRow)
  assertKeyOrder(rows)
  return `${JSON.stringify(rows, null, 2)}\n`
}

/**
 * 键序自检。
 *
 * 为什么在运行期做：`JSON.stringify` 对**数字型字符串键**会强制前置
 * （`{ "1": ..., "a": ... }` 输出时 `1` 在前），而 `attributes` 的键来自闭集，
 * 今天全字母、明天有人加个 `"10"` 就会静默改变字节序。自检比注释可靠。
 */
function assertKeyOrder(rows: readonly Record<string, unknown>[]): void {
  for (const row of rows) {
    const keys = Object.keys(row)
    if (keys.length !== KEY_ORDER.length) {
      throw new Error(`bah-telemetry: 导出键数不符（期望 ${String(KEY_ORDER.length)}，实得 ${String(keys.length)}）`)
    }
    for (let index = 0; index < KEY_ORDER.length; index += 1) {
      if (keys[index] !== KEY_ORDER[index]) {
        throw new Error(`bah-telemetry: 导出键序不符（第 ${String(index)} 位应为 ${String(KEY_ORDER[index])}）`)
      }
    }
  }
}
