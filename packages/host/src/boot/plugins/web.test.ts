/**
 * `channel:web` 宿主行：配置校验、HTTP 协议、静态目录安全、SSE 首帧、审批路由。
 *
 * 为什么这些用例值钱：前端能画得再漂亮，只要 `/api/turn` 的 400 与 `/api/approval` 的 404
 * 语义不对，界面就只能靠"猜"——而资金类产品最不能靠猜。
 */

import { createContext } from '@bah/core'
import { APPROVAL_SERVICE, ApprovalService } from '@bah/interaction'
import { AgentRegistry, provideAgents, provideSession, SESSION_SERVICE } from '@bah/runtime'
import { SENTRY_SERVICE } from '@bah/safety'
import { asSessionId } from '@bah/test-support'
import type { Agent, AnySessionEvent, LlmStreamer } from '@bah/runtime'
import type { ApprovalInputLike, ChallengePort } from '@bah/interaction'
import type { SentryHandle } from '@bah/safety'
import type { Context } from '@bah/core'
import { afterEach, describe, expect, it } from 'vitest'

import { RUN_SERVICE } from '../boot.ts'
import { ADMIN_TOKEN_ENV } from './web-admin.ts'
import { DEFAULT_WEB, WEB_SERVER, webPlugin, type WebSettings } from './web.ts'

/** 测试装置。 */
interface Harness {
  readonly ctx: Context
  readonly url: string
  readonly sent: string[]
  readonly interrupts: string[]
  /** 假 sentry 收到的解冻调用（HP0-08 用）。 */
  readonly unfreezeCalls: { by: string; reason: string }[]
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
  /**
   * 假 sentry 服务。
   * `frozen` = 初始处于冻结态（解冻应返回 true）；`idle` = 未冻结（返回 false）；
   * 缺省 = 不注册（覆盖 503「profile 没有 sentry」）。
   */
  readonly sentry?: 'frozen' | 'idle'
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

  // 假 sentry：只在被要求时注册（缺省覆盖 503 分支）
  const unfreezeCalls: { by: string; reason: string }[] = []
  let frozen = extras.sentry === 'frozen'
  if (extras.sentry !== undefined) {
    ctx.provide(SENTRY_SERVICE, {
      unfreeze: (by: string, reason?: string) => {
        unfreezeCalls.push({ by, reason: reason ?? '' })
        const was = frozen
        frozen = false
        return was
      },
      restore: () => false,
      view: () => ({
        sessionId: 's-web-test',
        turn: 0,
        toolsInTurn: 0,
        riskScore: 0,
        riskLevel: 'low',
        degraded: false,
        frozen,
      }),
    } as unknown as SentryHandle)
  }

  await ctx.use(webPlugin.plugin, settings)
  await ctx.start()

