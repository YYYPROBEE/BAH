/**
 * 认证路由与闸顺序（租户与鉴权 02 · TA-25 / TA-26 / TA-28）。
 *
 * 这个文件用一个**真实的 dispatcher + 真实 auth runtime**（只把 sessions 日志放临时目录），
 * 所以它同时证明三件事：
 * 1. 闸的顺序（身份 401 早于 CSRF 403；管理面不进 principal 分支）；
 * 2. 登录/登出/自查的契约（两个 cookie、回包不含 sid、失败同形、轮换 CSRF）；
 * 3. `password` 模式下 `?token=` 不再被接受（缺口 3 堵住）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { createContext } from '@bah/core'
import { CREDENTIALS } from '@bah/persistence'
import { parseTenantId } from '@bah/util'

import type { IncomingMessage, ServerResponse } from 'node:http'

import { DEFAULT_WEB } from '../config.ts'
import type { WebDeps } from '../deps.ts'
import { createDispatcher } from '../dispatch.ts'
import { createAuthRuntime } from '../auth/identity.ts'
import { loadDirectory } from '../auth/directory.ts'
import { createSessionStore } from '../auth/session-store.ts'
import { createThrottle } from '../auth/throttle.ts'
import { createWebAuthRuntime } from '../auth/wire.ts'
import { createRateLimiter } from '../../web-rate-limit.ts'
import { DECISION_AUDIT } from '../../audit-decisions.ts'

const TENANT = 'demo'
const SERVER_CSRF = 'process-csrf'
const WEB_TOKEN = 'tok-web'
const NOW = 1_700_000_000_000

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 抓到的响应。 */
interface Probe {
  status: number
  headers: Record<string, unknown>
  body: string
}

