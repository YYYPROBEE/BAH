/**
 * `POST /api/secure/password`（ADR-0014）。
 *
 * 三条判据：
 * 1. **响应里不出现任何密码材料**——成功只有 `{ ok, changedAt }`，失败只有 `{ error }`；
 * 2. 失败码到状态码的映射是封闭表（未登记的一律上抛，不伪装成 400）；
 * 3. 端口缺失时回 501（"本部署没装能力" ≠ "实现炸了"），而不是 500。
 *
 * 闸（限流 / 身份 401 / 角色 403 / CSRF 403）在 `dispatch.ts`，由 `dispatch.test.ts` 覆盖；
 * 本文件只测 handler 自己那一层，所以直接造 `WebDeps` 并调用 handler。
 */

import { describe, expect, it } from 'vitest'

import type { IncomingMessage, ServerResponse } from 'node:http'

import { BahError } from '@bah/util'

import { handleSecurePassword } from './password.ts'

import type { SecurePasswordPort, WebDeps } from '../deps.ts'

/** 造一个假请求（只提供 `readJson` 需要的异步迭代器）。 */
function makeReq(body: unknown): IncomingMessage {
  const chunks = [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    headers: { 'content-type': 'application/json' },
  } as unknown as IncomingMessage
}

/** 造一个假响应（记录状态码与响应体文本）。 */
function makeRes(): { res: ServerResponse; reply: () => { status: number; text: string } } {
  let status = 0
  let text = ''
  const res = {
    statusCode: 0,
    setHeader() {
      return undefined
    },
    writeHead(code: number) {
      status = code
      return res
    },
    end(payload?: string) {
      text = payload ?? ''
      return res
    },
  } as unknown as ServerResponse
  return { res, reply: () => ({ status, text }) }
}

/** 造依赖（只有本 handler 用到的两个字段有意义）。 */
function makeDeps(port: SecurePasswordPort | undefined): WebDeps {
  return {
    session: { sessionId: 's-web' },
    tryPassword: () => port,
  } as unknown as WebDeps
}

/** 记录型端口（默认成功；可注入失败）。 */
function makePort(
  outcome: (req: { ticketId: string; oldPassword: string; newPassword: string }) => unknown = () => ({
    changedAt: 1_700_000_000_001,
  }),
): { port: SecurePasswordPort; calls: { sessionId: string; body: Record<string, string> }[] } {
  const calls: { sessionId: string; body: Record<string, string> }[] = []
  return {
    calls,
    port: {
      async submit(sessionId, req) {
        calls.push({ sessionId, body: { ...req } })
        const value = outcome(req)
        if (value instanceof Error) throw value
        return value as { changedAt: number }
      },
    },
  }
}

/** 调一次 handler。 */
async function call(
  deps: WebDeps,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const { res, reply } = makeRes()
  await handleSecurePassword(makeReq(body), res, {} as never, deps)
  const { status, text } = reply()
  return { status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), text }
}

describe('POST /api/secure/password', () => {
  it('成功：200 + { ok, changedAt }，响应体里没有任何密码材料', async () => {
    const { port, calls } = makePort()
    const result = await call(makeDeps(port), {
      ticketId: 'pwd:c-1',
      oldPassword: 'bank1234',
      newPassword: 'SuperSecret123',
    })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, changedAt: 1_700_000_000_001 })
    // 明文没有出现在响应里（连字段名都没有），而且身份来自会话
    expect(result.text).not.toContain('bank1234')
    expect(result.text).not.toContain('SuperSecret123')
    expect(result.text).not.toContain('oldPassword')
    expect(result.text).not.toContain('newPassword')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionId).toBe('s-web')
    expect(calls[0]?.body).toEqual({
      ticketId: 'pwd:c-1',
      oldPassword: 'bank1234',
      newPassword: 'SuperSecret123',
    })
  })

  it('缺字段 → 400 web-invalid-body（只报缺哪个字段，不回显值）', async () => {
    const { port, calls } = makePort()
    const result = await call(makeDeps(port), { ticketId: 'pwd:c-1', oldPassword: 'bank1234' })
    expect(result.status).toBe(400)
    expect((result.body['error'] as { code?: string }).code).toBe('web-invalid-body')
    expect(result.text).not.toContain('bank1234')
    // 缺字段时根本不该触达端口
    expect(calls).toHaveLength(0)
  })

  it('票据号格式非法 → 400 web-invalid-ticket', async () => {
    const { port, calls } = makePort()
    const result = await call(makeDeps(port), {
      ticketId: 'not a ticket',
      oldPassword: 'bank1234',
      newPassword: 'SuperSecret123',
    })
    expect(result.status).toBe(400)
    expect((result.body['error'] as { code?: string }).code).toBe('web-invalid-ticket')
    expect(calls).toHaveLength(0)
  })

  it('失败码 → 状态码是封闭映射（400/404/409/423），理由原样带回', async () => {
    const cases: readonly { readonly code: string; readonly status: number }[] = [
      { code: 'password-invalid', status: 400 },
      { code: 'password-mismatch', status: 400 },
      { code: 'password-ticket-unknown', status: 404 },
      // 他人的票据也回 404：403 会告诉探测者"这个票号存在"
      { code: 'password-ticket-foreign', status: 404 },
      { code: 'password-ticket-expired', status: 409 },
      { code: 'password-ticket-used', status: 409 },
      { code: 'password-locked', status: 423 },
    ]
    for (const item of cases) {
      const { port } = makePort(() => new BahError(item.code, '失败理由'))
      const result = await call(makeDeps(port), {
        ticketId: 'pwd:c-1',
        oldPassword: 'bank1234',
        newPassword: 'SuperSecret123',
      })
      expect(result.status, item.code).toBe(item.status)
      expect((result.body['error'] as { code?: string }).code, item.code).toBe(item.code)
      // 失败响应同样不回显密码
      expect(result.text, item.code).not.toContain('bank1234')
      expect(result.text, item.code).not.toContain('SuperSecret123')
    }
  })

  it('未登记的失败码继续上抛（由 dispatch 记 500，不伪装成 400）', async () => {
    const { port } = makePort(() => new BahError('something-unexpected', '意外'))
    await expect(
      call(makeDeps(port), {
        ticketId: 'pwd:c-1',
        oldPassword: 'bank1234',
        newPassword: 'SuperSecret123',
      }),
    ).rejects.toMatchObject({ code: 'something-unexpected' })
  })

  it('没装 bank:tools（端口缺失）→ 501，不是 500', async () => {
    const result = await call(makeDeps(undefined), {
      ticketId: 'pwd:c-1',
      oldPassword: 'bank1234',
      newPassword: 'SuperSecret123',
    })
    expect(result.status).toBe(501)
    expect((result.body['error'] as { code?: string }).code).toBe('password-handoff-unavailable')
  })
})
