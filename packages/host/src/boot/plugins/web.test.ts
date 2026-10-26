/**
 * `channel:web` 宿主行：配置校验、HTTP 协议、静态目录安全、SSE 首帧、审批路由。
 *
 * 为什么这些用例值钱：前端能画得再漂亮，只要 `/api/turn` 的 400 与 `/api/approval` 的 404
 * 语义不对，界面就只能靠"猜"——而资金类产品最不能靠猜。
 */

import { createContext, type TicketId } from '@bah/core'
import { APPROVAL_SERVICE, ApprovalService } from '@bah/interaction'
import { AgentRegistry, provideAgents, provideSession, SESSION_SERVICE } from '@bah/runtime'
import { HALT_SERVICE, HaltState, SENTRY_SERVICE } from '@bah/safety'
import { asSessionId } from '@bah/test-support'
import { BahError } from '@bah/util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Agent, AnySessionEvent, LlmStreamer } from '@bah/runtime'
import type { ApprovalInputLike, ChallengePort } from '@bah/interaction'
import type { SentryHandle } from '@bah/safety'
import type { Context } from '@bah/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RUN_SERVICE } from '../boot.ts'
import { ADMIN_TOKEN_ENV } from './web-admin.ts'
import { WEB_TOKEN_ENV } from './web-auth.ts'
import { DEFAULT_WEB, WEB_SERVER, webPlugin, type WebSettings } from './web.ts'

/* ────────────────────────────────────────────────────────────────────────────
 * 测试侧的透明接缝：捕获 channel:web 的请求监听器（供非回环 403 用例注入假 socket）
 *
 * 为什么需要它：`handle` 藏在 apply() 的闭包里，生产出口只有 HTTP 端口；而真实
 * 回环连接的对端 `remoteAddress` 永远是 127.x / ::1，"非回环 → 403" 这道防线用
 * 正常 fetch 不可达。这里的 vi.mock 只做**透传登记**：把监听器记进 requestListeners，
 * 之后仍交给真 createServer 建服与监听——既有真实 HTTP / SSE 用例的行为一字不动，
 * 也不改任何生产代码。
 * ──────────────────────────────────────────────────────────────────────────── */
type WebRequestListener = (req: IncomingMessage, res: ServerResponse) => void

const { requestListeners } = vi.hoisted(() => ({
  requestListeners: [] as WebRequestListener[],
}))

vi.mock('node:http', async (importActual) => {
  const actual = await importActual<typeof import('node:http')>()
  return {
    ...actual,
    createServer: (...args: unknown[]) => {
      const listener = args.find((arg) => typeof arg === 'function')
      if (listener !== undefined) requestListeners.push(listener as WebRequestListener)
      return (actual.createServer as (...rest: unknown[]) => unknown)(...args)
    },
  }
})

/** 测试固定的 Web token（生产未配置时是每进程随机生成）。 */
const WEB_TOKEN = 'web-test-token'

/** 测试装置。 */
interface Harness {
  readonly ctx: Context
  readonly url: string
  readonly sent: string[]
  readonly interrupts: string[]
  /** 假 sentry 收到的解冻调用（HP0-08 用）。 */
  readonly unfreezeCalls: { by: string; reason: string }[]
  /** boot 前的环境值（shutdown 时还原，避免串味）。 */
  readonly previousToken: string | undefined
  /** 本次 boot 捕获到的请求监听器：唯一能注入假 socket / 假 remoteAddress 的入口。 */
  readonly requestListener: WebRequestListener
  /** 假 HALT 状态机（缺省不注册，覆盖 503「没有 safety:sentry」）。 */
  readonly halt: HaltState | undefined
}

/** 装配变体：默认全绿（有 agent、驱动常驻不返回、票据无强验证）。 */
interface BootExtras {
  /**
   * `absent` = 注册表里没有 agent（503）；
   * `drive-fails` = 常驻驱动立即失败（fault 帧）；
   * `send-fails` = 入队就抛非结构化错误（500 web-internal）；
   * `halted` = 入队抛 `safety-halted`（HALT 期间的新 turn → 423）。
   */
  readonly agent?: 'ok' | 'absent' | 'drive-fails' | 'send-fails' | 'halted'
  /**
   * 假 HALT 服务：
   * - `running` = RUNNING，且有 MFA 票据端口（可申请解除票据）；
   * - `halted` = 初始 HALTED；
   * - `rejected` = 有端口但审批被拒（`requestUnfreeze` 返回 undefined）；
   * - `no-port` = 初始 HALTED 但没有票据端口（503 `halt-approval-absent`）；
   * - `disabled` = `halt.enabled=false`（503 `halt-disabled`）；
   * - `absent` = 不注册（路由 503）。
   */
  readonly halt?: 'running' | 'halted' | 'rejected' | 'no-port' | 'disabled' | 'absent'
  /** 强验证端口（红级票据）；缺省不注入 → 票据没有 challenge。 */
  readonly challenges?: ChallengePort
  /**
   * 审批服务的会话 ID（缺省 = 与 Web 渠道同一个 `s-web-test`）。
   *
   * 传另一个值即可模拟"有效 token + 他人会话的票据"（TC-W04-02）：
   * 审批视图会带别的 sessionId，Web 渠道必须 403。
   */
  readonly approvalSession?: string
  /**
   * 假 sentry 服务。
   * `frozen` = 初始处于冻结态（解冻应返回 true）；`idle` = 未冻结（返回 false）；
   * 缺省 = 不注册（覆盖 503「profile 没有 sentry」）。
   */
  readonly sentry?: 'frozen' | 'idle'
  /**
   * 在 Web 插件**之前**注册一个"边收边写"的 `session/event` 监听器。
   *
   * 复刻 `safety:sentry` 的 `trace.sink='session'`：收到 `tool/call` 就 `appendDomain`
   * 一条 `sentry/trace`。注册顺序是关键——只有排在 Web 投影器**前面**的写者，
   * 才能把 seq=N+1 抢在 seq=N 之前送给投影器（TC-W18-02 的缺陷现场）。
   */
  readonly traceWriter?: boolean
}