/** 最小响应桩（`sendJson` / `setHeader` / `once`）。 */
function makeRes(): { res: ServerResponse; probe: Probe } {
  const probe: Probe = { status: 0, headers: {}, body: '' }
  const base: Record<string, unknown> = {
    headersSent: false,
    setHeader(name: string, value: unknown) {
      probe.headers[name.toLowerCase()] = value
      return base
    },
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      probe.status = status
      for (const [name, value] of Object.entries(headers)) probe.headers[name.toLowerCase()] = value
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
  const res = base as unknown as ServerResponse
  return { res, probe }
}

/** 最小请求桩（带可被 `readJson` 消费的 body 流）。 */
function makeReq(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  const req = stream as unknown as IncomingMessage & { method?: string; url?: string }
  Object.assign(req, {
    method,
    url: path,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  })
  return req
}

/** 造一套 password 模式的装配（真实 store / directory / throttle）。 */
function makeHarness(options: { mode?: 'password' | 'static'; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bah-auth-handler-'))
  dirs.push(dir)
  const mode = options.mode ?? 'password'
  const clock = options.now ?? (() => NOW)
  const store = createSessionStore({
    now: clock,
    idleMs: 60_000,
    absoluteMs: 600_000,
    logPath: join(dir, 'auth', 'sessions.jsonl'),
    warn: () => undefined,
  })
  const directory =
    mode === 'password'
      ? loadDirectory('auth/users.example.yml', TENANT, { warn: () => undefined })
      : undefined
  const auth = createAuthRuntime({
    mode,
    tenantId: TENANT,
    now: clock,
    sessions: store,
    throttle: createThrottle({ maxFailures: 5, lockMs: 900_000, backoffBaseMs: 1_000, backoffMaxMs: 2_000 }),
    ...(directory === undefined ? {} : { directory }),
    serverCsrf: SERVER_CSRF,
    staticTokenOk: (presented) => presented === `Bearer ${WEB_TOKEN}`,
    absoluteMs: 600_000,
    cookieName: 'bah_sid',
    cookieSecure: false,
  })
  const settings = {
    ...DEFAULT_WEB,
    auth: { ...DEFAULT_WEB.auth, mode, directory: { path: 'auth/users.example.yml' } },
  }
  const deps = {
    session: { sessionId: 's-auth', lastSeq: () => 0, events: () => [] },
    tenantId: parseTenantId(TENANT),
    auth,
    adapter: { decide: () => ({ ok: true }), verify: () => Promise.resolve({ ok: true }), attachApproval: () => undefined, dispose: () => undefined, pendingTickets: () => [], inbound: ({ text }: { text: string }) => ({ text }) },
    hub: { size: () => 0, attach: () => undefined, publish: () => undefined, publishFault: () => undefined, dispose: () => undefined },
    handoff: { active: false, enter: () => ({ ok: false, code: 'x' }), resume: () => ({ ok: false, code: 'x' }), summary: () => ({ active: false, sessionId: 's-auth', lastSeq: 0, turns: 0, pendingTickets: 0, messages: [] }) },
    webToken: WEB_TOKEN,
    csrfToken: SERVER_CSRF,
    rateLimiter: createRateLimiter({ windowMs: 60_000, maxRequests: 1_000 }),
    now: clock,
    firstAgent: () => undefined,
    ensureDriver: () => undefined,
    trySentry: () => undefined,
    tryHalt: () => undefined,
    tryTelemetry: () => undefined,
    staticRoot: 'apps/web',
    indexPath: join('apps/web', 'index.html'),
  } as unknown as WebDeps
  const handle = createDispatcher(settings as never, deps)

  /** 发一个请求。 */
  async function call(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<Probe> {
    const { res, probe } = makeRes()
    await handle(makeReq(method, path, headers, body), res)
    return probe
  }

  return { call, store, auth, settings }
}

const ORIGIN = { origin: 'http://127.0.0.1:7331', host: '127.0.0.1:7331' }

/** 从 `set-cookie` 头里取某条 cookie 的值。 */
function cookieOf(probe: Probe, name: string): string | undefined {
  const raw = probe.headers['set-cookie']
  const list = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)]
  for (const entry of list) {
    const first = entry.split(';')[0] ?? ''
    if (first.startsWith(`${name}=`)) return first.slice(name.length + 1)
  }
  return undefined
}

describe('TA-25 · 闸顺序（password 模式）', () => {
  it('TA-25-1 无 cookie + GET /api/session → 401 web-unauthorized', async () => {
    const { call } = makeHarness()
    const probe = await call('GET', '/api/session')
    expect(probe.status).toBe(401)
    expect(JSON.parse(probe.body).error.code).toBe('web-unauthorized')
  })

  it('TA-25-2 无 cookie + GET /api/health → 200（公开路由不受影响）', async () => {
    const { call } = makeHarness()
    const probe = await call('GET', '/api/health')
    expect(probe.status).toBe(200)
  })

  it('TA-25-3 无 cookie + POST /api/admin/halt → 仍走管理面（404，不进 principal 分支）', async () => {
    const { call } = makeHarness()
    const probe = await call('POST', '/api/admin/halt', { ...ORIGIN })
    // 管理面在 web 身份之前判定：没有 admin token 且非回环 → 404（不暴露存在性）
    expect(probe.status).toBe(404)
  })

  it('TA-25-4 有 cookie 但缺 CSRF + POST /api/turn → 403（不是 401）', async () => {
    const { call } = makeHarness()
    const login = await call('POST', '/api/auth/login', { ...ORIGIN, 'content-type': 'application/json' }, {
      userId: 'u-1',
      password: 'demo1234',
    })
    const sid = cookieOf(login, 'bah_sid')
    expect(sid).toBeDefined()
    // **不带 Origin**：同源 Origin 是 CSRF 的放行路径，带上就测不到"缺 CSRF"
    const probe = await call('POST', '/api/turn', { cookie: `bah_sid=${String(sid)}`, host: '127.0.0.1:7331' }, { text: '你好' })
    expect(probe.status).toBe(403)
    expect(JSON.parse(probe.body).error.code).toBe('web-csrf-required')
  })

  it('TA-25-5 登录本身也过 CSRF：跨源 Origin → 403（登录 CSRF 攻击面）', async () => {
    const { call } = makeHarness()
    const probe = await call(
      'POST',
      '/api/auth/login',
      { origin: 'http://evil.example', host: '127.0.0.1:7331' },
      { userId: 'u-1', password: 'demo1234' },
    )
    expect(probe.status).toBe(403)
  })
})

describe('TA-26 · 登录 / 登出 / 自查', () => {
  it('TA-26-1 登录成功 → 两个 cookie（sid 带 HttpOnly、csrf 带 Max-Age）+ 回包不含 sid', async () => {
    const { call } = makeHarness()
    const probe = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'demo1234' },
    )
    expect(probe.status).toBe(200)
    const body = JSON.parse(probe.body)
    expect(body.userId).toBe('u-1')
    expect(body.roles).toEqual(['customer', 'agent'])
    expect(JSON.stringify(body)).not.toContain('sid')
    const raw = (probe.headers['set-cookie'] as unknown as string[]).join('\n')
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('SameSite=Strict')
    // 两个 Max-Age（sid 与 csrf 同步，AR-07 陷阱 2）
    expect(raw.match(/Max-Age=\d+/g)?.length).toBe(2)
  })

  it('TA-26-2 口令错与用户不存在 → **逐字节同形**（状态码 + body）', async () => {
    const { call } = makeHarness()
    const wrongPassword = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'wrong' },
    )
    const unknownUser = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-404', password: 'wrong' },
    )
    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(wrongPassword.status)
    expect(unknownUser.body).toBe(wrongPassword.body)
  })

  it('TA-26-3 连续 5 次失败 → 第 6 次 409 web-login-locked（带 retry-after）', async () => {
    const { call } = makeHarness()
    for (let index = 0; index < 5; index += 1) {
      const probe = await call(
        'POST',
        '/api/auth/login',
        { ...ORIGIN, 'content-type': 'application/json' },
        { userId: 'u-1', password: 'wrong' },
      )
      expect(probe.status).toBe(401)
    }
    const locked = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'demo1234' },
    )
    expect(locked.status).toBe(409)
    expect(JSON.parse(locked.body).error.code).toBe('web-login-locked')
    expect(locked.headers['retry-after']).toBeDefined()
  })

  it('TA-26-8 退避窗口内的重试 → 401（不是 409），body 与首次口令错逐字节相同', async () => {
    const { call } = makeHarness()
    const first = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'wrong' },
    )
    expect(first.status).toBe(401)
    // 时钟冻结 ⇒ 第二次必在 1s 退避窗口内：它仍是"口令错"，不是"已锁定"
    const retry = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'wrong' },
    )
    expect(retry.status).toBe(401)
    expect(JSON.parse(retry.body).error.code).toBe('web-login-failed')
    expect(retry.body).toBe(first.body)
    expect(retry.headers['retry-after']).toBeDefined()
  })

  it('TA-26-9 五次失败各自越过退避窗口 → 五次全 401，第 6 次才 409（允许 5 次失败）', async () => {
    let now = NOW
    const { call } = makeHarness({ now: () => now })
    for (let index = 0; index < 5; index += 1) {
      now += 120_000
      const probe = await call(
        'POST',
        '/api/auth/login',
        { ...ORIGIN, 'content-type': 'application/json' },
        { userId: 'u-1', password: 'wrong' },
      )
      expect(probe.status).toBe(401)
    }
    now += 120_000
    const locked = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'demo1234' },
    )
    expect(locked.status).toBe(409)
    expect(JSON.parse(locked.body).error.code).toBe('web-login-locked')
  })

  it('TA-26-10 输错一次后立刻用正确口令 → 200（退避不拒合法用户）', async () => {
    const { call } = makeHarness()
    const wrong = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'wrong' },
    )
    expect(wrong.status).toBe(401)
    // 真机探针抓到的缺陷：退避窗口内拒绝会把"改对了"的用户也判 401
    const ok = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'demo1234' },
    )
    expect(ok.status).toBe(200)
  })

  it('TA-26-4 登录轮换 CSRF：旧进程值 + 新 sid 提交写请求 → 403；会话值 → 不 403', async () => {
    const { call } = makeHarness()
    const login = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'demo1234' },
    )
    const sid = String(cookieOf(login, 'bah_sid'))
    const csrf = String(cookieOf(login, 'bah_csrf'))

    const stale = await call(
      'POST',
      '/api/turn',
      { cookie: `bah_sid=${sid}; bah_csrf=${SERVER_CSRF}`, 'x-bah-csrf': SERVER_CSRF, host: '127.0.0.1:7331' },
      { text: '你好' },
    )
    expect(stale.status).toBe(403)

    const fresh = await call(
      'POST',
      '/api/turn',
      { cookie: `bah_sid=${sid}; bah_csrf=${csrf}`, 'x-bah-csrf': csrf, host: '127.0.0.1:7331' },
      { text: '你好' },
    )
    // 没有 agent 时是 503；关键**不是 401/403**
    expect([202, 503]).toContain(fresh.status)
  })

  it('TA-26-5 登出幂等：两次都 200；登出后原 cookie → 401', async () => {
    const { call } = makeHarness()
    const login = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'demo1234' },
    )
    const sid = String(cookieOf(login, 'bah_sid'))
    const cookie = `bah_sid=${sid}`
    const first = await call('POST', '/api/auth/logout', { ...ORIGIN, cookie })
    expect(first.status).toBe(200)
    const second = await call('POST', '/api/auth/logout', { ...ORIGIN, cookie })
    expect(second.status).toBe(200)
    const after = await call('GET', '/api/session', { cookie })
    expect(after.status).toBe(401)
  })

  it('TA-26-6 /api/auth/me 回包不含 sid；未登录 → 401', async () => {
    const { call } = makeHarness()
    const login = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'demo1234' },
    )
    const sid = String(cookieOf(login, 'bah_sid'))
    const me = await call('GET', '/api/auth/me', { cookie: `bah_sid=${sid}` })
    expect(me.status).toBe(200)
    const body = JSON.parse(me.body)
    expect(body).toMatchObject({ tenant: TENANT, userId: 'u-1', mode: 'password' })
    expect(JSON.stringify(body)).not.toContain('sid')
    expect((await call('GET', '/api/auth/me')).status).toBe(401)
  })

  it('TA-26-7 static 模式下登录路由明确说"没开启"（409，不是 404）', async () => {
    const { call } = makeHarness({ mode: 'static' })
    const probe = await call(
      'POST',
      '/api/auth/login',
      { ...ORIGIN, authorization: `Bearer ${WEB_TOKEN}`, 'content-type': 'application/json' },
      { userId: 'u-1', password: 'demo1234' },
    )
    expect(probe.status).toBe(409)
    expect(JSON.parse(probe.body).error.code).toBe('web-auth-disabled')
  })
})

