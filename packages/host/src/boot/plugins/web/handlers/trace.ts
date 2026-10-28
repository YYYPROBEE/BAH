/**
 * `GET /api/trace`（可观测性 02 / S2.8）。
 *
 * 三个出口：
 * - 默认 JSON 森林（`roots` + `stats`）；
 * - `?format=chrome` → Chrome Trace Event Format（裸数组，Perfetto 可开）；
 * - `?format=json&limit=N` → 最近 N 条 span 的森林。
 *
 * 纪律：鉴权与其它业务路由同闸（Bearer）；GET 不加 CSRF。
 * 单次响应上限 4 MiB，超了直接 503——**不截断返回半棵树**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { buildForest, toChromeTrace, traceIdOfSession, type TelemetrySpan } from '@bah/telemetry'

import type { TelemetryHandle } from '../../telemetry.ts'
import { SECURITY_HEADERS, sendError } from '../http.ts'
import type { WebDeps, WebRequest } from '../deps.ts'

const MAX_BYTES = 4 * 1024 * 1024

/** 解析 `limit`：缺省全部；非法返回 `undefined`（调用方给 400）。 */
function parseLimit(url: URL): number | undefined | null {
  const raw = url.searchParams.get('limit')
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

/** 输出 JSON / Chrome Trace。 */
export async function handleTrace(
  _req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const handle = deps.tryTelemetry()
  if (handle === undefined) {
    sendError(res, 503, 'trace-unavailable', '本 profile 未装配 obs:telemetry')
    return
  }

  const format = request.url.searchParams.get('format') ?? 'json'
  if (format !== 'json' && format !== 'chrome') {
    sendError(res, 400, 'trace-format-unsupported', `format 只支持 json / chrome（收到 ${format}）`)
    return
  }
  const limit = parseLimit(request.url)
  if (limit === null) {
    sendError(res, 400, 'trace-limit-invalid', 'limit 必须是正整数')
    return
  }

  const snapshot = handle.derive()
  const spans: readonly TelemetrySpan[] = limit === undefined ? snapshot.spans : snapshot.spans.slice(-limit)
  const text =
    format === 'chrome'
      ? toChromeTrace(spans)
      : jsonOf(handle, spans, snapshot.clockTrusted, String(deps.session.sessionId))

  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    sendError(res, 503, 'trace-too-large', '序列化超过 4 MiB；请用 ?limit=N 收敛')
    return
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** JSON 森林：`traceId` 由 session 派生，`stats.open` 显式给出未闭合条数。 */
function jsonOf(
  handle: TelemetryHandle,
  spans: readonly TelemetrySpan[],
  clockTrusted: boolean,
  sessionId: string,
): string {
  const roots = buildForest(spans)
  let depth = 0
  const walk = (node: { readonly depth: number; readonly children: readonly unknown[] }): void => {
    depth = Math.max(depth, node.depth)
    for (const child of node.children) walk(child as { readonly depth: number; readonly children: readonly unknown[] })
  }
  for (const root of roots) walk(root)

  return JSON.stringify({
    traceId: traceIdOfSession(sessionId),
    sessionId,
    clock: clockTrusted ? 'trusted' : 'frozen',
    stats: {
      spans: spans.length,
      dropped: handle.stats.dropped,
      depth,
      open: spans.filter((span) => span.endMs === null).length,
    },
    roots,
  })
}