  return { ctx, url: ctx.get(WEB_SERVER).url, sent, interrupts, unfreezeCalls }
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

/**
 * 管理路由（施工单 HP-0 §3.2 的 HP0-05…11）。
 *
 * 这一组的顺序感很重要：**先"路由存不存在"，再"你是谁"，最后"你要干什么"**。
 * 把 404 放在 401 前面不是洁癖——没配 token 时连"这里有个管理口"都不该被探到。
 */
describe('channel:web 管理路由（HP-0）', () => {
  const saved = process.env[ADMIN_TOKEN_ENV]

  /** 设置/清除管理 token（用例之间必须还原，否则会串味）。 */
  const setToken = (value: string | undefined): void => {
    if (value === undefined) delete process.env[ADMIN_TOKEN_ENV]
    else process.env[ADMIN_TOKEN_ENV] = value
  }

  const post = (
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${url}api/admin/sentry/unfreeze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  afterEach(() => {
    setToken(saved)
  })

  it('HP0-05 未设 token → 404（不暴露存在性）', async () => {
    setToken(undefined)
    const harness = await boot({}, { sentry: 'frozen' })
    try {
      const response = await post(harness.url, { by: 'ops-7' })
      expect(response.status).toBe(404)
      expect(harness.unfreezeCalls).toEqual([])
    } finally {
      await shutdown(harness)
    }
  })

  it('HP0-06 缺 token / 错 token → 401，且都不触发解冻', async () => {
    setToken('correct-token-value')
    const harness = await boot({}, { sentry: 'frozen' })
    try {
      const missing = await post(harness.url, { by: 'ops-7' })
      expect(missing.status).toBe(401)

      const wrong = await post(harness.url, { by: 'ops-7' }, { authorization: 'Bearer wrong' })
      expect(wrong.status).toBe(401)

      // 同长度但不同内容：不能因为长度相等就走通
      const sameLength = await post(harness.url, { by: 'ops-7' }, {
        authorization: `Bearer ${'x'.repeat('correct-token-value'.length)}`,
      })
      expect(sameLength.status).toBe(401)

      expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
        'web-admin-unauthorized',
      )
      expect(harness.unfreezeCalls).toEqual([])
    } finally {
      await shutdown(harness)
    }
  })

  it('HP0-08 正确 token + 已冻结 → 200 unfrozen:true，by/reason 透传到服务', async () => {
    setToken('correct-token-value')
    const harness = await boot({}, { sentry: 'frozen' })
    try {
      const response = await post(
        harness.url,
        { by: 'ops-7', reason: '客服复核：误报' },
        { authorization: 'Bearer correct-token-value' },
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, unfrozen: true })
      expect(harness.unfreezeCalls).toEqual([{ by: 'ops-7', reason: '客服复核：误报' }])
    } finally {
      await shutdown(harness)
    }
  })

  it('HP0-09 正确 token + 未冻结 → 200 unfrozen:false（幂等 no-op）', async () => {
    setToken('correct-token-value')
    const harness = await boot({}, { sentry: 'idle' })
    try {
      const response = await post(
        harness.url,
        { by: 'ops-7' },
        { authorization: 'Bearer correct-token-value' },
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, unfrozen: false })
      // 未写 reason 时用缺省值，而不是空串
      expect(harness.unfreezeCalls[0]?.reason).toBe('operator-unfreeze')
    } finally {
      await shutdown(harness)
    }
  })

  it('HP0-10 缺 by / 未知键 / 坏 JSON → 400（都不是 500）', async () => {
    setToken('correct-token-value')
    const harness = await boot({}, { sentry: 'frozen' })
    const auth = { authorization: 'Bearer correct-token-value' }
    try {
      const noBy = await post(harness.url, { reason: 'x' }, auth)
      expect(noBy.status).toBe(400)
      expect(((await noBy.json()) as { error: { code: string } }).error.code).toBe(
        'web-admin-invalid-body',
      )

      const unknown = await post(harness.url, { by: 'ops-7', nope: 1 }, auth)
      expect(unknown.status).toBe(400)

      const broken = await fetch(`${harness.url}api/admin/sentry/unfreeze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: '{not json',
      })
      expect(broken.status).toBe(400)

      expect(harness.unfreezeCalls).toEqual([])
    } finally {
      await shutdown(harness)
    }
  })

  it('HP0-11 没有 sentry 服务 → 503 sentry-absent（web 仍能起）', async () => {
    setToken('correct-token-value')
    const harness = await boot({}, { agent: 'absent' })
    try {
      const response = await post(
        harness.url,
        { by: 'ops-7' },
        { authorization: 'Bearer correct-token-value' },
      )
      expect(response.status).toBe(503)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'sentry-absent',
      )
    } finally {
      await shutdown(harness)
    }
  })

  it('非 POST → 405（token 已配置时）；token 未配置时一律 404（连方法都不告诉）', async () => {
    const configured = await boot({}, { sentry: 'frozen' })
    setToken('correct-token-value')
    try {
      const response = await fetch(`${configured.url}api/admin/sentry/unfreeze`)
      expect(response.status).toBe(405)
    } finally {
      await shutdown(configured)
    }

    // 同一路径、同一方法，但宿主没配 token：必须仍是 404——
    // 否则扫描器一个 GET 就能确认"管理口存在，只是方法不对"
    setToken(undefined)
    const unconfigured = await boot({}, { sentry: 'frozen' })
    try {
      const response = await fetch(`${unconfigured.url}api/admin/sentry/unfreeze`)
      expect(response.status).toBe(404)
    } finally {
      await shutdown(unconfigured)
    }
  })
})
