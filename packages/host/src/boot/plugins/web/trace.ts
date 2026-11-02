/**
 * `channel:web` 的 HTTP 请求 span（可观测性 01 / S1.8）。
 *
 * 之所以独立成文件而不是塞进 `dispatch.ts`：`dispatch.ts` 是**闸的唯一防线**
 * （限流 → Bearer → CSRF → 业务），132 行的判定链已经不容易读；
 * 把"计时"混进去，下一次改闸的人就得同时理解两件事。
 *
 * 两个刻意的选择：
 *
 * 1. **用 `res.once('close')` 收尾，不用 `try/finally`**：闸有 6 个提前 `return`
 *    （429/401/403/404/405），逐个包 `try` 会把"闸的顺序"改写成嵌套结构；
 *    而 `close` 在正常结束与连接中断时都会触发，一次注册覆盖全部出口。
 * 2. **`route` 取路由模板（`match.spec.path`）而不是原始 URL**：
 *    `/api/approval/<ticketId>` 里的票据号一旦进 span，就等于把凭证写进了日志。
 *    未命中的请求统一记 `unmatched`——宁可丢失"哪个 URL 被打"，也不记准原文。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { parseTraceparent, type OpenSpan } from '@bah/telemetry'

import type { TelemetryHandle } from '../telemetry.ts'

/** 5xx 才算 error：4xx 是调用方的问题，不是服务坏了。 */
function classOf(status: number): 'ok' | 'error' {
  return status >= 500 ? 'error' : 'ok'
}

/**
 * 进程内请求序号。
 *
 * `traceId` 是**会话级**的（同一会话永远同一 trace，见 01 §3.2 注 2），所以
 * "这是第几次请求"只能作为属性存在。`requestSeq` 就是这个属性：它不进 spanId、
 * 不参与派生，只在同一棵树里把多个 `http.request` 根区分开。
 */
let requestSeq = 0

/** 取入站 `traceparent`（Node 的 header 可能是 string[]；非法值交给解析器判 undefined）。 */
function inboundTraceparent(req: IncomingMessage): string | undefined {
  const raw = req.headers['traceparent']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : undefined
}

/**
 * 开一条 `http.request` span，并在响应关闭时收尾。
 *
 * 返回 `false` 表示"没有遥测"，调用方无需分支（本函数自己判空）。
 */
export function startHttpSpan(
  telemetry: TelemetryHandle | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
): boolean {
  if (telemetry === undefined) return false
  let span: OpenSpan
  requestSeq += 1
  // 入站 traceparent **只做对账**：把外部系统的 trace-id 记进属性，
  // **不覆盖**派生 trace-id（覆盖会让同一份 session.jsonl 在不同请求头下算出不同的图）。
  const inbound = parseTraceparent(inboundTraceparent(req))
  try {
    span = telemetry.recorder.open('http.request', {
      method: req.method ?? 'GET',
      route,
      requestSeq,
      ...(inbound === undefined ? {} : { inboundTraceId: inbound.traceId }),
    })
  } catch {
    // fail-open：开一条 span 失败绝不能让请求 500。
    return false
  }

  const settle = (): void => {
    const status = res.statusCode
    const length = res.getHeader('content-length')
    const bytes = typeof length === 'number' ? length : Number.parseInt(String(length ?? ''), 10)
    // `0` 字节是有效值（204/304），不能和"没有 content-length"混成一种。
    span.setAttributes(Number.isFinite(bytes) && bytes >= 0 ? { status, bytes } : { status })
    span.end(classOf(status), status >= 500 ? 'http-5xx' : undefined)
  }

  if (res.writableEnded) settle()
  else res.once('close', settle)
  return true
}
