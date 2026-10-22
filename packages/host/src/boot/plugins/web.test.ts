/**
 * `channel:web` 宿主行：配置校验、HTTP 协议、静态目录安全、SSE 首帧、审批路由。
 *
 * 为什么这些用例值钱：前端能画得再漂亮，只要 `/api/turn` 的 400 与 `/api/approval` 的 404
 * 语义不对，界面就只能靠"猜"——而资金类产品最不能靠猜。
 */

import { createContext } from '@bah/core'
import { APPROVAL_SERVICE, ApprovalService } from '@bah/interaction'
import { AgentRegistry, provideAgents, provideSession, SESSION_SERVICE } from '@bah/runtime'
import { asSessionId } from '@bah/test-support'
import type { Agent, AnySessionEvent, LlmStreamer } from '@bah/runtime'
import type { ApprovalInputLike, ChallengePort } from '@bah/interaction'
import type { Context } from '@bah/core'
import { describe, expect, it } from 'vitest'

import { RUN_SERVICE } from '../boot.ts'
import { DEFAULT_WEB, WEB_SERVER, webPlugin, type WebSettings } from './web.ts'

/** 测试装置。 */
interface Harness {
  readonly ctx: Context
  readonly url: string
  readonly sent: string[]
  readonly interrupts: string[]
}

/** 装配变体：默认全绿（有 agent、驱动常驻不返回、票据无强验证）。 */
interface BootExtras {
  /**
   * `absent` = 注册表里没有 agent（503）；
   * `drive-fails` = 常驻驱动立即失败（fault 帧）；
   * `send-fails` = 入队就抛非结构化错误（500 web-internal）。
   */
  readonly agent?: 'ok' | 'absent' | 'drive-fails' | 'send-fails'
  /** 强验证端口（红级票据）；缺省不注入 → 票据没有 challenge。 */
  readonly challenges?: ChallengePort
}

/** 起一个只装了必要服务的 ctx + 真实 HTTP 端口（`port: 0` 由内核分配）。 */
async function boot(
  overrides: Partial<WebSettings> = {},
  extras: BootExtras = {},
): Promise<Harness> {
  const ctx = createContext()
  const sessionId = asSessionId('s-web-test')
  const now = (): number => 1_700_000_000_000

  ctx.provide(RUN_SERVICE, { sessionId, now })
  provideSession(ctx, { sessionId, now })

  const sent: string[] = []
  const interrupts: string[] = []
  const agent = {
    id: 'agent-web-test',
    sessionId,
    status: 'idle',
    inbox: { pending: 0, wakeCount: 0 },
    send: (text: string) => {
      if (extras.agent === 'send-fails') throw new Error('队列写不进去')
      sent.push(text)
    },
    steer: () => undefined,
    inject: () => undefined,
    interrupt: (reason?: string) => {
      interrupts.push(reason ?? '')
    },
    run: async () => undefined,
    // 常驻驱动：正常路径永不 resolve（插件不 await 它）；变体里立即失败以覆盖 fault 分支
    drive:
      extras.agent === 'drive-fails'
        ? () => Promise.reject(new Error('驱动故障'))
        : () => new Promise<void>(() => undefined),
  } as unknown as Agent

  const registry = new AgentRegistry()
  provideAgents(ctx, registry)
  if (extras.agent !== 'absent') ctx.effect(registry.register(agent))

  ctx.provide(
    APPROVAL_SERVICE,
    new ApprovalService({
      sessionId,
      now,
      ...(extras.challenges === undefined ? {} : { challenges: extras.challenges }),
    }),
  )

  const settings = webPlugin.validate({
    port: 0,
    host: '127.0.0.1',
    staticRoot: 'apps/web',
    ...overrides,
  })
  await ctx.use(webPlugin.plugin, settings)
  await ctx.start()

  return { ctx, url: ctx.get(WEB_SERVER).url, sent, interrupts }
}

/** 关掉装置（端口必须释放，否则下一个用例会撞端口）。 */
async function shutdown(harness: Harness): Promise<void> {
  await harness.ctx.dispose('test')
}

