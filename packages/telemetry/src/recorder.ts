/**
 * 记录器：环形缓冲 + `withSpan` / `withSpanAsync` + 采样 + 确定性淘汰。
 *
 * 三件事必须一起理解：
 *
 * 1. **同步优先**：`withSpan` 只包同步调用。要对 Promise settle 计时就只能挂 `.then/.finally`，
 *    而那**必然返回新 Promise**、把后续微任务推迟一轮。`session/service.ts` 的排空循环依赖
 *    "同步派发完再返回"，一旦被推迟，Web 帧顺序就会乱、审批弹窗会不出现。
 *    异步场景用 `withSpanAsync`，但**禁止**用在 `agent/pre-step` / `tools/*` 的 waterfall 里
 *    （注册顺序 = 外层顺序，被包一层就变了）。
 * 2. **fail-open**：遥测任何环节抛错都只计数、不改业务结果——`sink` 抛错吞掉、
 *    属性非法只丢属性、采样掉的调用照常执行 `fn`。判据是"这条记录丢了，会不会有人少赔钱/多转账"：
 *    不会 → 必须吞。
 * 3. **确定性淘汰**：不用随机、不用时间戳。先丢最旧的普通成功 span，再丢最旧的 `http.request`，
 *    `error` 留到最后一刻。
 */

import { orderSpans } from './derive.ts'
import { spanIdOfTelemetry, traceIdOfSession, type SpanId } from './ids.ts'
import { assertAttributes, type SpanAttributes, type SpanName, type SpanStatus, type TelemetrySpan } from './span.ts'

/** 可变视图（只在本模块内部用；`snapshot()` 出去的一律是深拷贝的只读对象）。 */
type MutableSpan = { -readonly [K in keyof TelemetrySpan]: TelemetrySpan[K] }

/** 属性入参（与 `TelemetrySpan.attributes` 同形）。 */
type RecorderAttributes = Readonly<Record<string, string | number | boolean>>

export interface RecorderOptions {
  /** 环形缓冲容量（缺省 2000）。 */
  readonly maxSpans?: number
  /** 注入钟（**禁 `Date.now()`**：快照回放会漂到"今天"）。 */
  readonly now: () => number
  /** 按 span 名的采样率（缺省见 `DEFAULT_SAMPLE`）。 */
  readonly sample?: Readonly<Record<string, number>>
  /** 会话 ID：决定 traceId。必填——否则同一会话重启后会出现两个 trace。 */
  readonly sessionId: string
  /** 追加式 JSONL 出口；`undefined` = 只留内存。 */
  readonly sink?: (span: TelemetrySpan) => void
  /** 父 span 解析：包裹 span 的 parent 由宿主插件在作用域里给。缺省 = 无父（根）。 */
  readonly parentOf?: () => SpanId | null
}

/**
 * 采样默认值（只对**包裹**生效，派生 span 不采样——它们免费且可重算）。
 *
 * `http.request` / `saga.run` / `rag.*` 全留：低频且是排障入口。
 * `policy.evaluate` 每次判决都跑，默认 0.1，否则一天能刷出几十万条。
 */
export const DEFAULT_SAMPLE: Readonly<Record<string, number>> = {
  'http.request': 1,
  'sse.attach': 1,
  'saga.run': 1,
  'rag.answer': 1,
  'rag.query': 1,
  'policy.evaluate': 0.1,
}

export interface RecorderStats {
  readonly size: number
  /** 因容量淘汰掉的 span 数。 */
  readonly dropped: number
  /** 其中"本该永不被淘汰的 error"被迫淘汰的条数（>0 说明容量真的不够）。 */
  readonly droppedErrors: number
  /** `sink` 抛错的次数（吞掉，但必须能看见）。 */
  readonly exportErrors: number
  /** 属性白名单拦下的次数（开发期写错属性的信号）。 */
  readonly attributeErrors: number
  /** 被采样丢掉的包裹调用次数。 */
  readonly sampledOut: number
}

/** 手动开/关的句柄（SSE、流式分片这类长生命周期场景）。 */
export interface OpenSpan {
  readonly spanId: SpanId
  /**
   * 补写/覆盖属性（**只在 `end` 之前有效**，`end` 之后再调是空操作）。
   *
   * 为什么需要它：`http.request` 的 `status` / `bytes` 只有在响应结束时才知道，
   * 而"开始时就定死属性"会让每一行都是 `status: 0`——比不记更坏。
   */
  setAttributes(attributes: RecorderAttributes): void
  end(status?: SpanStatus, code?: string): void
}