describe('TA-28 · 缺口 3：password 模式不接受 ?token=', () => {
  it('TA-28-1 GET /api/events?token=<有效静态令牌> → 401', async () => {
    const { call } = makeHarness()
    const probe = await call('GET', `/api/events?token=${WEB_TOKEN}`)
    expect(probe.status).toBe(401)
  })

  it('TA-28-2 static 模式下 ?token= 仍然有效（回归：改动前行为）', async () => {
    const { call } = makeHarness({ mode: 'static' })
    const probe = await call('GET', `/api/events?token=${WEB_TOKEN}`)
    // SSE 长连接会挂住，这里只断言"不是 401"（读取首帧不是本用例的目的）
    expect(probe.status).not.toBe(401)
  })
})

describe('TA-30 · 认证事实进审计链（不是会话事件）', () => {
  it('TA-30-1 登录成功 / 失败 / 登出 各落一条链，且不含明文口令', async () => {
    const entries: { type: string; data: unknown; subject: string; decision: string }[] = []
    const ctx = createContext()
    ctx.provide(DECISION_AUDIT, {
      append: (entry: { type: string; data: unknown; subject: string; decision: string }) => {
        entries.push(entry)
      },
      verifyAll: () => [],
    })
    const runtime = createWebAuthRuntime({
      ctx,
      run: { sessionId: 's-audit', tenantId: parseTenantId(TENANT), now: () => NOW },
      config: {
        ...DEFAULT_WEB,
        auth: { ...DEFAULT_WEB.auth, mode: 'password', directory: { path: 'auth/users.example.yml' } },
      },
      webToken: WEB_TOKEN,
      serverCsrf: SERVER_CSRF,
      warn: () => undefined,
    } as never)
    const login = await runtime.login({ userId: 'u-1', password: 'demo1234', ip: '10.0.0.1' })
    await runtime.login({ userId: 'u-1', password: 'wrong', ip: '10.0.0.1' })
    // 用**真实登录拿到的 sid** 解析身份：没有 cookie 的请求是 anonymous，登出会空转（看着绿，什么都没验）
    const sid = login.ok ? login.session.sid : ''
    expect(sid).not.toBe('')
    const identity = runtime.identify(
      makeReq('GET', '/api/session', { cookie: `bah_sid=${sid}` }),
      NOW,
    )
    expect(identity.kind).toBe('principal')
    expect(runtime.logout(identity, NOW)).toBe(true)

    expect(entries.map((entry) => entry.type)).toEqual([
      'auth/login',
      'auth/login-failed',
      'auth/logout',
    ])
    expect(entries[0]?.subject).toBe(`principal:${TENANT}/u-1`)
    expect(entries[0]?.decision).toBe('allow')
    expect(entries[1]?.decision).toBe('deny')
    expect(entries[1]?.data).not.toHaveProperty('password')
    expect(JSON.stringify(entries)).not.toContain('demo1234')
  })
})

