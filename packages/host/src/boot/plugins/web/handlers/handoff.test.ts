/**
 * `POST /api/handoff`（进入接管）与 `/resume`（交回）的 HTTP 形状（03 TA-45）。
 *
 * 钉住两件容易被"状态机已测过"掩盖的事：
 * 1. **主体字段不接受 body 自报**：`{ operator: '冒充' }` 这类字段必须 400，
 *    且**不能触达**状态机（否则前端一改就能替别人进入接管）；
 * 2. **失败码 → HTTP 状态的映射**：交接语超长是 400（输入问题），不是 409（状态问题）。
 */

import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { normalizePrincipal, parseTenantId } from '@bah/util'

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HandoffHandle, HandoffSummary } from '../handoff.ts'
import type { WebDeps, WebRequest } from '../deps.ts'
import type { RequestIdentity } from '../auth/identity.ts'
import { handleHandoff } from './handoff.ts'

/** 客户主体（password 模式登录后的身份）。 */
const CUSTOMER: RequestIdentity = {
  kind: 'principal',
  principal: normalizePrincipal({
    tenantId: parseTenantId('demo'),
    userId: 'u-1',
    roles: ['customer'],
    source: 'session-auth',
  }),
  session: {
    sid: 'sid-1',
    tenantId: 'demo',
    userId: 'u-1',
    roles: ['customer'],
    csrf: 'csrf-1',
    issuedAt: 0,
    lastSeenAt: 0,
    absoluteExpiresAt: 1_000,
  },
}

const SUMMARY: HandoffSummary = {
  active: true,
  sessionId: 's-handoff',
  lastSeq: 12,
  turns: 4,
  pendingTickets: 0,
  messages: [],
  waitedMs: 0,
  overdue: false,
  claimed: false,
  turnsSinceHandoff: 0,
  operatorMessages: 0,
}

/** 只实现 handler 用到的 `writeHead` / `end`。 */
class FakeRes extends EventEmitter {
  statusCode = 0
  headers: Record<string, string> = {}
  body = ''

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status
    this.headers = headers
    return this
  }

  end(chunk?: string): void {
    this.body = chunk ?? ''
  }
}

/** 最小请求桩：`readJson` 靠 `for await` 读体，所以必须给出异步迭代器。 */
function reqOf(body?: unknown): IncomingMessage {
  const text = body === undefined ? '' : JSON.stringify(body)
  const chunks = text === '' ? [] : [Buffer.from(text, 'utf8')]
  return {
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

function request(method: string, path: string): WebRequest {
  return {
    method,
    url: new URL(`http://127.0.0.1${path}`),
    path,
    rest: '',
    identity: CUSTOMER,
  }
}

/** 可观察的接管桩：记录调用参数，返回按用例定制的判决。 */
function handoffStub(overrides: Partial<HandoffHandle> = {}): {
  readonly handle: HandoffHandle
  readonly calls: { method: string; args: unknown[] }[]
} {
  const calls: { method: string; args: unknown[] }[] = []
  const handle: HandoffHandle = {
    active: true,
    slaMs: 0,
    enter: (reason, requestedBy) => {
      calls.push({ method: 'enter', args: [reason, requestedBy] })
      return { ok: true, summary: SUMMARY }
    },
    resume: (operator, handover) => {
      calls.push({ method: 'resume', args: [operator, handover] })
      return { ok: true, summary: { ...SUMMARY, active: false } }
    },
    claim: () => ({ ok: true, summary: SUMMARY }),
    say: () => ({ ok: true, seq: 1 }),
    heartbeat: () => ({ waitedMs: 0, overdue: false }),
    summary: () => SUMMARY,
    ...overrides,
  }
  return { handle, calls }
}

function depsOf(handoff: HandoffHandle): WebDeps {
  return { handoff } as unknown as WebDeps
}

describe('POST /api/handoff（进入接管）', () => {
  it('TA-45-1 body 里自报 operator → 400，且状态机一次都没被调用（I1）', async () => {
    const { handle, calls } = handoffStub()
    const res = new FakeRes()
    await handleHandoff(
      reqOf({ reason: '客户要求人工', operator: '冒充的坐席' }),
      res as unknown as ServerResponse,
      request('POST', '/api/handoff'),
      depsOf(handle),
    )

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)['error'].code).toBe('web-invalid-body')
    expect(calls).toEqual([])
  })

  it('合法 body → 200，requestedBy 来自登录主体而不是 body', async () => {
    const { handle, calls } = handoffStub()
    const res = new FakeRes()
    await handleHandoff(
      reqOf({ reason: '客户要求人工' }),
      res as unknown as ServerResponse,
      request('POST', '/api/handoff'),
      depsOf(handle),
    )

    expect(res.statusCode).toBe(200)
    expect(calls).toEqual([{ method: 'enter', args: ['客户要求人工', 'u-1'] }])
  })
})

describe('POST /api/handoff/resume（交回）', () => {
  it('交接语超长 → 400 handoff-text-too-long（不是 409）', async () => {
    const { handle } = handoffStub({
      resume: () => ({ ok: false, code: 'handoff-text-too-long' }),
    })
    const res = new FakeRes()
    await handleHandoff(
      reqOf({ handover: 'x'.repeat(2_001) }),
      res as unknown as ServerResponse,
      request('POST', '/api/handoff/resume'),
      depsOf(handle),
    )

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)['error'].code).toBe('handoff-text-too-long')
  })
})