export interface SpanRecorder {
  /**
   * **只包同步调用**。`fn` 抛错时 span 记为 error 并**原样抛出**（不包装、不改栈）。
   *
   * 被采样掉时 span 不入缓冲、不写 `sink`，但 `fn` **照常执行**，且 `spanId` 仍然可用
   * （出站 `traceparent` 不会因为采样而失效）。
   */
  withSpan<T>(name: SpanName, attributes: RecorderAttributes, fn: (spanId: SpanId) => T): T
  /**
   * 包一次**异步**调用（会返回新 Promise，允许微任务顺序变化）。
   *
   * 只允许用在**不在事件派发链上**的位置：HTTP 请求处理、RAG 端口调用、saga 正/反向编排。
   */
  withSpanAsync<T>(
    name: SpanName,
    attributes: RecorderAttributes,
    fn: (spanId: SpanId) => Promise<T>,
  ): Promise<T>
  /** 外部注入用：手动开/关。 */
  open(name: SpanName, attributes?: RecorderAttributes): OpenSpan
  /** 把派生结果并入缓冲（去重：同 spanId 只保留一条，后者覆盖前者）。 */
  absorb(spans: readonly TelemetrySpan[]): void
  /** 快照（深拷贝，按 `(startMs, spanId)` 全序）。 */
  snapshot(): readonly TelemetrySpan[]
  readonly stats: RecorderStats
}

/** 默认容量。 */
const DEFAULT_MAX_SPANS = 2000

