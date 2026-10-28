/**
 * `/api/metrics` 的租户字段（租户与鉴权 01 · 复审 AR-01）。
 *
 * **为什么不能只靠 web.test.ts 的那条**：那边的 harness 固定用 `testRunContext()` 的缺省
 * 租户 `demo`，所以把处理器写成 `tenant: 'demo'` 它也会绿——那是一条**对"租户来自 run"
 * 恒真**的断言。这里直接给 `WebDeps` 一个非 demo 租户，证明处理器读的是 `deps.tenantId`。
 */

import { describe, expect, it } from 'vitest'

import { parseTenantId } from '@bah/util'

import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleMetrics } from './handlers/metrics.ts'
import type { WebDeps, WebRequest } from './deps.ts'

/** 捕获 `sendJson` 写出的响应体。 */
function captureResponse(): { res: ServerResponse; body: () => unknown } {
  let payload = ''
  const res = {
    writeHead: () => res,
    end: (chunk?: string) => {
      payload = chunk ?? ''
    },
  } as unknown as ServerResponse
  return { res, body: () => JSON.parse(payload) as unknown }
}

/** 只喂 `handleMetrics` 真正用到的那几项。 */
function depsWith(tenant: string): WebDeps {
  return {
    tenantId: parseTenantId(tenant),
    session: { sessionId: 's-metrics', lastSeq: () => 3, events: () => [] },
    now: () => 1_700_000_000_000,
    tryHalt: () => undefined,
    hub: { size: () => 0 },
  } as unknown as WebDeps
}

const request: WebRequest = {
  method: 'GET',
  url: new URL('http://127.0.0.1/api/metrics'),
  path: '/api/metrics',
  rest: '',
}

describe('handleMetrics · tenant', () => {
  it('AR-01-1 非 demo 租户 → 返回体第一层就是它（证明来自 deps，不是常量）', async () => {
    const { res, body } = captureResponse()
    await handleMetrics({} as IncomingMessage, res, request, depsWith('acme-bank'))
    expect(body()).toMatchObject({ tenant: 'acme-bank', sessionId: 's-metrics', lastSeq: 3 })
  })

  it('AR-01-2 换一个租户立即跟着变（同一处理器，无缓存、无全局）', async () => {
    const first = captureResponse()
    await handleMetrics({} as IncomingMessage, first.res, request, depsWith('demo'))
    const second = captureResponse()
    await handleMetrics({} as IncomingMessage, second.res, request, depsWith('other'))
    expect(first.body()).toMatchObject({ tenant: 'demo' })
    expect(second.body()).toMatchObject({ tenant: 'other' })
  })
})