describe('channel:web 配置', () => {
  it('缺省值可校验且端口可为 0（OS 分配）', () => {
    expect(webPlugin.validate({})).toEqual(DEFAULT_WEB)
    expect(webPlugin.validate({ port: 0 }).port).toBe(0)
  })

  it('非法端口 / 未知键 fail-loud', () => {
    expect(() => webPlugin.validate({ port: 70_000 })).toThrow(/port/)
    expect(() => webPlugin.validate({ port: -1 })).toThrow(/port/)
    expect(() => webPlugin.validate({ port: '7331' })).toThrow(/port/)
    expect(() => webPlugin.validate({ extra: true })).toThrow(/未知配置键/)
  })
})

describe('channel:web 协议', () => {
  it('/api/session 返回会话与能力位', async () => {
    const harness = await boot()
    try {
      const response = await fetch(`${harness.url}api/session`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { sessionId: string; capabilities: { richCards: boolean } }
      expect(body.sessionId).toBe('s-web-test')
      expect(body.capabilities.richCards).toBe(true)
    } finally {
      await shutdown(harness)
    }
  })

  it('/api/health 暴露在途票据', async () => {
    const harness = await boot()
    try {
      const body = (await (await fetch(`${harness.url}api/health`)).json()) as {
        ok: boolean
        pendingTickets: string[]
      }
      expect(body.ok).toBe(true)
      expect(body.pendingTickets).toEqual([])
    } finally {
      await shutdown(harness)
    }
  })

  it('/api/turn 空文本 → 400 web-empty-message', async () => {
    const harness = await boot()
    try {
      const response = await fetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('web-empty-message')
      expect(harness.sent).toEqual([])
    } finally {
      await shutdown(harness)
    }
  })

  it('/api/turn 正常文本入队并启动驱动，返回 202', async () => {
    const harness = await boot()
    try {
      const response = await fetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '给王建国转 800 元' }),
      })
      expect(response.status).toBe(202)
      expect(harness.sent).toEqual(['给王建国转 800 元'])
    } finally {
      await shutdown(harness)
    }
  })

  it('/api/interrupt 把理由交给 agent', async () => {
    const harness = await boot()
    try {
      const response = await fetch(`${harness.url}api/interrupt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '算了' }),
      })
      expect(response.status).toBe(200)
      expect(harness.interrupts).toEqual(['算了'])
    } finally {
      await shutdown(harness)
    }
  })

  it('/api/events 的 since 非法 → 400；合法 → SSE 首帧是快照', async () => {
    const harness = await boot()
    try {
      const bad = await fetch(`${harness.url}api/events?since=abc`)
      expect(bad.status).toBe(400)

      const controller = new AbortController()
      const stream = await fetch(`${harness.url}api/events?since=0`, { signal: controller.signal })
      expect(stream.headers.get('content-type')).toContain('text/event-stream')

      const reader = stream.body?.getReader()
      const first = await reader?.read()
      const text = new TextDecoder().decode(first?.value)
      expect(text).toContain('event: frame')
      expect(text).toContain('"kind":"snapshot"')
      controller.abort()
    } finally {
      await shutdown(harness)
    }
  })

  it('/api/approval/:id 未知票据 → 404；非法 ID → 400', async () => {
    const harness = await boot()
    try {
      const missing = await fetch(`${harness.url}api/approval/ticket%3Aghost`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allowed-once' }),
      })
      expect(missing.status).toBe(404)

      const invalid = await fetch(`${harness.url}api/approval/${encodeURIComponent('bad id!')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allowed-once' }),
      })
      expect(invalid.status).toBe(400)
    } finally {
      await shutdown(harness)
    }
  })

  it('/api/verify/:id 未知票据 → 404；非法 ID → 400', async () => {
    const harness = await boot()
    try {
      const response = await fetch(`${harness.url}api/verify/ticket%3Aghost`, { method: 'POST' })
      expect(response.status).toBe(404)

      // 票据 ID 会进日志与查询键：非法字符必须在触达适配器之前挡掉
      const invalid = await fetch(
        `${harness.url}api/verify/${encodeURIComponent('bad id!')}`,
        { method: 'POST' },
      )
      expect(invalid.status).toBe(400)
      expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe(
        'web-invalid-ticket',
      )
    } finally {
      await shutdown(harness)
    }
  })
})