/** 造一个记录器。 */
export function createRecorder(options: RecorderOptions): SpanRecorder {
  const maxSpans = Math.max(1, options.maxSpans ?? DEFAULT_MAX_SPANS)
  const sink = options.sink
  const rules: Record<string, number> = { ...DEFAULT_SAMPLE, ...(options.sample ?? {}) }
  const traceId = traceIdOfSession(options.sessionId)

  const buffer: MutableSpan[] = []
  let sequence = 0
  let dropped = 0
  let droppedErrors = 0
  let exportErrors = 0
  let attributeErrors = 0
  let sampledOut = 0

  /**
   * 采样结论：`spanId` 前 16 位当均匀分布用。
   *
   * 为什么用 `spanId` 而不是 `Math.random()`：同一个 span 永远得到同一结论，
   * 重启不漂移，测试可复现（"1000 个 key 保留 60~140 个"这条用例才成立）。
   */
  const keep = (name: SpanName, spanId: SpanId): boolean => {
    const ratio = rules[name] ?? 1
    if (ratio >= 1) return true
    if (ratio <= 0) return false
    return parseInt(spanId.slice(0, 4), 16) / 0x10000 < ratio
  }

  const emit = (span: TelemetrySpan): void => {
    if (sink === undefined) return
    try {
      sink(span)
    } catch {
      // 告警/导出链路不能因为一个消费端坏掉而影响业务：吞掉但计数。
      exportErrors += 1
    }
  }

  /**
   * 确定性淘汰。
   *
   * 顺序：最旧的普通成功 → 最旧的 `http.request` 成功 → 最旧的 error（并计数）。
   * **未闭合的 span 最后也要能淘汰**：全剩未闭合时若坚持不丢，缓冲会无界增长，
   * 长时间 SSE 场景下内存曲线会失控——这比"未闭合优先"更重要。
   */
  const evictIfNeeded = (): void => {
    while (buffer.length >= maxSpans) {
      let index = buffer.findIndex((s) => s.status === 'ok' && s.name !== 'http.request')
      if (index < 0) index = buffer.findIndex((s) => s.status === 'ok')
      if (index >= 0) {
        buffer.splice(index, 1)
        dropped += 1
        continue
      }
      index = buffer.findIndex((s) => s.status === 'error')
      if (index >= 0) {
        buffer.splice(index, 1)
        dropped += 1
        droppedErrors += 1
        continue
      }
      buffer.shift()
      dropped += 1
    }
  }

  const push = (span: MutableSpan): void => {
    evictIfNeeded()
    buffer.push(span)
  }

  const safeAttributes = (name: SpanName, attributes: RecorderAttributes | undefined): Record<string, string | number | boolean> => {
    try {
      assertAttributes(name, attributes)
      return { ...(attributes ?? {}) }
    } catch {
      // 生产期降级：丢属性而不是丢 span，更不能抛给业务。
      attributeErrors += 1
      return {}
    }
  }

  /** 建一条新 span（**无论是否采样**都算出 id，保证出站 traceparent 可用）。 */
  const begin = (
    name: SpanName,
    attributes: RecorderAttributes | undefined,
  ): { span: MutableSpan; recorded: boolean } => {
    sequence += 1
    const spanId = spanIdOfTelemetry(name, String(sequence))
    const span: MutableSpan = {
      traceId,
      spanId,
      parentSpanId: options.parentOf?.() ?? null,
      name,
      startMs: Math.round(options.now()),
      endMs: null,
      status: 'unset',
      attributes: safeAttributes(name, attributes),
      source: 'recorded',
    }
    const recorded = keep(name, spanId)
    if (recorded) push(span)
    else sampledOut += 1
    return { span, recorded }
  }

  const finish = (span: MutableSpan, recorded: boolean, status: SpanStatus, code?: string): void => {
    if (span.endMs !== null) return
    span.endMs = Math.max(Math.round(options.now()), span.startMs)
    span.status = status
    if (code !== undefined) span.code = code
    if (recorded) emit(cloneSpan(span))
  }

  return {
    withSpan<T>(name: SpanName, attributes: RecorderAttributes, fn: (spanId: SpanId) => T): T {
      const { span, recorded } = begin(name, attributes)
      try {
        const value = fn(span.spanId)
        finish(span, recorded, 'ok')
        return value
      } catch (error) {
        finish(span, recorded, 'error', codeOf(error))
        // **原样抛出**：包装会改栈、改 `instanceof` 判定，业务侧的重试分支会失效。
        throw error
      }
    },

    async withSpanAsync<T>(
      name: SpanName,
      attributes: RecorderAttributes,
      fn: (spanId: SpanId) => Promise<T>,
    ): Promise<T> {
      const { span, recorded } = begin(name, attributes)
      // `end` 只允许生效一次（`fn` 自己抛错与 `.catch` 双触发时不能写两次）。
      let ended = false
      const end = (status: SpanStatus, code?: string): void => {
        if (ended) return
        ended = true
        finish(span, recorded, status, code)
      }
      try {
        const value = await fn(span.spanId)
        end('ok')
        return value
      } catch (error) {
        end('error', codeOf(error))
        throw error
      }
    },

    open(name: SpanName, attributes?: RecorderAttributes): OpenSpan {
      const { span, recorded } = begin(name, attributes)
      return {
        spanId: span.spanId,
        setAttributes(next: RecorderAttributes): void {
          if (span.endMs !== null) return
          const merged = { ...span.attributes, ...next }
          try {
            assertAttributes(name, merged)
            span.attributes = merged
          } catch {
            attributeErrors += 1
          }
        },
        end: (status: SpanStatus = 'ok', code?: string): void => {
          finish(span, recorded, status, code)
        },
      }
    },

    absorb(spans: readonly TelemetrySpan[]): void {
      for (const incoming of spans) {
        const index = buffer.findIndex((s) => s.spanId === incoming.spanId)
        if (index >= 0) buffer[index] = { ...incoming }
        else push({ ...incoming })
      }
    },

    snapshot(): readonly TelemetrySpan[] {
      return orderSpans(buffer.map(cloneSpan))
    },

    get stats(): RecorderStats {
      return { size: buffer.length, dropped, droppedErrors, exportErrors, attributeErrors, sampledOut }
    },
  }
}

/** 深拷贝（`attributes` 冻结成新对象：出去以后谁也不能改回来）。 */
function cloneSpan(span: MutableSpan): TelemetrySpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    startMs: span.startMs,
    endMs: span.endMs,
    status: span.status,
    ...(span.code === undefined ? {} : { code: span.code }),
    attributes: Object.freeze({ ...(span.attributes as SpanAttributes) }),
    source: span.source,
  }
}

/** 抛出物 → 理由码（`BahError.code` 优先）。不引 core，所以在这里就地判形状。 */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'unknown-error'
}
