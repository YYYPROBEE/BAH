/**
 * Chrome Trace Event Format 导出（Perfetto / `chrome://tracing` 直接可开）。
 *
 * 字段映射的三处坑（都踩过）：
 *
 * 1. **时间单位是微秒**：我们的 `startMs/endMs` 是毫秒，必须 ×1000；
 * 2. **`dur: 0` 在 Perfetto 里看不见**：0ms 的 span 会被渲染成 0 宽，所以下限钳到 1µs；
 * 3. **未闭合的 span 不能用 `ph: "X"`**：`X` 必须有 `dur`，而我们不知道它什么时候结束
 *    （也不能用"现在"——本模块是纯函数，没有钟）。改用 `ph: "B"`（begin）且**不写 `dur`**。
 *
 * 顶层是**裸数组**（Perfetto 要求），不包 `{traceEvents: []}`。
 */

import type { TelemetrySpan } from './span.ts'

/** 一条 Chrome Trace 事件（`ph` 决定其余字段怎么解释）。 */
interface ChromeEvent {
  readonly name: string
  /** 元数据事件（`ph: "M"`）没有分类。 */
  readonly cat?: string
  readonly ph: 'X' | 'B' | 'M'
  readonly ts: number
  readonly dur?: number
  readonly pid: number
  readonly tid: number
  readonly args?: Record<string, string | number | boolean | null>
}

/** 单进程、单线程：嵌套靠时间包含关系渲染，不靠线程。 */
const PID = 1
const TID = 1

/** 名字前缀做 `cat`（`tool.execute` → `tool`），供 Perfetto 侧过滤。 */
function categoryOf(name: string): string {
  const dot = name.indexOf('.')
  return dot < 0 ? name : name.slice(0, dot)
}

/** 毫秒 → 微秒（整数）。 */
function toMicros(ms: number): number {
  return Math.round(ms * 1000)
}

/** span → Chrome 事件（未闭合的是 `ph: "B"`）。 */
export function toChromeEvents(span: TelemetrySpan): ChromeEvent {
  const ts = toMicros(span.startMs)
  const args: Record<string, string | number | boolean | null> = {
    ...span.attributes,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    status: span.status,
    code: span.code ?? null,
  }
  if (span.endMs === null) {
    return { name: span.name, cat: categoryOf(span.name), ph: 'B', ts, pid: PID, tid: TID, args }
  }
  // `dur: 0` 在 Perfetto 里是一条看不见的线：钳到 1µs，并保持"至少 1"的语义。
  const dur = Math.max(1, toMicros(span.endMs) - ts)
  return { name: span.name, cat: categoryOf(span.name), ph: 'X', ts, dur, pid: PID, tid: TID, args }
}

/**
 * 整份轨迹 → Chrome Trace JSON 文本。
 *
 * 头部两条 `ph: "M"` 元数据事件是必需的：没有 `thread_name` 时 Perfetto 会把线程显示成
 * "1"，评审时没人知道那是事件循环。
 */
export function toChromeTrace(spans: readonly TelemetrySpan[]): string {
  const events: ChromeEvent[] = [
    { name: 'process_name', ph: 'M', ts: 0, pid: PID, tid: TID, args: { name: 'BAH host' } },
    { name: 'thread_name', ph: 'M', ts: 0, pid: PID, tid: TID, args: { name: 'event-loop' } },
    ...spans.map(toChromeEvents),
  ]
  return JSON.stringify(events)
}