/** 起一个只装了必要服务的 ctx + 真实 HTTP 端口（`port: 0` 由内核分配）。 */
async function boot(
  overrides: Partial<WebSettings> = {},
  extras: BootExtras = {},
): Promise<Harness> {
  const ctx = createContext()
  const sessionId = asSessionId('s-web-test')
  const now = (): number => 1_700_000_000_000
  const previousToken = process.env[WEB_TOKEN_ENV]
  process.env[WEB_TOKEN_ENV] = WEB_TOKEN

  ctx.provide(RUN_SERVICE, { sessionId, now })
  provideSession(ctx, { sessionId, now })

  // 边收边写的监听器（必须在 Web 插件之前注册，见 BootExtras.traceWriter）
  if (extras.traceWriter === true) {
    const traceSession = ctx.get(SESSION_SERVICE)
    ctx.effect(
      ctx.events.on('session/event', ({ event }) => {
        if (event.type === 'tool/call') {
          traceSession.appendDomain('sentry/trace', { kind: 'tool-call' }, { ignorable: true })
        }
      }),
    )
  }

  const sent: string[] = []
  const interrupts: string[] = []
  const agent = {
    id: 'agent-web-test',
    sessionId,
    status: 'idle',
    inbox: { pending: 0, wakeCount: 0 },
    send: (text: string) => {
      if (extras.agent === 'send-fails') throw new Error('队列写不进去')
      if (extras.agent === 'halted') throw new BahError('safety-halted', '系统已 HALT')
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
      sessionId: asSessionId(extras.approvalSession ?? String(sessionId)),
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

  // 假 HALT（W07 管理面 / 423 用例用）
  let halt: HaltState | undefined
  if (extras.halt !== 'absent') {
    const ticket = {
      ticketId: 't-web-unfreeze',
      status: 'approved' as const,
      expiresAt: now() + 60_000,
      mfa: true,
    }
    const disabled = extras.halt === 'disabled'
    halt = new HaltState({
      now,
      recordHalt: () => undefined,
      enabled: !disabled,
      ...(extras.halt === 'no-port' || disabled
        ? {}
        : extras.halt === 'rejected'
          ? { requestTicket: () => Promise.resolve(undefined) }
          : { requestTicket: () => Promise.resolve(ticket) }),
    })
    if (extras.halt === 'halted' || extras.halt === 'rejected' || extras.halt === 'no-port') {
      halt.halt('manual')
    }
    ctx.provide(HALT_SERVICE, halt)
  }

  // 本次 boot 的监听器登记位置（boot 抛错就走不到返回，数组只增不错位）
  const listenerMark = requestListeners.length
  await ctx.use(webPlugin.plugin, settings)
  await ctx.start()

  const requestListener = requestListeners[listenerMark]
  if (requestListener === undefined) {
    throw new Error('web.test: 未捕获到 channel:web 的请求监听器')
  }

  return {
    ctx,
    url: ctx.get(WEB_SERVER).url,
    sent,
    interrupts,
    unfreezeCalls,
    previousToken,
    requestListener,
    halt,
  }
}

/** 关掉装置（端口必须释放，否则下一个用例会撞端口）。 */
async function shutdown(harness: Harness): Promise<void> {
  await harness.ctx.dispose('test')
  if (harness.previousToken === undefined) delete process.env[WEB_TOKEN_ENV]
  else process.env[WEB_TOKEN_ENV] = harness.previousToken
}

/**
 * 带 Web 凭证的 fetch。
 *
 * 用例显式给了 `Authorization` 时不覆盖（管理路由用自己的 token）。
 * 想验证"没凭证"的用例直接用原生 `fetch`。
 */
const nativeFetch = globalThis.fetch.bind(globalThis)

function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${WEB_TOKEN}`)
  // W09：同源 Origin 是 CSRF 的放行路径；跨站/缺失的用例显式覆盖请求头。
  if (!headers.has('origin')) headers.set('origin', new URL(url).origin)
  return nativeFetch(url, { ...init, headers })
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

  it('W09 CSRF 配置：默认开启；非法类型 / 未知键 fail-loud', () => {
    expect(DEFAULT_WEB.csrf).toEqual({ enabled: true })
    expect(webPlugin.validate({ csrf: { enabled: false } }).csrf).toEqual({ enabled: false })
    expect(() => webPlugin.validate({ csrf: { enabled: 'yes' } })).toThrow(/enabled/)
    expect(() => webPlugin.validate({ csrf: { nope: true } })).toThrow(/未知配置键/)
  })

  it('rateLimit 可配置且非法值 fail-loud', () => {
    expect(
      webPlugin.validate({ rateLimit: { windowMs: 1_000, maxRequests: 2 } }).rateLimit,
    ).toEqual({ windowMs: 1_000, maxRequests: 2 })
    expect(webPlugin.validate({ rateLimit: {} }).rateLimit).toEqual(DEFAULT_WEB.rateLimit)
    expect(() => webPlugin.validate({ rateLimit: { maxRequests: 0 } })).toThrow(/maxRequests/)
    expect(() => webPlugin.validate({ rateLimit: { extra: 1 } })).toThrow(/未知配置键/)
    expect(() => webPlugin.validate({ rateLimit: 'bad' })).toThrow(/对象/)
  })
})

describe('channel:web 协议', () => {
  it('/api/session 返回会话与能力位', async () => {
    const harness = await boot()
    try {
      const response = await authedFetch(`${harness.url}api/session`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { sessionId: string; capabilities: { richCards: boolean } }
      expect(body.sessionId).toBe('s-web-test')
      expect(body.capabilities.richCards).toBe(true)
    } finally {
      await shutdown(harness)
    }
  })

  it('/api/health 只暴露在途票据数量（不暴露 ID）', async () => {
    const harness = await boot()
    try {
      const body = (await (await authedFetch(`${harness.url}api/health`)).json()) as {
        ok: boolean
        pendingTicketCount: number
      }
      expect(body.ok).toBe(true)
      expect(body.pendingTicketCount).toBe(0)
      expect(JSON.stringify(body)).not.toContain('ticket:')
    } finally {
      await shutdown(harness)
    }
  })

  it('静态页与 API 都带安全响应头', async () => {
    const harness = await boot()
    try {
      const page = await nativeFetch(harness.url)
      expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(page.headers.get('x-content-type-options')).toBe('nosniff')
      expect(page.headers.get('x-frame-options')).toBe('DENY')
      expect(page.headers.get('referrer-policy')).toBe('no-referrer')
      expect(page.headers.get('permissions-policy')).toContain('camera=()')

      const api = await authedFetch(`${harness.url}api/health`)
      expect(api.headers.get('content-security-policy')).toContain("default-src 'self'")
    } finally {
      await shutdown(harness)
    }
  })

  it('API 超过 rateLimit 后返回 429', async () => {
    const harness = await boot({ rateLimit: { windowMs: 60_000, maxRequests: 2 } })
    try {
      expect((await authedFetch(`${harness.url}api/health`)).status).toBe(200)
      expect((await authedFetch(`${harness.url}api/health`)).status).toBe(200)
      const limited = await authedFetch(`${harness.url}api/health`)
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBe('60')
      expect(((await limited.json()) as { error: { code: string } }).error.code).toBe(
        'web-rate-limited',
      )
    } finally {
      await shutdown(harness)
    }
  })

  it('/api/turn 空文本 → 400 web-empty-message', async () => {
    const harness = await boot()
    try {
      const response = await authedFetch(`${harness.url}api/turn`, {
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
      const response = await authedFetch(`${harness.url}api/turn`, {
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
      const response = await authedFetch(`${harness.url}api/interrupt`, {
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
      const bad = await authedFetch(`${harness.url}api/events?since=abc`)
      expect(bad.status).toBe(400)

      const controller = new AbortController()
      const stream = await authedFetch(`${harness.url}api/events?since=0`, { signal: controller.signal })
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
      const missing = await authedFetch(`${harness.url}api/approval/ticket%3Aghost`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allowed-once' }),
      })
      expect(missing.status).toBe(404)

      const invalid = await authedFetch(`${harness.url}api/approval/${encodeURIComponent('bad id!')}`, {
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
      const response = await authedFetch(`${harness.url}api/verify/ticket%3Aghost`, { method: 'POST' })
      expect(response.status).toBe(404)

      // 票据 ID 会进日志与查询键：非法字符必须在触达适配器之前挡掉
      const invalid = await authedFetch(
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

describe('channel:web Web 凭证（D5 最小集）', () => {
  it('无凭证 / 错凭证 → 401，且请求不触达 agent', async () => {
    const harness = await boot()
    try {
      const missing = await nativeFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '给王建国转 800 元' }),
      })
      expect(missing.status).toBe(401)
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
        'web-unauthorized',
      )
      expect(harness.sent).toEqual([])

      const wrong = await nativeFetch(`${harness.url}api/session`, {
        headers: { authorization: 'Bearer not-the-token' },
      })
      expect(wrong.status).toBe(401)
    } finally {
      await shutdown(harness)
    }
  })

  it('GET /api/session 同样要求凭证；健康探针保持公开', async () => {
    const harness = await boot()
    try {
      expect((await nativeFetch(`${harness.url}api/session`)).status).toBe(401)
      expect((await nativeFetch(`${harness.url}api/health`)).status).toBe(200)
    } finally {
      await shutdown(harness)
    }
  })

  it('SSE 只能用查询参数带凭证：无 token → 401，带 token → 首帧快照', async () => {
    const harness = await boot()
    try {
      expect((await nativeFetch(`${harness.url}api/events?since=0`)).status).toBe(401)

      const controller = new AbortController()
      const stream = await nativeFetch(
        `${harness.url}api/events?since=0&token=${encodeURIComponent(WEB_TOKEN)}`,
        { signal: controller.signal },
      )
      expect(stream.status).toBe(200)
      const reader = stream.body?.getReader()
      const first = await reader?.read()
      const text = new TextDecoder().decode(first?.value)
      expect(text).toContain('"kind":"snapshot"')
      controller.abort()
    } finally {
      await shutdown(harness)
    }
  })
})

describe('channel:web CSRF（W09）', () => {
  it('TC-W09-05：跨站 Origin 且无 CSRF 令牌 → 403，且不触达 agent', async () => {
    const harness = await boot()
    try {
      const response = await authedFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ text: '给王建国转 800 元' }),
      })
      expect(response.status).toBe(403)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'web-csrf-forbidden',
      )
      expect(harness.sent).toEqual([])
    } finally {
      await shutdown(harness)
    }
  })

  it('写请求既无 Origin 也无 CSRF 令牌 → 403 web-csrf-required', async () => {
    const harness = await boot()
    try {
      const response = await nativeFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${WEB_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: '给王建国转 800 元' }),
      })
      expect(response.status).toBe(403)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'web-csrf-required',
      )
      expect(harness.sent).toEqual([])
    } finally {
      await shutdown(harness)
    }
  })

  it('TC-W09-06：同源 Origin 的写请求正常通过', async () => {
    const harness = await boot()
    try {
      const response = await authedFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '查余额' }),
      })
      expect(response.status).toBe(202)
      expect(harness.sent).toEqual(['查余额'])
    } finally {
      await shutdown(harness)
    }
  })

  it('double-submit：index 下发 cookie，写请求回填同名 header 即通过', async () => {
    const harness = await boot()
    try {
      const page = await nativeFetch(harness.url)
      const setCookie = page.headers.get('set-cookie') ?? ''
      const match = /bah_csrf=([^;]+)/.exec(setCookie)
      expect(match?.[1]).toBeTruthy()
      const token = decodeURIComponent(match![1]!)

      const response = await nativeFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${WEB_TOKEN}`,
          'content-type': 'application/json',
          'x-bah-csrf': token,
          cookie: `bah_csrf=${encodeURIComponent(token)}`,
        },
        body: JSON.stringify({ text: '查余额' }),
      })
      expect(response.status).toBe(202)
      expect(harness.sent).toEqual(['查余额'])

      // 伪造成对但值与服务端不同的 cookie + header：仍然拒绝
      const forged = await nativeFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${WEB_TOKEN}`,
          'content-type': 'application/json',
          'x-bah-csrf': 'forged',
          cookie: 'bah_csrf=forged',
        },
        body: JSON.stringify({ text: '再来一次' }),
      })
      expect(forged.status).toBe(403)
      expect(harness.sent).toEqual(['查余额'])
    } finally {
      await shutdown(harness)
    }
  })

  it('CSRF 关闭开关：web.csrf.enabled=false 时不检查（回滚路径）', async () => {
    const harness = await boot({ csrf: { enabled: false } })
    try {
      const response = await nativeFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${WEB_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: '查余额' }),
      })
      expect(response.status).toBe(202)
    } finally {
      await shutdown(harness)
    }
  })
})


describe('channel:web 静态资源安全', () => {
  it('目录穿越返回 404（不返回 403，免得被探测）', async () => {
    const harness = await boot()
    try {
      const response = await authedFetch(`${harness.url}..%2f..%2fpackage.json`)
      expect(response.status).toBe(404)
    } finally {
      await shutdown(harness)
    }
  })

  it('不存在的资源 404，index 存在时返回 html', async () => {
    const harness = await boot()
    try {
      const missing = await authedFetch(`${harness.url}nope.html`)
      expect(missing.status).toBe(404)

      const index = await authedFetch(harness.url)
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('text/html')
      // 页面是 token 的唯一载体：注入 meta 且不许缓存（重启后 token 会换）
      expect(await index.text()).toContain(`name="bah-web-token" content="${WEB_TOKEN}"`)
      expect(index.headers.get('cache-control')).toBe('no-store')
    } finally {
      await shutdown(harness)
    }
  })

  it('非 index 静态资源原样返回且 no-cache（不注入 token、不做 no-store）', async () => {
    const harness = await boot()
    try {
      const asset = await authedFetch(`${harness.url}package.json`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toContain('application/json')
      expect(asset.headers.get('cache-control')).toBe('no-cache')
      // token 只属于 index：任意静态文件里都不许出现
      expect(await asset.text()).not.toContain(WEB_TOKEN)
    } finally {
      await shutdown(harness)
    }
  })

  it('方法不支持 → 405', async () => {
    const harness = await boot()
    try {
      const response = await authedFetch(`${harness.url}api/session`, { method: 'DELETE' })
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
      const tooLarge = await authedFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(66 * 1024) }),
      })
      expect(tooLarge.status).toBe(413)
      expect(((await tooLarge.json()) as { error: { code: string } }).error.code).toBe(
        'web-body-too-large',
      )

      const notObject = await authedFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[]',
      })
      expect(notObject.status).toBe(400)
      expect(((await notObject.json()) as { error: { code: string } }).error.code).toBe(
        'web-invalid-body',
      )

      const broken = await authedFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      })
      expect(broken.status).toBe(400)
      expect(((await broken.json()) as { error: { code: string } }).error.code).toBe(
        'web-invalid-json',
      )

      // 单个坏请求不能拖垮服务
      expect((await authedFetch(`${harness.url}api/health`)).status).toBe(200)
    } finally {
      await shutdown(harness)
    }
  })

  it('没有活体 agent 时 /api/turn 与 /api/interrupt 都是 503', async () => {
    const harness = await boot({}, { agent: 'absent' })
    try {
      const turn = await authedFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      })
      expect(turn.status).toBe(503)
      expect(((await turn.json()) as { error: { code: string } }).error.code).toBe('agent-absent')

      const interrupt = await authedFetch(`${harness.url}api/interrupt`, { method: 'POST' })
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
      const response = await authedFetch(`${harness.url}api/turn`, {
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
      const stream = await authedFetch(`${harness.url}api/events?since=0`, { signal: controller.signal })
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

  /**
   * TC-W18-02：真实 `append` 链路上的 tool / approval 帧。
   *
   * 旧用例是手工 `emit('session/event', …)`（见上一条），它**跳过了** append → 广播 → 投影
   * 这条真实路径，所以抓不到广播重入：排在 Web 投影器之前的写者（sentry 的 trace sink）
   * 会让 seq=N+1 先到达，投影器的 `seq <= last` 守卫把 seq=N 静默丢掉，
   * 表现就是网页只有 audit / message、没有 tool / approval，审批弹窗永不出现。
   */
  it('TC-W18-02：边收边写的监听器不得让 tool / approval 帧丢失（真实 append 链路）', async () => {
    const harness = await boot({ heartbeatMs: 60_000 }, { traceWriter: true })
    const controller = new AbortController()
    try {
      const stream = await authedFetch(`${harness.url}api/events?since=0`, { signal: controller.signal })
      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      await readUntil(reader, decoder, '"kind":"snapshot"')

      const session = harness.ctx.get(SESSION_SERVICE)
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', {
        callId: 'c-w18',
        name: 'transfer_create',
        args: { amount: 800, payee: { name: '王建国' } },
        fingerprint: 'transfer_create:w18',
        tier: { level: 'yellow' },
        at: 1_700_000_000_000,
      })
      session.append('approval/asked', {
        ticketId: 't-w18' as unknown as TicketId,
        callId: 'c-w18',
        name: 'transfer_create',
        amount: 800,
      })

      const seen = await readUntil(reader, decoder, '"kind":"approval"')
      // 三条按落账顺序到达：turn / tool / approval（tool 帧丢了就没有审批弹窗的依据）
      expect(seen).toContain('"kind":"turn"')
      expect(seen).toContain('"kind":"tool"')
      expect(seen).toContain('"kind":"approval"')
      // 审批帧带上金额与收款人（金额单位是分，¥800.00 而不是 ¥8.00）
      expect(seen).toContain('"amountText":"¥800.00"')
      expect(seen).toContain('"payeeName":"王建国"')
    } finally {
      controller.abort()
      await shutdown(harness)
    }
  })

  it('常驻驱动失败 → fault 帧（独立事件名，不与 EventSource 内置 error 冲突）', async () => {
    const harness = await boot({}, { agent: 'drive-fails' })
    const controller = new AbortController()
    try {
      const stream = await authedFetch(`${harness.url}api/events?since=0`, { signal: controller.signal })
      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      await readUntil(reader, decoder, '"kind":"snapshot"')

      const response = await authedFetch(`${harness.url}api/turn`, {
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
      const response = await authedFetch(`${harness.url}api/events?since=0`)
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

      const health = (await (await authedFetch(`${harness.url}api/health`)).json()) as {
        pendingTicketCount: number
      }
      expect(health.pendingTicketCount).toBe(1)

      const verify = await authedFetch(`${harness.url}api/verify/${encodeURIComponent(ticketId)}`, {
        method: 'POST',
      })
      expect(verify.status).toBe(200)

      const decide = await authedFetch(`${harness.url}api/approval/${encodeURIComponent(ticketId)}`, {
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

  it('TC-W04-01 无 Authorization → 401，且不触发审批状态迁移', async () => {
    const harness = await boot({}, { challenges: passingChallenge })
    const approval = harness.ctx.get(APPROVAL_SERVICE)
    const ticketId = 'ticket:no-auth'
    try {
      const settled = approval.handle(approvalInput(ticketId), async (value) => value)
      await new Promise((resolve) => {
        setImmediate(resolve)
      })
      expect(approval.pendingCount).toBe(1)

      const denied = await nativeFetch(
        `${harness.url}api/approval/${encodeURIComponent(ticketId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'allowed-once' }),
        },
      )
      expect(denied.status).toBe(401)
      // 401 不消耗票据：仍是待应答
      expect(approval.pendingCount).toBe(1)

      // 补上凭证后仍然可以正常批准——证明上面的 401 没有偷偷结算
      const ok = await authedFetch(`${harness.url}api/approval/${encodeURIComponent(ticketId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allowed-once' }),
      })
      expect(ok.status).toBe(200)
      expect((await settled).decision.decision).toBe('allowed-once')
    } finally {
      await shutdown(harness)
    }
  })

  it('TC-W04-02 有效 token + 他人会话的票据 → 403（decide / verify 都拒）', async () => {
    const harness = await boot({}, { challenges: passingChallenge, approvalSession: 's-other' })
    const approval = harness.ctx.get(APPROVAL_SERVICE)
    const ticketId = 'ticket:foreign'
    try {
      const settled = approval.handle(approvalInput(ticketId), async (value) => value)
      await new Promise((resolve) => {
        setImmediate(resolve)
      })
      expect(approval.pendingCount).toBe(1)

      const decide = await authedFetch(`${harness.url}api/approval/${encodeURIComponent(ticketId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allowed-once' }),
      })
      expect(decide.status).toBe(403)
      expect(await decide.json()).toMatchObject({ error: { code: 'foreign-ticket' } })

      const verify = await authedFetch(`${harness.url}api/verify/${encodeURIComponent(ticketId)}`, {
        method: 'POST',
      })
      expect(verify.status).toBe(403)

      // 两次拒绝都不结算票据
      expect(approval.pendingCount).toBe(1)

      approval.dispose()
      expect((await settled).decision.decision).toBe('cancelled')
    } finally {
      await shutdown(harness)
    }
  })

  it('TC-W04-03 未知票据 404 与跨会话 403 使用同一响应信封（不泄露票据元数据）', async () => {
    const harness = await boot({}, { challenges: passingChallenge, approvalSession: 's-other' })
    const approval = harness.ctx.get(APPROVAL_SERVICE)
    const foreign = 'ticket:foreign-shape'
    try {
      const settled = approval.handle(approvalInput(foreign), async (value) => value)
      await new Promise((resolve) => {
        setImmediate(resolve)
      })

      const forbidden = await authedFetch(
        `${harness.url}api/approval/${encodeURIComponent(foreign)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'allowed-once' }),
        },
      )
      const missing = await authedFetch(
        `${harness.url}api/approval/${encodeURIComponent('ticket:none-shape')}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'allowed-once' }),
        },
      )
      expect(forbidden.status).toBe(403)
      expect(missing.status).toBe(404)

      const forbiddenBody = (await forbidden.json()) as Record<string, unknown>
      const missingBody = (await missing.json()) as Record<string, unknown>
      // 同一信封：只有 error.code / error.reason，没有票据金额 / 工具名 / 会话 ID
      expect(Object.keys(forbiddenBody)).toEqual(['error'])
      expect(Object.keys(missingBody)).toEqual(['error'])
      expect(Object.keys(forbiddenBody['error'] as object).sort()).toEqual(['code', 'reason'])
      expect(Object.keys(missingBody['error'] as object).sort()).toEqual(['code', 'reason'])

      approval.dispose()
      await settled
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
    authedFetch(`${url}api/admin/sentry/unfreeze`, {
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

      const broken = await authedFetch(`${harness.url}api/admin/sentry/unfreeze`, {
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
      const response = await authedFetch(`${configured.url}api/admin/sentry/unfreeze`)
      expect(response.status).toBe(405)
    } finally {
      await shutdown(configured)
    }

    // 同一路径、同一方法，但宿主没配 token：必须仍是 404——
    // 否则扫描器一个 GET 就能确认"管理口存在，只是方法不对"
    setToken(undefined)
    const unconfigured = await boot({}, { sentry: 'frozen' })
    try {
      const response = await authedFetch(`${unconfigured.url}api/admin/sentry/unfreeze`)
      expect(response.status).toBe(404)
    } finally {
      await shutdown(unconfigured)
    }
  })

  it('HP0-07 非回环来源 → 403 web-admin-forbidden：来源被挡时连 token 都不比，更不解冻', async () => {
    // 为什么用假 socket 直接驱动 handler，而不是 fetch：真实连接里回环服务器能给到
    // handler 的 remoteAddress 永远是 127.x / ::1，403 分支无法用正常请求触达——
    // 但它是"管理口只绑本机"的最后一道防线（token 泄漏也进不来），必须被钉住。
    setToken('correct-token-value')
    const harness = await boot({}, { sentry: 'frozen' })
    try {
      const written: { status?: number; body?: string } = {}
      const res = {
        headersSent: false,
        writeHead(status: number): void {
          written.status = status
        },
        end(chunk?: unknown): void {
          written.body = chunk === undefined ? '' : String(chunk)
        },
      }
      const req = {
        socket: { remoteAddress: '10.0.0.1' },
        method: 'POST',
        url: '/api/admin/sentry/unfreeze',
        // 给足完全正确的 token：来源不对也必须挡（安全顺序：存在性 → 来源 → 方法 → 凭证）
        headers: { host: '127.0.0.1:7331', authorization: 'Bearer correct-token-value' },
      }

      harness.requestListener(req as unknown as IncomingMessage, res as unknown as ServerResponse)
      // 监听器是 fire-and-forget 的 `void handle(...)`：宏任务屏障等头落定
      // （与审批用例同款做法，不赌微任务顺序）。
      await new Promise((resolve) => {
        setImmediate(resolve)
      })

      expect(written.status).toBe(403)
      const body = JSON.parse(String(written.body)) as { error: { code: string; reason: string } }
      expect(body.error.code).toBe('web-admin-forbidden')
      expect(body.error.reason).toContain('回环')
      // 挡在"来源"这一步：body 都没读，断路器当然没被碰
      expect(harness.unfreezeCalls).toEqual([])
    } finally {
      await shutdown(harness)
    }
  })
})

