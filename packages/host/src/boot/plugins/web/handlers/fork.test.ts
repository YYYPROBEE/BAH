/**
 * `POST /api/session/fork`（§3.5 / TC-XSC-19/20/24）。
 *
 * 用**真的** `forkSession`（`runtime/src/agent-loop/rollback.ts`）跑分叉：
 * 这样"边界 turn 未结束即 409""旧会话逐字节不变"两条断言证明的是生产代码，
 * 不是本文件里又写一遍的分叉逻辑。
 */

import { describe, expect, it } from 'vitest'

import { createContext } from '@bah/core'
import { forkSession, SessionStore, SESSION_SERVICE, provideSession } from '@bah/runtime'
import type { Agent, AnySessionEvent, ForkRequest, SessionApi } from '@bah/runtime'
import { BahError } from '@bah/util'

import { clearForks, handleFork } from './fork.ts'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebDeps } from '../deps.ts'

function event(seq: number, type: string, data: unknown): AnySessionEvent {
  return { seq, at: 1_000 + seq, formatVersion: 1, type, data } as AnySessionEvent
}

/** 两轮完整对话（第 1、2 轮都有 turn/end）。 */
function twoTurns(): AnySessionEvent[] {
  return [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { content: '查余额' }),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(4, 'turn/start', { turn: 2 }),
    event(5, 'user/message', { content: '转 800' }),
    event(6, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
}

interface Harness {
  readonly deps: WebDeps
  readonly events: () => readonly AnySessionEvent[]
  setHandoffActive: (active: boolean) => void
  setAgent: (agent: Agent | undefined) => void
}

function harness(options: { events?: AnySessionEvent[] } = {}): Harness {
  const seed = options.events ?? twoTurns()
  const store = new SessionStore({ now: () => 1_000 })
  store.restore([...seed])
  const ctx = createContext()
  provideSession(ctx, { sessionId: 's-parent' as never, store, now: () => 1_000 })
  const session = ctx.get(SESSION_SERVICE)

  let handoffActive = false
  let agent: Agent | undefined = fakeAgent(session)

  const deps = {
    session,
    handoff: { summary: () => ({ active: handoffActive }) },
    firstAgent: () => agent,
    now: () => 1_000,
  } as unknown as WebDeps

  return {
    deps,
    events: () => session.events(),
    setHandoffActive: (active) => {
      handoffActive = active
    },
    setAgent: (next) => {
      agent = next
    },
  }
}

/** 假 agent：`fork` 走真的 `forkSession`，其余成员只保留形状。 */
function fakeAgent(session: SessionApi): Agent {
  return {
    id: 'agent-1',
    sessionId: session.sessionId,
    status: 'idle',
    fork(request: ForkRequest): Agent {
      const forked = forkSession(session, request)
      return {
        ...fakeAgent(forked.session),
        sessionId: forked.session.sessionId,
        forkInfo: {
          parentSession: forked.parentSession,
          seedLength: forked.seedLength,
          turn: forked.turn,
        },
        dispose: () => undefined,
      } as Agent
    },
  } as unknown as Agent
}

/** 最小请求/响应夹具：只覆盖 `handleFork` 用到的面。 */
function exchange(body: unknown): {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly reply: () => { status: number; body: Record<string, unknown> }
} {
  const chunks = [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    headers: { 'content-type': 'application/json' },
  } as unknown as IncomingMessage

  let status = 0
  let payload = ''
  const res = {
    statusCode: 0,
    setHeader() {
      return undefined
    },
    writeHead(code: number) {
      status = code
      return res
    },
    end(text?: string) {
      payload = text ?? ''
      return res
    },
  } as unknown as ServerResponse

  return {
    req,
    res,
    reply: () => ({ status, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }),
  }
}

describe('POST /api/session/fork', () => {
  it('TC-XSC-19 200：返回形状 {sessionId,parentSession,seedLength,turn,forkOf}，parentSession=旧会话', async () => {
    clearForks()
    const h = harness()
    const call = exchange({ turn: 1 })
    await handleFork(call.req, call.res, {} as never, h.deps)

    const { status, body } = call.reply()
    expect(status).toBe(200)
    expect(body['parentSession']).toBe('s-parent')
    expect(body['forkOf']).toBe('s-parent')
    expect(body['turn']).toBe(1)
    // 第 1 轮 turn/end 的 seq 是 3 ⇒ 前缀 3 条
    expect(body['seedLength']).toBe(3)
    expect(String(body['sessionId'])).toContain('s-fork-s-parent-1-')
    expect(String(body['note'])).toContain('原会话保留可查')
    // 同一父会话 + 同一 turn 再分叉一次：确定性 id 递增（不撞号、不覆盖前一卷）
    const again = exchange({ turn: 1 })
    await handleFork(again.req, again.res, {} as never, h.deps)
    const second = again.reply()
    expect(second.status).toBe(200)
    expect(String(second.body['sessionId'])).not.toBe(String(body['sessionId']))
    expect(String(second.body['sessionId'])).toContain('s-fork-s-parent-1-2')

    // 登记表可清：clearForks 会 dispose 分叉出来的 agent（进程内资源不泄漏）
    expect(() => { clearForks() }).not.toThrow()
  })

  it('TC-XSC-20 旧会话逐字节不变；新会话前缀与旧会话前缀全等', async () => {
    clearForks()
    const h = harness()
    const before = JSON.stringify(h.events())

    const call = exchange({ turn: 2 })
    await handleFork(call.req, call.res, {} as never, h.deps)
    expect(call.reply().status).toBe(200)

    expect(JSON.stringify(h.events())).toBe(before)
    expect(h.events()).toHaveLength(6)
  })

  it('TC-XSC-24 接管期 409 fork-during-handoff', async () => {
    clearForks()
    const h = harness()
    h.setHandoffActive(true)
    const call = exchange({ turn: 1 })
    await handleFork(call.req, call.res, {} as never, h.deps)
    expect(call.reply()).toMatchObject({ status: 409, body: { error: { code: 'fork-during-handoff' } } })
  })

  it('400：turn 非整数/非正数；404：无活动会话', async () => {
    clearForks()
    for (const turn of [0, -1, 1.5, 'one', undefined]) {
      const h = harness()
      const call = exchange({ turn })
      await handleFork(call.req, call.res, {} as never, h.deps)
      expect(call.reply()).toMatchObject({ status: 400, body: { error: { code: 'fork-invalid-request' } } })
    }

    const h = harness()
    h.setAgent(undefined)
    const call = exchange({ turn: 1 })
    await handleFork(call.req, call.res, {} as never, h.deps)
    expect(call.reply()).toMatchObject({ status: 404, body: { error: { code: 'fork-no-session' } } })
  })

  it('409：边界 turn 未完整结束（in-flight turn 天然落这条）', async () => {
    clearForks()
    const h = harness({
      events: [
        event(1, 'turn/start', { turn: 1 }),
        event(2, 'user/message', { content: '还在跑' }),
      ],
    })
    const call = exchange({ turn: 1 })
    await handleFork(call.req, call.res, {} as never, h.deps)
    expect(call.reply()).toMatchObject({ status: 409, body: { error: { code: 'fork-turn-missing' } } })
  })

  it('400：请求体不是 JSON 对象（web-invalid-body）', async () => {
    clearForks()
    const h = harness()
    const call = exchange('not-an-object')
    await handleFork(call.req, call.res, {} as never, h.deps)
    expect(call.reply()).toMatchObject({ status: 400, body: { error: { code: 'web-invalid-body' } } })
  })

  it('非 BahError 的失败 ⇒ fork-failed 上抛（由分派层归一化，不在这里吞）', async () => {
    clearForks()
    const h = harness()
    h.setAgent({
      fork() {
        throw new Error('boom')
      },
    } as unknown as Agent)
    const call = exchange({ turn: 1 })
    await expect(handleFork(call.req, call.res, {} as never, h.deps)).rejects.toMatchObject({
      code: 'fork-failed',
    })
  })

  it('500：原日志断代（session-seq-gap）透传，不静默重试', async () => {
    clearForks()
    const h = harness()
    h.setAgent({
      fork() {
        throw new BahError('session-seq-gap', '断代')
      },
    } as unknown as Agent)
    const call = exchange({ turn: 1 })
    await handleFork(call.req, call.res, {} as never, h.deps)
    expect(call.reply()).toMatchObject({ status: 500, body: { error: { code: 'session-seq-gap' } } })
  })
})
