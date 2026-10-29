/**
 * 坐席动作四条路由（`handlers/handoff-message.ts`）。
 *
 * 钉住三件容易被"状态机已测过"掩盖的事：
 * 1. **身份来自部署配置**：body 里写别人的 `operator` 不生效（I1）；
 * 2. **错误码 → HTTP 状态的映射**：未接管 409、空发言 400、超长 413——
 *    前端工作台按状态码分支，映射错了就是把"输入问题"报成"服务器故障"；
 * 3. **队列载荷的形状**：未接管时 `items` 必须为空数组（不是 null），
 *    接管中 `reason` 缺省显式 null（前端不做 undefined 判断）。
 */

import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HandoffHandle, HandoffSummary } from '../handoff.ts'
import type { WebDeps, WebRequest } from '../deps.ts'
import {
  handleHandoffClaim,
  handleHandoffHeartbeat,
  handleHandoffMessage,
  handleHandoffQueue,
} from './handoff-message.ts'

const OPERATOR = '坐席小周'

const SUMMARY: HandoffSummary = {
  active: true,
  sessionId: 's-handoff',
  lastSeq: 12,
  turns: 4,
  pendingTickets: 1,
  messages: [{ role: 'user', text: '为什么还没到账？' }],
  waitedMs: 90_000,
  overdue: false,
  claimed: true,
  turnsSinceHandoff: 0,
  operatorMessages: 0,
}

const IDLE: HandoffSummary = {
  ...SUMMARY,
  active: false,
  claimed: false,
  messages: [],
  waitedMs: 0,
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
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const chunks = text === '' ? [] : [Buffer.from(text, 'utf8')]
  return {
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

function request(method: string, path: string): WebRequest {
  return { method, url: new URL(`http://127.0.0.1${path}`), path, rest: '' }
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
    enter: (reason) => {
      calls.push({ method: 'enter', args: [reason] })
      return { ok: true, summary: SUMMARY }
    },
    resume: (operator, handover) => {
      calls.push({ method: 'resume', args: [operator, handover] })
      return { ok: true, summary: IDLE }
    },
    claim: (operator) => {
      calls.push({ method: 'claim', args: [operator] })
      return { ok: true, summary: SUMMARY }
    },
    say: (operator, text) => {
      calls.push({ method: 'say', args: [operator, text] })
      return { ok: true, seq: 31 }
    },
    heartbeat: () => {
      calls.push({ method: 'heartbeat', args: [] })
      return { waitedMs: 90_000, overdue: true }
    },
    summary: () => SUMMARY,
    ...overrides,
  }
  return { handle, calls }
}

function depsOf(handoff: HandoffHandle): WebDeps {
  return { handoff, operatorName: OPERATOR } as unknown as WebDeps
}

describe('POST /api/handoff/claim', () => {
  it('成功：200 + 摘要，且认领名来自配置而不是 body', async () => {
    const { handle, calls } = handoffStub()
    const res = new FakeRes()
    await handleHandoffClaim(
      reqOf({ operator: '冒充的坐席' }),
      res as unknown as ServerResponse,
      request('POST', '/api/handoff/claim'),
      depsOf(handle),
    )

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ active: true, claimed: true })
    expect(calls).toEqual([{ method: 'claim', args: [OPERATOR] }])
  })

  it('未接管 → 409 handoff-not-active；被别人认领 → 409 handoff-claimed-by-other', async () => {
    const notActive = handoffStub({ claim: () => ({ ok: false, code: 'handoff-not-active' }) })
    const res1 = new FakeRes()
    await handleHandoffClaim(
      reqOf(),
      res1 as unknown as ServerResponse,
      request('POST', '/api/handoff/claim'),
      depsOf(notActive.handle),
    )
    expect(res1.statusCode).toBe(409)
    expect(JSON.parse(res1.body)['error'].code).toBe('handoff-not-active')

    const other = handoffStub({ claim: () => ({ ok: false, code: 'handoff-claimed-by-other' }) })
    const res2 = new FakeRes()
    await handleHandoffClaim(
      reqOf(),
      res2 as unknown as ServerResponse,
      request('POST', '/api/handoff/claim'),
      depsOf(other.handle),
    )
    expect(res2.statusCode).toBe(409)
    expect(JSON.parse(res2.body)['error'].code).toBe('handoff-claimed-by-other')
  })
})