/**
 * W07 管理面：HALT / 申请解除票据 / 凭票据解除。
 *
 * 与 HP-0 的解冻路由共用同一道管理闸（token / 回环 / POST），这里只钉
 * 新路径的语义：reason 写死 manual、票据三态、没有 force、HALT 期新 turn 是 423。
 */
describe('channel:web HALT 管理路由（W07）', () => {
  const saved = process.env[ADMIN_TOKEN_ENV]
  const TOKEN = 'halt-admin-token'

  const setToken = (value: string | undefined): void => {
    if (value === undefined) delete process.env[ADMIN_TOKEN_ENV]
    else process.env[ADMIN_TOKEN_ENV] = value
  }

  const postTo = (
    url: string,
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<Response> =>
    nativeFetch(`${url}api/admin/halt${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
    })

  afterEach(() => {
    setToken(saved)
  })

  it('未设 token → 404（与 sentry 管理口同一条闸）', async () => {
    setToken(undefined)
    const harness = await boot({}, { halt: 'running' })
    try {
      const response = await postTo(harness.url, '', {}, false)
      expect(response.status).toBe(404)
    } finally {
      await shutdown(harness)
    }
  })

  it('缺 / 错 token → 401；GET → 405；未知键 → 400', async () => {
    setToken(TOKEN)
    const harness = await boot({}, { halt: 'running' })
    try {
      expect((await postTo(harness.url, '', {}, false)).status).toBe(401)
      const get = await nativeFetch(`${harness.url}api/admin/halt`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(get.status).toBe(405)

      const unknown = await postTo(harness.url, '', { reason: 'manual' }, true)
      expect(unknown.status).toBe(400)
      expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
        'web-admin-invalid-body',
      )
      expect(harness.halt?.halted).toBe(false)
    } finally {
      await shutdown(harness)
    }
  })

  it('halt：200 → HALTED；重复调用 changed=false（幂等）', async () => {
    setToken(TOKEN)
    const harness = await boot({}, { halt: 'running' })
    try {
      const first = await postTo(harness.url, '', { detail: '演练停机' }, true)
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({ ok: true, halted: true, changed: true })
      expect(harness.halt?.halted).toBe(true)
      expect(harness.halt?.reason).toBe('manual')

      const second = await postTo(harness.url, '', {}, true)
      expect(await second.json()).toEqual({ ok: true, halted: true, changed: false })
    } finally {
      await shutdown(harness)
    }
  })

  it('unfreeze-request + unfreeze：票据来自审批；解冻后 RUNNING', async () => {
    setToken(TOKEN)
    const harness = await boot({}, { halt: 'halted' })
    try {
      const requested = await postTo(harness.url, '/unfreeze-request', {}, true)
      expect(requested.status).toBe(200)
      const body = (await requested.json()) as { ticketId: string; expiresAt: number }
      expect(body.ticketId).toBe('t-web-unfreeze')

      const unfrozen = await postTo(harness.url, '/unfreeze', { ticketId: body.ticketId }, true)
      expect(unfrozen.status).toBe(200)
      expect(await unfrozen.json()).toEqual({ ok: true, halted: false })
      expect(harness.halt?.halted).toBe(false)
    } finally {
      await shutdown(harness)
    }
  })

  it('unfreeze：未知票据 → 400；本来没 HALT → 409（幂等 no-op 由 CLI 翻成 0）', async () => {
    setToken(TOKEN)
    const halted = await boot({}, { halt: 'halted' })
    try {
      const unknown = await postTo(halted.url, '/unfreeze', { ticketId: 't-missing' }, true)
      expect(unknown.status).toBe(400)
      expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
        'halt-ticket-unknown',
      )
      expect(halted.halt?.halted).toBe(true)
    } finally {
      await shutdown(halted)
    }

    const running = await boot({}, { halt: 'running' })
    try {
      const response = await postTo(running.url, '/unfreeze', { ticketId: 't-web-unfreeze' }, true)
      expect(response.status).toBe(409)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'halt-not-halted',
      )
    } finally {
      await shutdown(running)
    }
  })

  it('审批被拒 → 409 halt-approval-rejected；没有 halt 服务 → 503 halt-absent', async () => {
    setToken(TOKEN)
    const rejected = await boot({}, { halt: 'rejected' })
    try {
      const response = await postTo(rejected.url, '/unfreeze-request', {}, true)
      expect(response.status).toBe(409)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'halt-approval-rejected',
      )
    } finally {
      await shutdown(rejected)
    }

    const absent = await boot({}, { halt: 'absent' })
    try {
      expect((await postTo(absent.url, '', {}, true)).status).toBe(503)
      expect((await postTo(absent.url, '/unfreeze-request', {}, true)).status).toBe(503)
      expect(
        (await postTo(absent.url, '/unfreeze', { ticketId: 't-x' }, true)).status,
      ).toBe(503)
    } finally {
      await shutdown(absent)
    }
  })

  it('HALT 期间新 turn → 423 safety-halted（不是 500）', async () => {
    setToken(TOKEN)
    const harness = await boot({}, { agent: 'halted' })
    try {
      const response = await authedFetch(`${harness.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '转账' }),
      })
      expect(response.status).toBe(423)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'safety-halted',
      )
      expect(harness.sent).toEqual([])
    } finally {
      await shutdown(harness)
    }
  })
})

