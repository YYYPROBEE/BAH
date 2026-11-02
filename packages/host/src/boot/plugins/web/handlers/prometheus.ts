/**
 * `GET /api/metrics?format=prometheus`（可观测性 02 / S2.8）。
 *
 * 仍然走 `handleMetrics` 入口（不新增路由）：`?format` 或 `Accept: text/plain` 时
 * 由 `handleMetrics` 转到这里。这样鉴权/限流/CSRF 面与 JSON 完全同一条闸。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { collectMetrics, renderPrometheus } from '@bah/telemetry'

import { SECURITY_HEADERS } from '../http.ts'
import type { WebDeps, WebRequest } from '../deps.ts'
import { buildMetricsView, metricInputsOf } from './metrics-extra.ts'

/** 输出 Prometheus 文本（`text/plain; version=0.0.4`）。 */
export async function handlePrometheusMetrics(
  _req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const view = buildMetricsView(deps)
  const body = renderPrometheus(collectMetrics(metricInputsOf(view)))
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}