describe('TA-27 · 登录把认证身份绑到银行身份', () => {
  it('TA-27-0 登录成功 → credentials.bindSession(当前会话, userId, session-auth)；失败不绑', async () => {
    const calls: unknown[][] = []
    const ctx = createContext()
    ctx.provide(CREDENTIALS, {
      bindSession: (...args: unknown[]) => {
        calls.push(args)
      },
    } as never)
    const runtime = createWebAuthRuntime({
      ctx,
      run: { sessionId: 's-auth-bind', tenantId: parseTenantId(TENANT), now: () => NOW },
      config: {
        ...DEFAULT_WEB,
        auth: { ...DEFAULT_WEB.auth, mode: 'password', directory: { path: 'auth/users.example.yml' } },
      },
      webToken: WEB_TOKEN,
      serverCsrf: SERVER_CSRF,
      warn: () => undefined,
    } as never)

    const ok = await runtime.login({ userId: 'u-1', password: 'demo1234', ip: '10.0.0.2' })
    expect(ok.ok).toBe(true)
    expect(calls).toEqual([['s-auth-bind', 'u-1', 'session-auth']])

    // 失败不绑：成功那次的 reset 已清掉桶，这里不会撞退避
    const failed = await runtime.login({ userId: 'u-1', password: 'wrong', ip: '10.0.0.2' })
    expect(failed.ok).toBe(false)
    expect(calls).toHaveLength(1)
  })
})