describe('channel:web HALT 管理路由（W07 边界）', () => {
  const saved = process.env[ADMIN_TOKEN_ENV]
  const TOKEN = 'halt-admin-token'
  const setToken = (value: string | undefined): void => {
    if (value === undefined) delete process.env[ADMIN_TOKEN_ENV]
    else process.env[ADMIN_TOKEN_ENV] = value
  }
  const postTo = (url: string, path: string, body: unknown): Promise<Response> =>
    nativeFetch(`${url}api/admin/halt${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    })

  afterEach(() => {
    setToken(saved)
  })

  it('没有票据端口 / 开关关闭 → 503，code 分别是 halt-approval-absent / halt-disabled', async () => {
    setToken(TOKEN)
    for (const [variant, code] of [
      ['no-port', 'halt-approval-absent'],
      ['disabled', 'halt-disabled'],
    ] as const) {
      const harness = await boot({}, { halt: variant })
      try {
        const response = await postTo(harness.url, '/unfreeze-request', {})
        expect(response.status).toBe(503)
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code)

        if (variant === 'disabled') {
          // 回滚开关关闭时，halt / unfreeze 也必须 503 —— 不能伪装成"HALT / 已解除"
          const haltResponse = await postTo(harness.url, '', {})
          expect(haltResponse.status).toBe(503)
          expect(((await haltResponse.json()) as { error: { code: string } }).error.code).toBe(
            'halt-disabled',
          )
          const unfreezeResponse = await postTo(harness.url, '/unfreeze', {
            ticketId: 't-web-unfreeze',
          })
          expect(unfreezeResponse.status).toBe(503)
          expect(((await unfreezeResponse.json()) as { error: { code: string } }).error.code).toBe(
            'halt-disabled',
          )
        }
      } finally {
        await shutdown(harness)
      }
    }
  })

  it('解除体非法（缺 ticketId / force 未知键）→ 400，不触达状态机', async () => {
    setToken(TOKEN)
    const harness = await boot({}, { halt: 'halted' })
    try {
      for (const body of [{}, { ticketId: 't-web-unfreeze', force: true }]) {
        const response = await postTo(harness.url, '/unfreeze', body)
        expect(response.status).toBe(400)
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          'web-admin-invalid-body',
        )
      }
      expect(harness.halt?.halted).toBe(true)
    } finally {
      await shutdown(harness)
    }
  })


})
