/**
 * 关联标识：trace / span / W3C `traceparent`。
 *
 * **本文件是全仓这两类 id 的唯一实现**（saga 的 `gates/index.ts` 从这里再导出，
 * 不再保留副本）。三组规则并存是**有意**的，见下。
 *
 * ```text
 * traceId            sha256("bah/trace/session:" + sessionId)[0..32]
 * spanId（派生）      sha256("bah/span/" + kind + ":" + key)[0..16]     ← spanIdOfTelemetry
 * spanId（saga 出站） sha256(callId)[0..16]                            ← spanIdOf（历史约定，无前缀）
 * ```
 *
 * 为什么 saga 那套不加前缀：`packages/saga/src/gates/gates.test.ts` 里有硬编码期望值，
 * 改算法等于改协议——已发出的出站 `traceparent` 会对不上。派生 span 用另一套命名空间
 * （带 `bah/span/` 前缀），是为了让"同一个 callId 有两个 id"这件事在字符串上就能看出来，
 * 而不是靠人记。
 *
 * 三条纪律：
 * 1. **不许用 `randomUUID` / 时间戳**：同一份历史日志重算必须得到同一张图；
 * 2. **不许跟随入站 `traceparent` 改派生 trace-id**（否则历史不可重算）；
 * 3. **解析不抛**：入站 header 来自外部，非法值只能返回 `undefined`，不能让它引 500。
 */

import { BahError, sha256Hex } from '@bah/util'

/** 32 位小写 hex（W3C trace-id 宽度）。 */
export type TraceId = string
/** 16 位小写 hex（W3C span-id 宽度）。 */
export type SpanId = string

const HEX_32 = /^[0-9a-f]{32}$/
const HEX_16 = /^[0-9a-f]{16}$/
const ZERO_32 = '0'.repeat(32)
const ZERO_16 = '0'.repeat(16)

/** 会话 → trace（确定性；同一会话永远同一 trace）。 */
export function traceIdOfSession(sessionId: string): TraceId {
  return sha256Hex(`bah/trace/session:${sessionId}`).slice(0, 32)
}

/** `(kind, key)` → span（确定性；用于派生 span 的稳定 id）。 */
export function spanIdOfTelemetry(kind: string, key: string): SpanId {
  const id = sha256Hex(`bah/span/${kind}:${key}`).slice(0, 16)
  return id === ZERO_16 ? `${ZERO_16.slice(1)}1` : id
}

/**
 * 调用 ID → 出站 span-id（saga 历史约定：`sha256(callId)` 前 16 位，**无前缀**）。
 *
 * 迁自 `packages/saga/src/gates/index.ts`，算法逐字保留——`gates.test.ts` 有硬编码期望值。
 */
export function spanIdOf(callId: string): SpanId {
  const spanId = sha256Hex(callId).slice(0, 16)
  return spanId === ZERO_16 ? `${ZERO_16.slice(1)}1` : spanId
}

/** 一次 W3C 上下文解析结果。 */
export interface TraceContext {
  readonly traceId: TraceId
  readonly spanId: SpanId
  readonly sampled: boolean
}

/**
 * 解析 W3C `traceparent`：`<2hex>-<32hex>-<16hex>-<2hex>`。
 *
 * 照 W3C Trace Context Level 1 的五条判据：长度 55；`version != ff`；
 * trace-id / span-id 非全零；`flags` 只取 bit0；其余保留位忽略。
 *
 * **非法一律返回 `undefined`，绝不抛**——入站 header 不可信。
 */
export function parseTraceparent(value: string | undefined | null): TraceContext | undefined {
  if (typeof value !== 'string' || value.length !== 55) return undefined
  const parts = value.split('-')
  if (parts.length !== 4) return undefined
  const [version, traceId, spanId, flags] = parts as [string, string, string, string]
  if (version === 'ff' || !/^[0-9a-f]{2}$/.test(version)) return undefined
  if (!HEX_32.test(traceId) || traceId === ZERO_32) return undefined
  if (!HEX_16.test(spanId) || spanId === ZERO_16) return undefined
  if (!/^[0-9a-f]{2}$/.test(flags)) return undefined
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 0x01) === 1 }
}

/**
 * 构造 W3C `traceparent`：`00-<32hex>-<16hex>-<01|00>`。
 *
 * @throws `BahError('invalid-traceparent')` span-id 不是 16-hex 或为全零
 *   （trace-id 走 `toW3cTraceId` 确定性归一，不抛）
 */
export function buildTraceparent(traceId: string, spanId: string, sampled = true): string {
  const span = spanId.toLowerCase()
  if (!HEX_16.test(span) || span === ZERO_16) {
    throw new BahError('invalid-traceparent', `bah-telemetry: invalid-traceparent: span-id ${spanId}`, {
      spanId,
    })
  }
  return `00-${toW3cTraceId(traceId)}-${span}-${sampled ? '01' : '00'}`
}

/**
 * 任意字符串归一成 32 位小写 hex trace-id。
 *
 * 已是合法 32-hex（且非全零）→ 原样小写；否则 `sha256` 取前 32 位（确定性，不用随机）。
 */
export function toW3cTraceId(value: string): string {
  const lower = value.toLowerCase()
  if (HEX_32.test(lower) && lower !== ZERO_32) return lower
  const digest = sha256Hex(value).slice(0, 32)
  return digest === ZERO_32 ? `${ZERO_32.slice(1)}1` : digest
}

/* ───────────────────────────── 出站承载（saga 迁入） ───────────────────────────── */

/**
 * 把 `traceparent` 挂到调用的**浅拷贝**上。
 *
 * 三条性质都是有意的：
 * - **非枚举**：`JSON.stringify` / 参数指纹 / 模型侧都看不到它；
 * - **不可写/不可配置**：下游改不掉，否则对账时两个 id 谁也不认；
 * - **返回新对象**：原调用不被污染（测试里断言 `traceparentOf(original) === undefined`）。
 *
 * 参数类型用结构约束而不是 `ToolCallInput`：本包**不依赖 `@bah/core`**（R-2 /
 * `verify-package-graph`），迁过来时把类型放宽成 `object` 即可保持行为不变。
 */
export function withTraceparent<T extends object>(
  call: T,
  traceparent: string,
): T & { readonly traceparent: string } {
  const copy: Record<string, unknown> = { ...(call as Record<string, unknown>) }
  Object.defineProperty(copy, 'traceparent', {
    value: traceparent,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return copy as unknown as T & { readonly traceparent: string }
}

/** 读取调用上的出站追踪头（未注入时 `undefined`）。 */
export function traceparentOf(call: object): string | undefined {
  const value = (call as { readonly traceparent?: unknown }).traceparent
  return typeof value === 'string' ? value : undefined
}