describe('channel:web 静态资源安全', () => {
  it('目录穿越返回 404（不返回 403，免得被探测）', async () => {
    const harness = await boot()
    try {
      const response = await fetch(`${harness.url}..%2f..%2fpackage.json`)
      expect(response.status).toBe(404)
    } finally {
      await shutdown(harness)
    }
  })

  it('不存在的资源 404，index 存在时返回 html', async () => {
    const harness = await boot()
    try {
      const missing = await fetch(`${harness.url}nope.html`)
      expect(missing.status).toBe(404)

      const index = await fetch(harness.url)
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('text/html')
    } finally {
      await shutdown(harness)
    }
  })

  it('方法不支持 → 405', async () => {
    const harness = await boot()
    try {
      const response = await fetch(`${harness.url}api/session`, { method: 'DELETE' })
      expect(response.status).toBe(405)
    } finally {
      await shutdown(harness)
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 协议边界与实时链路（覆盖门禁要求 boot/ 目录逐文件 100%）
 *
 * 这些用例不只是"凑覆盖"：HTTP 面上每一个 4xx/5xx 都是前端唯一能拿到的解释，
 * 一个 500 会把用户的输入错误报成"服务器故障"；SSE 断了却不收尾会把连接一直挂着。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 从 SSE 流里读到出现 `needle` 为止（返回本次新增的文本）。 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  needle: string,
): Promise<string> {
  let seen = ''
  for (let guard = 0; guard < 64; guard += 1) {
    const { value, done } = await reader.read()
    if (done) break
    seen += decoder.decode(value, { stream: true })
    if (seen.includes(needle)) return seen
  }
  return seen
}

/** 红级票据的强验证端口（签发即通过）。 */
const passingChallenge: ChallengePort = {
  issue: (channel) => ({ ok: true, challengeId: `chal-${channel}` }),
  verify: async () => ({ ok: true }),
  passed: () => true,
}

/** 造一条待裁决的审批输入（形状与管线桥接的 `ApprovalInput` 一致）。 */
function approvalInput(ticketId: string): ApprovalInputLike {
  return {
    ticket: { ticketId, fingerprint: 'fp-web', amount: 800, expiresAt: 1_700_000_000_000 + 60_000 },
    callId: `call-${ticketId}`,
    name: 'transfer_create',
    summary: { title: '执行 transfer_create', amount: 800, tier: 'red' },
    challenge: 'sms',
    decision: { decision: 'unavailable' },
  }
}

describe('channel:web 请求边界', () => {
  it('请求体过大 → 413；非对象 / 坏 JSON → 400（都不许报成 500）', async () => {
    const harness = await boot()
    try {
      const tooLarge = await fetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(66 * 1024) }),
      })
      expect(tooLarge.status).toBe(413)
      expect(((await tooLarge.json()) as { error: { code: string } }).error.code).toBe(
        'web-body-too-large',
      )

      const notObject = await fetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[]',
      })
      expect(notObject.status).toBe(400)
      expect(((await notObject.json()) as { error: { code: string } }).error.code).toBe(
        'web-invalid-body',
      )

      const broken = await fetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      })
      expect(broken.status).toBe(400)
      expect(((await broken.json()) as { error: { code: string } }).error.code).toBe(
        'web-invalid-json',
      )

      // 单个坏请求不能拖垮服务
      expect((await fetch(`${harness.url}api/health`)).status).toBe(200)
    } finally {
      await shutdown(harness)
    }
  })

  it('没有活体 agent 时 /api/turn 与 /api/interrupt 都是 503', async () => {
    const harness = await boot({}, { agent: 'absent' })
    try {
      const turn = await fetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      })
      expect(turn.status).toBe(503)
      expect(((await turn.json()) as { error: { code: string } }).error.code).toBe('agent-absent')

      const interrupt = await fetch(`${harness.url}api/interrupt`, { method: 'POST' })
      expect(interrupt.status).toBe(503)
      expect(((await interrupt.json()) as { error: { code: string } }).error.code).toBe(
        'agent-absent',
      )
      expect(harness.sent).toEqual([])
    } finally {
      await shutdown(harness)
    }
  })

  it('端口被占 → web-listen-failed（不自动换端口，否则浏览器连的是"另一个服务"）', async () => {
    const first = await boot()
    try {
      const port = Number(new URL(first.url).port)
      await expect(boot({ port })).rejects.toMatchObject({ code: 'web-listen-failed' })
    } finally {
      await shutdown(first)
    }
  })

  it('未归类的内部错误 → 500 web-internal（不许伪造成 4xx 让前端以为是用户的错）', async () => {
    const harness = await boot({}, { agent: 'send-fails' })
    try {
      const response = await fetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      })
      expect(response.status).toBe(500)
      const body = (await response.json()) as { error: { code: string; reason: string } }
      expect(body.error.code).toBe('web-internal')
      expect(body.error.reason).toContain('队列写不进去')
    } finally {
      await shutdown(harness)
    }
  })
})

