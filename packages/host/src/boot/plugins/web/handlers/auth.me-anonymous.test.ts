/**
 * `GET /api/auth/me` 的匿名分支（鉴权平面 02 的自查口）。
 *
 * 这个句柄只在"拿不到身份"时走 401 那条臂——`handlers/auth.test.ts` 走的是
 * 真实 dispatcher + 已登录会话，所以这条臂此前一次都没被执行过。
 * 它值得单独钉，是因为**前端启动时必打这一枪**：401 的形状决定了
 * 页面是弹登录卡还是把错误糊在会话界面上；把它写成 200 + 空 body，
 * 前端就会读成一个"已登录但没有 userId"的幽灵主体（`roles` 缺失 ⇒ 后面每个按钮都判错）。
 */

import { describe, expect, it } from 'vitest'

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebDeps, WebRequest } from '../deps.ts'
import type { RequestIdentity } from '../auth/identity.ts'
import { handleMe } from './auth.ts'

interface Probe {
  status: number
  body: string
}

/** 最小响应桩（本用例只看状态码与回包，不看头）。 */
function makeRes(): { res: ServerResponse; probe: Probe } {
  const probe: Probe = { status: 0, body: '' }
  const base: Record<string, unknown> = {
    headersSent: false,
    setHeader() {
      return base
    },
    writeHead(status: number) {
      probe.status = status
      base['headersSent'] = true
      return base
    },
    end(chunk?: string) {
      probe.body = chunk ?? ''
      return base
    },
    once() {
      return base
    },
  }
  return { res: base as unknown as ServerResponse, probe }
}

/** 只带身份字段的请求上下文（`dispatch` 预解析后挂在 request 上）。 */
function requestWith(identity: RequestIdentity | undefined): WebRequest {
  return {
    method: 'GET',
    url: new URL('http://127.0.0.1:7331/api/auth/me'),
    path: '/api/auth/me',
    rest: '',
    identity,
  }
}

/** `static` 模式的空 deps：401 分支不读它，传进来只为让调用形状保持真实。 */
const DEPS = { tenantId: 'demo', auth: { mode: 'static' }, now: () => 1_700_000_000_000 } as unknown as WebDeps

describe('handleMe · 匿名即 401', () => {
  it('dispatch 没挂身份 ⇒ 401 web-unauthorized（不是 200 空主体）', async () => {
    const { res, probe } = makeRes()
    await handleMe({} as IncomingMessage, res, requestWith(undefined), DEPS)

    expect(probe.status).toBe(401)
    expect(JSON.parse(probe.body) as { error: { code: string } }).toEqual({
      error: { code: 'web-unauthorized', reason: '缺少或失效的登录状态' },
    })
  })

  it('identity.kind=anonymous 与"没有 identity"同形：不给前端区分二进制的机会', async () => {
    const a = makeRes()
    const b = makeRes()
    await handleMe({} as IncomingMessage, a.res, requestWith(undefined), DEPS)
    await handleMe(
      {} as IncomingMessage,
      b.res,
      requestWith({ kind: 'anonymous' }),
      DEPS,
    )

    expect(a.probe.status).toBe(401)
    expect(b.probe.status).toBe(401)
    expect(b.probe.body).toBe(a.probe.body)
  })

  it('回包里不得出现 userId / roles / sid（401 也不能漏主体信息）', async () => {
    const { res, probe } = makeRes()
    await handleMe({} as IncomingMessage, res, requestWith(undefined), DEPS)

    expect(probe.body).not.toContain('userId')
    expect(probe.body).not.toContain('roles')
    expect(probe.body).not.toContain('bah_sid')
  })
})