describe('POST /api/handoff/message', () => {
  it('成功：200 {ok, seq}；发言名同样取配置', async () => {
    const { handle, calls } = handoffStub()
    const res = new FakeRes()
    await handleHandoffMessage(
      reqOf({ text: '您好，我是人工坐席' }),
      res as unknown as ServerResponse,
      request('POST', '/api/handoff/message'),
      depsOf(handle),
    )

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, seq: 31 })
    expect(calls).toEqual([{ method: 'say', args: [OPERATOR, '您好，我是人工坐席'] }])
  })

  it('坏 JSON → 400 web-invalid-body（不讲成 409）', async () => {
    const { handle } = handoffStub()
    const res = new FakeRes()
    await handleHandoffMessage(
      reqOf('{oops'),
      res as unknown as ServerResponse,
      request('POST', '/api/handoff/message'),
      depsOf(handle),
    )

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)['error'].code).toBe('web-invalid-body')
  })

  it('缺 text / 空字符串 → 400 handoff-text-empty（缺字段按空串交给状态机）', async () => {
    for (const body of [{}, { text: '   ' }]) {
      const said: string[] = []
      const { handle } = handoffStub({
        say: (_operator, text) => {
          said.push(text)
          return { ok: false, code: 'handoff-text-empty' }
        },
      })
      const res = new FakeRes()
      await handleHandoffMessage(
        reqOf(body),
        res as unknown as ServerResponse,
        request('POST', '/api/handoff/message'),
        depsOf(handle),
      )
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)['error'].code).toBe('handoff-text-empty')
      // 缺字段时也走 `say('')`：空发言的拒绝口径只在一个地方
      expect(said).toEqual([typeof body.text === 'string' ? body.text : ''])
    }
  })

  it('未接管 → 409，超长 → 413（状态码按失败码分档）', async () => {
    const notActive = handoffStub({ say: () => ({ ok: false, code: 'handoff-not-active' }) })
    const res1 = new FakeRes()
    await handleHandoffMessage(
      reqOf({ text: '在吗' }),
      res1 as unknown as ServerResponse,
      request('POST', '/api/handoff/message'),
      depsOf(notActive.handle),
    )
    expect(res1.statusCode).toBe(409)
    expect(JSON.parse(res1.body)['error'].code).toBe('handoff-not-active')

    const tooLong = handoffStub({ say: () => ({ ok: false, code: 'handoff-text-too-long' }) })
    const res2 = new FakeRes()
    await handleHandoffMessage(
      reqOf({ text: 'x'.repeat(2001) }),
      res2 as unknown as ServerResponse,
      request('POST', '/api/handoff/message'),
      depsOf(tooLong.handle),
    )
    expect(res2.statusCode).toBe(413)
    expect(JSON.parse(res2.body)['error'].code).toBe('handoff-text-too-long')
  })
})

describe('POST /api/handoff/heartbeat', () => {
  it('200 + 服务端权威的 waitedMs / overdue', async () => {
    const { handle, calls } = handoffStub()
    const res = new FakeRes()
    await handleHandoffHeartbeat(
      reqOf(),
      res as unknown as ServerResponse,
      request('POST', '/api/handoff/heartbeat'),
      depsOf(handle),
    )

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, waitedMs: 90_000, overdue: true })
    expect(calls[0]?.method).toBe('heartbeat')
  })
})

describe('GET /api/handoff/queue', () => {
  it('接管中：depth 1，reason 缺省显式 null', async () => {
    const { handle } = handoffStub()
    const res = new FakeRes()
    await handleHandoffQueue(
      reqOf(),
      res as unknown as ServerResponse,
      request('GET', '/api/handoff/queue'),
      depsOf(handle),
    )

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as {
      depth: number
      items: { sessionId: string; reason: string | null }[]
      note: string
    }
    expect(body.depth).toBe(1)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ sessionId: 's-handoff', reason: null })
    expect(body.note).toBe('single-session deployment: depth ∈ {0,1}')
  })

  it('未接管：depth 0 且 items 是空数组（不是 null）', async () => {
    const { handle } = handoffStub({ summary: () => IDLE })
    const res = new FakeRes()
    await handleHandoffQueue(
      reqOf(),
      res as unknown as ServerResponse,
      request('GET', '/api/handoff/queue'),
      depsOf(handle),
    )

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ depth: 0, items: [] })
  })
})
