/**
 * span 模型：类型、名字闭集、属性白名单。
 *
 * 三条纪律：
 *
 * 1. **名字是闭集**（13 个，见 `SPAN_NAMES`）。把工具名拼进 span 名
 *    （`tool.execute.transfer_create`）有三个坏处：图例随工具增长、改名即断历史对比、
 *    门禁无法静态校验。工具名进 `attributes.tool`（值域 16 个，可控）。
 *    同理，闭集里**每个名字都必须有发射点**——留一个永不发射的合法名字，
 *    等于把"每个名字都被用到"这条判据稀释成"看起来有 13 个"。
 * 2. **属性是白名单**：每个 span 类型只允许固定键。这是 PII 防线，不是洁癖——
 *    一旦允许自由塞，第一个塞进去的必然是用户输入（因为调试时它最有信息量）。
 * 3. **`endMs: null` 与 `endMs === startMs` 是两件事**：前者是"到事件末尾仍未闭合"
 *    （排障最关心的"卡在哪"），后者是"耗时为 0"（快照里 `fixedClock` 幂等导致的正常现象）。
 *    这与 `/api/metrics` 里 `p95 === null` ≠ `0` 是同一条纪律。
 */

import { BahError } from '@bah/util'

import type { SpanId, TraceId } from './ids.ts'

/**
 * span 名闭集。
 *
 * 顺序即"阅读顺序"：入口 → 主循环 → 模型/工具 → 审批 → 编排 → 出站协议。
 * `verify-telemetry` 校验：恰好 13 个、无重复、每个名字至少一个发射点。
 */
export const SPAN_NAMES = [
  'http.request',
  'sse.attach',
  'turn',
  'step',
  'llm.call',
  'tool.execute',
  'approval.wait',
  'plan.run',
  'plan.node',
  'saga.run',
  'rag.answer',
  'rag.query',
  'policy.evaluate',
] as const

export type SpanName = (typeof SPAN_NAMES)[number]

/**
 * span 状态。
 *
 * - `ok`：正常闭合；
 * - `error`：闭合但失败（`code` 必有值）；
 * - `unset`：**未闭合**（`endMs === null`）。不是"没状态"，是"还没结束"。
 */
export type SpanStatus = 'ok' | 'error' | 'unset'

/** 属性值：只允许标量（Chrome Trace 的 `args` 也只放扁平值）。 */
export type SpanAttributes = Readonly<Record<string, string | number | boolean>>

/** 一个扁平 span。父子关系靠 `parentSpanId`，时序靠 `startMs/endMs`。 */
export interface TelemetrySpan {
  readonly traceId: TraceId
  readonly spanId: SpanId
  readonly parentSpanId: SpanId | null
  readonly name: SpanName
  /** epoch ms；派生 span 取事件 `at`，包裹 span 取注入钟。 */
  readonly startMs: number
  /** epoch ms；`null` = 到事件末尾仍未闭合（不是 0）。 */
  readonly endMs: number | null
  readonly status: SpanStatus
  /** 失败理由码（`BahError.code` 优先）。 */
  readonly code?: string
  readonly attributes: SpanAttributes
  readonly source: 'derived' | 'recorded'
}

/**
 * **结构标记**：任何 span 名都允许，由本库自己写。
 *
 * 与业务属性的区别是"谁写的"：这五个键全部由遥测库在固定分支里写入
 * （`clock`/`open` 由派生器、`orphan` 由建树、`durationSource`/`duplicateCallId` 由派生器），
 * 值域是枚举或布尔，不可能承载原文。把它们逐个摊进 13 行白名单，只会让表看起来更长。
 */
export const STRUCTURAL_ATTRIBUTE_KEYS = [
  // 时钟不可信（快照回放）的标注：值为 'frozen'。UI 必须据此显示"结构可见、时长不可用"。
  'clock',
  // 未闭合标注：值为 true。与 `endMs === null` 同义，冗余一份是为了让导出文件自解释。
  'open',
  // 父 span 被采样丢掉后提升为根：由 `buildForest` 写，不抛。
  'orphan',
  // `tool.execute` 的 durationMs 是取自 `tool/result.durationMs`（'tool'）还是墙钟（'wall'）。
  'durationSource',
  // 同一 callId 出现多次（`engine.ts:567` 的 `#1` 已知缺陷）：只保留最后一条并标注。
  'duplicateCallId',
  // 入站 W3C traceparent 的 trace-id（仅对账用，**不参与**派生 trace-id）。
  'inboundTraceId',
] as const

/**
 * 每个 span 名允许的**业务**属性键（闭集）。
 *
 * 取值理由逐行写在右列注释里；新增一个键要先回答"它是不是用户输入"，
 * 是就别加——那种信息属于日志和审计，不属于图。
 */