describe('channel:web 实时链路', () => {
  it('会话事件推 frame，llm/stream 文本分片推 delta，心跳是注释行', async () => {
    const harness = await boot({ heartbeatMs: 1 })
    const controller = new AbortController()
    try {
      const stream = await fetch(`${harness.url}api/events?since=0`, { signal: controller.signal })
      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      expect(await readUntil(reader, decoder, '"kind":"snapshot"')).toContain('"kind":"snapshot"')

      // ① 会话事件 → frame（SSE 是唯一实时数据源）
      harness.ctx.events.emit('session/event', {
        session: harness.ctx.get(SESSION_SERVICE).sessionId,
        event: {
          seq: 1,
          at: 1,
          formatVersion: 1,
          type: 'turn/start',
          data: { turn: 1 },
        } as unknown as AnySessionEvent,
      })
      expect(await readUntil(reader, decoder, 'event: frame')).toContain('event: frame')

      // ② 流式分片 → ephemeral delta（不占 seq、不落账）
      const streamer: LlmStreamer = async function* () {
        yield { kind: 'text-delta', index: 0, text: '你' }
        yield { kind: 'text-delta', index: 0, text: '好' }
      }
      const tapped = await harness.ctx.events.waterfall('llm/stream', streamer)
      for await (const chunk of tapped({} as never, new AbortController().signal)) void chunk
      expect(await readUntil(reader, decoder, '"kind":"delta"')).toContain('"kind":"delta"')

      // ③ 心跳是不带 event: 的注释行，前端 EventSource 不会当事件派发
      expect(await readUntil(reader, decoder, ': ping')).toContain(': ping')
    } finally {
      controller.abort()
      await shutdown(harness)
    }
  })

  it('常驻驱动失败 → fault 帧（独立事件名，不与 EventSource 内置 error 冲突）', async () => {
    const harness = await boot({}, { agent: 'drive-fails' })
    const controller = new AbortController()
    try {
      const stream = await fetch(`${harness.url}api/events?since=0`, { signal: controller.signal })
      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      await readUntil(reader, decoder, '"kind":"snapshot"')

      const response = await fetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      })
      expect(response.status).toBe(202)

      const fault = await readUntil(reader, decoder, 'event: fault')
      expect(fault).toContain('agent-driver-failed')
      expect(fault).toContain('驱动故障')
    } finally {
      controller.abort()
      await shutdown(harness)
    }
  })

  it('SSE 建立后投影失败：已发出的头不重写，只结束连接', async () => {
    const harness = await boot()
    const session = harness.ctx.get(SESSION_SERVICE)
    try {
      // 头已经发出（200 + : connected）之后才失败：再写一次头会抛 ERR_HTTP_HEADERS_SENT
      Object.defineProperty(session, 'sessionId', {
        configurable: true,
        get: () => {
          throw new Error('投影故障')
        },
      })
      const response = await fetch(`${harness.url}api/events?since=0`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(': connected')
    } finally {
      await shutdown(harness)
    }
  })

  it('审批全链路：在途票据可见 → 验票 200 → HTTP 下结论 200 并结算仲裁', async () => {
    const harness = await boot({}, { challenges: passingChallenge })
    const approval = harness.ctx.get(APPROVAL_SERVICE)
    const ticketId = 'ticket:web-1'
    try {
      const settled = approval.handle(approvalInput(ticketId), async (value) => value)
      // 让 handle 走过 `await next()` 并完成 attach（宏任务屏障，不赌微任务顺序）
      await new Promise((resolve) => {
        setImmediate(resolve)
      })

      const health = (await (await fetch(`${harness.url}api/health`)).json()) as {
        pendingTickets: string[]
      }
      expect(health.pendingTickets).toEqual([ticketId])

      const verify = await fetch(`${harness.url}api/verify/${encodeURIComponent(ticketId)}`, {
        method: 'POST',
      })
      expect(verify.status).toBe(200)

      const decide = await fetch(`${harness.url}api/approval/${encodeURIComponent(ticketId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allowed-once' }),
      })
      expect(decide.status).toBe(200)

      expect((await settled).decision.decision).toBe('allowed-once')
    } finally {
      await shutdown(harness)
    }
  })
})
