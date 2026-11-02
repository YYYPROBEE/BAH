/**
 * 知识平面端口的 span 装饰器（可观测性 01 / S1.8）。
 *
 * 为什么是"装饰端口"而不是"在调用点包一层"：`port.answer()` / `port.query()` 的**唯一**
 * 调用方在 `@bah/knowledge` 的 `createKnowledgeTools` 内部，宿主这边看不到那次调用；
 * 而 `KnowledgePort` 是宿主与知识平面之间唯一的接口，套在它上面才既覆盖两个工具、
 * 又不用改 `@bah/knowledge` 一行。
 *
 * 属性只能**事后补**：`kind` / `verdict` / `citations` 全在响应里。所以用
 * `open()` + `setAttributes()`，而不是 `withSpanAsync`（后者在进入时就定死属性，
 * 结果每一行都是空对象——比不记更坏）。
 */

import type { KnowledgePort } from '@bah/knowledge'

import type { TelemetryHandle } from './telemetry.ts'

/** 异常 → 理由码（与记录器同一口径：`code` 优先，否则 `unknown-error`）。 */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'unknown-error'
}

/**
 * 套一层 `rag.answer` / `rag.query`。
 *
 * 只读属性、不改请求体、不改异常：`health()` 原样透传（探活不在轨迹里，
 * 它一次启动只跑一次，记下来只是噪音）。
 */
export function withKnowledgeSpans(port: KnowledgePort, telemetry: TelemetryHandle): KnowledgePort {
  return {
    async answer(request, signal) {
      const span = telemetry.recorder.open('rag.answer')
      try {
        const response = await port.answer(request, signal)
        span.setAttributes({
          kind: response.kind,
          verdict: response.verdict,
          citations: response.citations.length,
        })
        span.end('ok')
        return response
      } catch (error) {
        span.end('error', codeOf(error))
        throw error
      }
    },

    async query(request, signal) {
      const span = telemetry.recorder.open('rag.query')
      try {
        const response = await port.query(request, signal)
        span.setAttributes({
          kind: response.kind,
          verdict: response.verdict,
          visibleCount: response.visibleCount,
        })
        span.end('ok')
        return response
      } catch (error) {
        span.end('error', codeOf(error))
        throw error
      }
    },

    health(signal) {
      return port.health(signal)
    },
  }
}