export const SPAN_ATTRIBUTE_KEYS: Readonly<Record<SpanName, readonly string[]>> = {
  // 只记路由模板与状态码；URL query / header / body / token 一律不进（里面有凭证）。
  'http.request': ['method', 'route', 'status', 'bytes', 'requestSeq'],
  // 连接数与时点；不连 IP（单机场景下 IP == 身份，属于 PII）。
  'sse.attach': ['clients', 'since'],
  // 结束原因只记 kind（枚举），不记 reason 文本（文本里会出现模型原话）。
  turn: ['turn', 'end', 'steps'],
  step: ['turn', 'step'],
  // ttftMs 只对真流式有意义；chunks 是分片数。
  'llm.call': ['model', 'attempt', 'ttftMs', 'chunks'],
  // code 是理由码闭集，不是原始错误文本（原始文本里有账号尾号）。
  'tool.execute': ['tool', 'tier', 'isError', 'code'],
  // challenge 是"要人确认什么"的枚举，不是票据指纹。
  'approval.wait': ['tool', 'decision', 'challenge'],
  'plan.run': ['planId', 'nodes', 'status', 'dryRun'],
  'plan.node': ['planId', 'nodeId', 'tool', 'ordinal', 'status'],
  'saga.run': ['sagaId', 'businessType', 'status'],
  'rag.answer': ['kind', 'verdict', 'citations'],
  'rag.query': ['kind', 'verdict', 'visibleCount'],
  'policy.evaluate': ['verdict', 'policyVersion', 'engineSource'],
}

/** 属性名 → 允许的 span 名集合（反查表，模块加载期建一次）。 */
const OWNERS: ReadonlyMap<string, ReadonlySet<SpanName>> = (() => {
  const map = new Map<string, Set<SpanName>>()
  for (const name of SPAN_NAMES) {
    for (const key of SPAN_ATTRIBUTE_KEYS[name]) {
      const bucket = map.get(key) ?? new Set<SpanName>()
      bucket.add(name)
      map.set(key, bucket)
    }
  }
  return map
})()

const STRUCTURAL = new Set<string>(STRUCTURAL_ATTRIBUTE_KEYS)

/** 属性值的字符串长度上限。超过这个长度的字符串必然不是枚举值，而是某段原文。 */
export const MAX_ATTRIBUTE_STRING = 64

/**
 * 校验属性：键在闭集内（业务键 + 结构标记）、值是有限标量、字符串不超过 64 字符。
 *
 * @throws `BahError('telemetry-attribute-invalid')` 任一条件不满足。
 *   **开发期就抛**（记录器不把它降级成静默丢弃）——白名单的价值在于"写错立刻知道"，
 *   自动降级会让 `attributes.tool` 永远缺失而没人发现。
 */
export function assertAttributes(name: SpanName, attributes: SpanAttributes | undefined): void {
  if (attributes === undefined) return
  const allowed = new Set<string>([...SPAN_ATTRIBUTE_KEYS[name], ...STRUCTURAL_ATTRIBUTE_KEYS])
  for (const [key, value] of Object.entries(attributes)) {
    if (!allowed.has(key)) {
      throw new BahError(
        'telemetry-attribute-invalid',
        `bah-telemetry: span ${name} 不允许属性 ${key}`,
        { name, key, allowed: [...allowed] },
      )
    }
    const type = typeof value
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new BahError(
        'telemetry-attribute-invalid',
        `bah-telemetry: 属性 ${name}.${key} 必须是标量（收到 ${type}）`,
        { name, key, type },
      )
    }
    if (type === 'string' && (value as string).length > MAX_ATTRIBUTE_STRING) {
      throw new BahError(
        'telemetry-attribute-invalid',
        `bah-telemetry: 属性 ${name}.${key} 字符串超过 ${String(MAX_ATTRIBUTE_STRING)} 字符（疑似原文）`,
        { name, key, length: (value as string).length },
      )
    }
    if (type === 'number' && !Number.isFinite(value as number)) {
      throw new BahError(
        'telemetry-attribute-invalid',
        `bah-telemetry: 属性 ${name}.${key} 不是有限数`,
        { name, key },
      )
    }
  }
}

/** 某个属性键是否被任一名允许（供文档/门禁做反查，不参与运行期判定）。 */
export function spanNamesAllowing(key: string): readonly SpanName[] {
  return [...(OWNERS.get(key) ?? [])]
}

/** 是否"未闭合"。 */
export function isOpen(span: TelemetrySpan): boolean {
  return span.endMs === null
}

/**
 * 时长（毫秒）：未闭合返回 `null`（**不是 0**）。
 *
 * 调用方三处都必须区分：
 * - JSON 输出 `null`；
 * - Prometheus 输出 NaN / 不输出该 series；
 * - UI 显示"无样本 / 进行中"。
 */
export function durationMsOf(span: TelemetrySpan): number | null {
  if (span.endMs === null) return null
  return span.endMs - span.startMs
}
