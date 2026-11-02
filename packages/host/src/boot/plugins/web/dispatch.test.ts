/**
 * 分派矩阵（W16 复审补的用例）：方法 × 路径 × 凭证形态 → 状态码。
 *
 * 为什么值钱：`web.test.ts` 的 53 例覆盖的是**业务语义**（审批、HALT、静态穿越），
 * 而拆分最容易搬丢的是**闸的顺序**——它只在异常组合里暴露：未知 `/api/*` 要不要凭证、
 * CSRF 与 405 谁先、管理面的"路由存在性"是否排在方法之前。这些组合没有业务故事，
 * 不会有人为它们写用例，只能靠矩阵。
 *
 * 不启真端口：直接调 `createDispatcher`，用最小 req/res 桩。这样每个格子都能跑，
 * 也是"闸只有一处、路由表可数据化"的直接收益（拆分前这段逻辑在 600 行闭包里，测不动）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { SessionApi } from '@bah/runtime'
import type { WebChannelAdapter } from '@bah/channels'
import { createRecorder, type TelemetrySpan } from '@bah/telemetry'
import { afterEach, describe, expect, it } from 'vitest'

import type { TelemetryHandle } from '../telemetry.ts'

import { ADMIN_OPERATORS_ENV, ADMIN_TOKEN_ENV } from '../web-admin.ts'
import { resolveWebSettings } from './config.ts'
import type { RateLimiter, WebDeps, WebRequest } from './deps.ts'
import { createDispatcher } from './dispatch.ts'
import { handleAdmin } from './handlers/admin.ts'
import type { SseHub } from './sse.ts'
import { DEFAULT_TENANT_ID, normalizePrincipal } from '@bah/util'
import { tokenMatches } from '../web-admin.ts'
import { presentedWebToken } from '../web-auth.ts'
import type { AuthRuntime, RequestIdentity } from './auth/index.ts'
import type { AuthSession } from './auth/session-store.ts'

/** 测试固定的凭证（生产未配置时随机生成）。 */
const WEB_TOKEN = 'tok-web'
const CSRF_TOKEN = 'tok-csrf'
const ADMIN_TOKEN = 'tok-admin'

/** 抓到的响应。 */
interface Probe {
  status: number
  headers: Record<string, unknown>
  body: string
}

/** 最小响应桩：只实现 `sendJson` / `sendError` 用到的那几个方法。 */
function makeRes(): { res: ServerResponse; probe: Probe } {
  const probe: Probe = { status: 0, headers: {}, body: '' }
  const res = {
    writableEnded: false,
    once(): unknown {
      // 遥测包裹点会挂 `res.once('close')`；矩阵测试不关心 span 收尾。
      return res
    },
    get headersSent(): boolean {
      return probe.status !== 0
    },
    setHeader(name: string, value: unknown): unknown {
      probe.headers[name.toLowerCase()] = value
      return res
    },
    writeHead(status: number, headers: Record<string, unknown> = {}): unknown {
      probe.status = status
      for (const [key, value] of Object.entries(headers)) probe.headers[key.toLowerCase()] = value
      return res
    },
    write(chunk: unknown): boolean {
      probe.body += String(chunk)
      return true
    },
    end(chunk?: unknown): unknown {
      if (chunk !== undefined) probe.body += String(chunk)
      return res
    },
  }
  return { res: res as unknown as ServerResponse, probe }
}

/** 最小请求桩：`readJson` 靠 `for await` 读体，所以必须给出异步迭代器。 */
function makeReq(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:7331', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      for (const chunk of chunks) yield chunk
    },
  }
  return req as unknown as IncomingMessage
}

/** 一组够用的依赖（缺省：无 agent、无 sentry、无 halt、静态根不存在）。 */
function makeDeps(overrides: Partial<WebDeps> = {}): WebDeps {
  const rateLimiter: RateLimiter = { check: () => ({ ok: true, retryAfterSec: 0 }) }
  const hub: SseHub = {
    publish: () => undefined,
    publishFault: () => undefined,
    attach: () => undefined,
    size: () => 0,
    dispose: () => undefined,
  }
  const adapter = {
    capabilities: { richCards: true, buttons: true, forms: true, images: true, streaming: true },
    pendingTickets: () => [],
    // 与真适配器同口径：空文本在 `inbound` 就抛，handler 翻成 400（不是 500）
    inbound: ({ text }: { text: string }) => {
      if (text.length === 0) throw new Error('web: 空文本')
      return { text }
    },
    decide: () => ({ ok: true }),
    verify: () => Promise.resolve({ ok: true }),
    attachApproval: () => undefined,
    dispose: () => undefined,
  }
  const session = { sessionId: 's-matrix', lastSeq: () => 0, events: () => [] }
  return {
    session: session as unknown as SessionApi,
    tenantId: DEFAULT_TENANT_ID,
    // 闸顺序的用例只关心"有没有身份"：给一个 static 模式的合成运行期，
    // 真实的解析规则在 identity.test.ts 里逐条验（这里不重复）
    auth: createStaticAuthRuntime(DEFAULT_TENANT_ID, WEB_TOKEN, CSRF_TOKEN),
    adapter: adapter as unknown as WebChannelAdapter,
    hub,
    // C5：矩阵测试只关心闸的顺序，接管状态给一个"永不接管"的桩
    handoff: {
      active: false,
      slaMs: 0,
      enter: () => ({ ok: false, code: 'handoff-already-active' }),
      resume: () => ({ ok: false, code: 'handoff-not-active' }),
      claim: () => ({ ok: false, code: 'handoff-not-active' }),
      say: () => ({ ok: false, code: 'handoff-not-active' }),
      heartbeat: () => ({ waitedMs: 0, overdue: false }),
      summary: () => ({
        active: false,
        sessionId: 's-matrix',
        lastSeq: 0,
        turns: 0,
        pendingTickets: 0,
        messages: [],
        waitedMs: 0,
        overdue: false,
        claimed: false,
        turnsSinceHandoff: 0,
        operatorMessages: 0,
      }),
    },
    webToken: WEB_TOKEN,
    // 缺省不配坐席面（operator 路由 404）；需要 operator 的用例用 overrides 覆盖
    operatorToken: undefined,
    operatorName: '坐席',
    csrfToken: CSRF_TOKEN,
    rateLimiter,
    now: () => 1_700_000_000_000,
    firstAgent: () => undefined,
    ensureDriver: () => undefined,
    trySentry: () => undefined,
    tryHalt: () => undefined,
    // 矩阵测试只关心闸的顺序：不给审计 / 遥测 / SLO（读取器都必须能判空后静默返回）
    tryAudit: () => undefined,
    tryTelemetry: () => undefined,
    trySlo: () => undefined,
    trySuggest: () => undefined,
    // 交易密码端口（ADR-0014）：矩阵测试不装银行包 ⇒ 端点回 501，闸顺序不受影响
    tryPassword: () => undefined,
    staticRoot: 'this-directory-does-not-exist',
    // ：单个 indexPath 泛化为 token 入口白名单（D3）；矩阵测试不落盘
    defaultEntry: 'this-directory-does-not-exist/index.html',
    tokenEntries: ['this-directory-does-not-exist/index.html'],
    operatorEntry: 'this-directory-does-not-exist/operator.html',
    seatEnabled: true,
    seatApiEnabled: true,
    ...overrides,
  }
}

/** 调一次分派，拿响应。 */
async function call(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string; deps?: WebDeps; remote?: string } = {},
): Promise<Probe> {
  const deps = options.deps ?? makeDeps()
  const handle = createDispatcher(resolveWebSettings({}), deps)
  const { res, probe } = makeRes()
  await handle(makeReq(method, path, options.headers ?? {}, options.body, options.remote), res)
  return probe
}

/** 同源 Origin（CSRF 的放行路径之一）。 */
const SAME_ORIGIN = { origin: 'http://127.0.0.1:7331' }
/** 带 Web 凭证 + 同源的请求头。 */
const AUTHED = { authorization: `Bearer ${WEB_TOKEN}`, ...SAME_ORIGIN }

/** 取错误码（成功响应没有 `error`）。 */
function codeOf(probe: Probe): string | undefined {
  if (probe.body.length === 0) return undefined
  const parsed = JSON.parse(probe.body) as { error?: { code?: string } }
  return parsed.error?.code
}

/** 管理 token 的注入与还原（`guardAdmin` 现读 `process.env`）。 */
const previousAdminToken = process.env[ADMIN_TOKEN_ENV]
const previousAdminOperators = process.env[ADMIN_OPERATORS_ENV]

afterEach(() => {
  if (previousAdminToken === undefined) delete process.env[ADMIN_TOKEN_ENV]
  else process.env[ADMIN_TOKEN_ENV] = previousAdminToken
  if (previousAdminOperators === undefined) delete process.env[ADMIN_OPERATORS_ENV]
  else process.env[ADMIN_OPERATORS_ENV] = previousAdminOperators
})

describe('W16 分派矩阵 · 无凭证', () => {
  it('探活公开，其余 /api/* 一律 401（含不存在的路径）', async () => {
    expect((await call('GET', '/api/health')).status).toBe(200)
    expect((await call('GET', '/api/session')).status).toBe(401)
    // 关键：未命中的 /api/* 也必须先过凭证，否则"打一个不存在的接口"就是免鉴权探测
    expect((await call('GET', '/api/unknown')).status).toBe(401)
    expect((await call('POST', '/api/unknown')).status).toBe(401)
    expect(codeOf(await call('GET', '/api/session'))).toBe('web-unauthorized')
  })

  it('管理面在没配 token 时一律 404——连方法都不告诉扫描器', async () => {
    delete process.env[ADMIN_TOKEN_ENV]
    expect((await call('POST', '/api/admin/halt')).status).toBe(404)
    expect((await call('GET', '/api/admin/halt')).status).toBe(404)
    expect((await call('POST', '/api/admin/sentry/unfreeze')).status).toBe(404)
  })
})

describe('W16 分派矩阵 · 有 Web 凭证', () => {
  it('业务 GET 通行；未知 GET 落到静态兜底（404，不是 405）', async () => {
    expect((await call('GET', '/api/session', { headers: AUTHED })).status).toBe(200)
    const unknown = await call('GET', '/api/unknown', { headers: AUTHED })
    expect(unknown.status).toBe(404)
    expect(codeOf(unknown)).toBe('web-not-found')
    // POST 专用的票据路由，GET 打过来同样是静态兜底的 404
    expect((await call('GET', '/api/approval/t-1', { headers: AUTHED })).status).toBe(404)
  })

  it('CSRF 在 Bearer 之后、405 之前：缺令牌 403、不匹配 403、放行后才轮到方法', async () => {
    const required = await call('POST', '/api/turn', {
      headers: { authorization: `Bearer ${WEB_TOKEN}` },
      body: '{}',
    })
    expect(required.status).toBe(403)
    expect(codeOf(required)).toBe('web-csrf-required')

    const forbidden = await call('POST', '/api/turn', {
      headers: {
        authorization: `Bearer ${WEB_TOKEN}`,
        cookie: `bah_csrf=${CSRF_TOKEN}`,
        'x-bah-csrf': 'wrong',
      },
      body: '{}',
    })
    expect(forbidden.status).toBe(403)
    expect(codeOf(forbidden)).toBe('web-csrf-forbidden')

    // 同源 Origin 放行 CSRF，但 PUT 不是 /api/turn 的方法 → 405（不是 403）
    const wrongMethod = await call('PUT', '/api/turn', { headers: AUTHED, body: '{}' })
    expect(wrongMethod.status).toBe(405)
    expect(codeOf(wrongMethod)).toBe('web-method-not-allowed')
  })

  it('double-submit：cookie 与头一致即通过（curl 之外的第二种客户端）', async () => {
    // 注：`/api/turn` 先看有没有活体 agent（503）再读体，所以这条要给一个假 agent 才走得到 400
    const withAgent = makeDeps({ firstAgent: () => ({ send: () => undefined }) as never })
    const probe = await call('POST', '/api/turn', {
      headers: {
        authorization: `Bearer ${WEB_TOKEN}`,
        cookie: `bah_csrf=${CSRF_TOKEN}`,
        'x-bah-csrf': CSRF_TOKEN,
      },
      body: '{}',
      deps: withAgent,
    })
    // 放过了 CSRF，才会看到业务码：空文本 → 400
    expect(probe.status).toBe(400)
    expect(codeOf(probe)).toBe('web-empty-message')
  })
  it('业务码：无 agent → 503；有 agent → 202；审批与验证 → 200', async () => {
    expect((await call('POST', '/api/turn', { headers: AUTHED, body: '{"text":"你好"}' })).status).toBe(503)

    const agent = {
      send: () => undefined,
      drive: () => new Promise<void>(() => undefined),
    }
    const withAgent = makeDeps({ firstAgent: () => agent as never })
    const accepted = await call('POST', '/api/turn', {
      headers: AUTHED,
      body: '{"text":"你好"}',
      deps: withAgent,
    })
    expect(accepted.status).toBe(202)

    expect((await call('POST', '/api/approval/t-1', { headers: AUTHED, body: '{}' })).status).toBe(200)
    expect((await call('POST', '/api/verify/t-1', { headers: AUTHED })).status).toBe(200)
  })

  it('审批的 409 分支（已决 / 过期）：文档承诺过，本次复审前没有用例', async () => {
    for (const code of ['already-decided', 'expired'] as const) {
      const adapter = {
        decide: () => ({ ok: false, code, reason: '票据不可用' }),
        verify: () => Promise.resolve({ ok: true }),
      }
      const probe = await call('POST', '/api/approval/t-1', {
        headers: AUTHED,
        body: '{}',
        deps: makeDeps({ adapter: adapter as never }),
      })
      expect(probe.status).toBe(409)
      expect(codeOf(probe)).toBe(code)
    }
  })

  it('审批的 400 分支：适配器返回未知码时兜底 400，不默认 200', async () => {
    const adapter = {
      decide: () => ({ ok: false, code: 'bad-request', reason: '结论格式不对' }),
      verify: () => Promise.resolve({ ok: true }),
    }
    const probe = await call('POST', '/api/approval/t-1', {
      headers: AUTHED,
      body: '{}',
      deps: makeDeps({ adapter: adapter as never }),
    })
    expect(probe.status).toBe(400)
    expect(codeOf(probe)).toBe('bad-request')
  })

  it('D1：inbox 满 → 503 web-inbox-full（明确拒绝，不是 500）', async () => {
    const full = {
      send: () => {
        throw Object.assign(new Error('inbox: 待处理消息已达上限 64 条'), { code: 'inbox-full' })
      },
    }
    const probe = await call('POST', '/api/turn', {
      headers: AUTHED,
      body: '{"text":"再来一条"}',
      deps: makeDeps({ firstAgent: () => full as never }),
    })
    expect(probe.status).toBe(503)
    expect(codeOf(probe)).toBe('web-inbox-full')
  })

  it('D2 指标端点：与业务路由同闸（401），有凭证时从事件现算、不出原文', async () => {
    // 无凭证 → 401：指标里有成本与审批分布，不能公开
    expect((await call('GET', '/api/metrics')).status).toBe(401)

    const events = [
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'tool/call', data: { callId: 'c-1', name: 'account_balance', tier: { level: 'green' } } },
      { type: 'tool/result', data: { callId: 'c-1', isError: false, durationMs: 10 } },
      { type: 'tool/result', data: { callId: 'c-2', isError: true, durationMs: 30 } },
      { type: 'approval/asked', data: { ticketId: 't-1', callId: 'c-1', name: 'transfer_create' } },
      { type: 'approval/decided', data: { ticketId: 't-1', decision: 'approved' } },
      { type: 'approval/decided', data: { ticketId: 't-2', decision: 'rejected' } },
      // 无人值守默认拒绝 / 超时等一律记"其它"：不能并进 rejected（"没人点" ≠ "人点了拒绝"）
      { type: 'approval/decided', data: { ticketId: 't-3', decision: 'unavailable' } },
      // 耗时分位只吃数字：脏值不能被 push 进样本（否则分位数出现 NaN）
      { type: 'tool/result', data: { callId: 'c-3', isError: false, durationMs: '12' } },
      // 策略维度：全部从事件现算（版本取判决发生时的版本，不是当前 active）
      {
        type: 'tier/decided',
        data: {
          callId: 'c-1',
          name: 'transfer_create',
          level: 'yellow',
          reason: 'declared',
          verdict: 'ask',
          at: 1,
          policyVersion: 'legacy',
          ruleIds: [],
          paramsDigest: 'sha256:x',
          engineSource: 'legacy',
        },
      },
      { type: 'policy/bundle-loaded', data: { kind: 'bank.tier', handle: 'bank-tier/1.0.0' } },
      { type: 'policy/reload-rejected', data: { kind: 'bank.tier', code: 'policy-state-invalid' } },
      { type: 'policy/shadow-diff', data: { kind: 'bank.tier', changed: ['level'] } },
      // 不认识的会话事件必须被跳过，而不是让指标端点 500
      { type: 'unknown/event', data: { anything: true } },
      {
        type: 'usage/summary',
        data: { turn: 1, input: 100, output: 20, calls: 1, cachedInput: 5, costMicroYuan: 42 },
      },
    ]
    const session = {
      sessionId: 's-metrics',
      lastSeq: () => 7,
      events: () => events,
    }
    const probe = await call('GET', '/api/metrics', {
      headers: AUTHED,
      deps: makeDeps({
        session: session as never,
        // HALT 装了且处于停机态：`reason` 必须透出（null 只表示"没装 HALT"）
        tryHalt: () =>
          ({
            enabled: true,
            status: 'HALTED',
            halted: true,
            reason: 'manual',
          }) as never,
      }),
    })
    expect(probe.status).toBe(200)
    const body = JSON.parse(probe.body) as Record<string, unknown>
    expect(body).toMatchObject({
      sessionId: 's-metrics',
      lastSeq: 7,
      turns: 1,
      tools: { calls: 1, errors: 1, durationMs: { p50: 10, p95: 30 } },
      approvals: { asked: 1, approved: 1, rejected: 1, other: 1 },
      policy: {
        decisions: 1,
        byVersion: { legacy: 1 },
        byVerdict: { ask: 1 },
        byReason: { declared: 1 },
        engineErrors: 0,
        legacyDecisions: 1,
        shadowDiffs: 1,
        reloads: 1,
        reloadRejected: 1,
      },
      usage: { input: 100, output: 20, cachedInput: 5, costMicroYuan: 42 },
      halt: { status: 'HALTED', halted: true, reason: 'manual' },
      sseClients: 0,
    })
    // 只出数字：事件里的工具名/内容不会原样进指标
    expect(probe.body).not.toContain('account_balance')
    // 02：既有 10 键之外新增 9 段；cost 的整数口径与既有 usage 同源
    for (const key of ['http', 'llm', 'cost', 'plan', 'slo', 'process', 'telemetry', 'logs', 'alerts']) {
      expect(body, `缺少新段 ${key}`).toHaveProperty(key)
    }
    expect(body.cost).toMatchObject({ configured: false, currency: 'micro_yuan', total: 42 })
    expect((body.cost as { budget: { turn: unknown } }).budget.turn).toBeNull()

    /**
     * 两种"空"必须能分开，且都不能伪装成数字 0：
     * - 没有样本 → 分位数 null（"没有样本" ≠ "很快"）
     * - 没装 HALT → halt null（"没装" ≠ "未停机"）；装了但没写理由 → reason null
     */
    const empty = await call('GET', '/api/metrics', { headers: AUTHED })
    const emptyBody = JSON.parse(empty.body) as {
      tools: { durationMs: { p50: unknown; p95: unknown } }
      halt: unknown
    }
    expect(emptyBody.tools.durationMs).toEqual({ p50: null, p95: null })
    expect(emptyBody.halt).toBeNull()

    const haltedNoReason = await call('GET', '/api/metrics', {
      headers: AUTHED,
      deps: makeDeps({
        tryHalt: () => ({ enabled: true, status: 'RUNNING', halted: false }) as never,
      }),
    })
    expect((JSON.parse(haltedNoReason.body) as { halt: unknown }).halt).toEqual({
      status: 'RUNNING',
      halted: false,
      reason: null,
    })
  })

  it('?format=prometheus 走文本出口；xml 明确 400', async () => {
    const prom = await call('GET', '/api/metrics?format=prometheus', { headers: AUTHED })
    expect(prom.status).toBe(200)
    expect(String(prom.headers['content-type'])).toContain('text/plain')
    expect(prom.body.startsWith('# HELP bah_up ')).toBe(true)

    const bad = await call('GET', '/api/metrics?format=xml', { headers: AUTHED })
    expect(bad.status).toBe(400)
    expect(codeOf(bad)).toBe('metrics-format-unsupported')
  })

  it('/api/trace：未装遥测 503；JSON 森林 / Chrome 裸数组 / 非法 limit 400', async () => {
    const unavailable = await call('GET', '/api/trace', { headers: AUTHED })
    expect(unavailable.status).toBe(503)
    expect(codeOf(unavailable)).toBe('trace-unavailable')

    const span: TelemetrySpan = {
      traceId: 't'.repeat(32),
      spanId: 's'.repeat(16),
      parentSpanId: null,
      name: 'turn',
      startMs: 1,
      endMs: 2,
      status: 'ok',
      attributes: { turn: 1 },
      source: 'derived',
    }
    const handle = {
      recorder: createRecorder({ sessionId: 's-trace', now: () => 1 }),
      stats: { size: 1, dropped: 0, droppedErrors: 0, exportErrors: 0, attributeErrors: 0, sampledOut: 0 },
      derive: () => ({ spans: [span], roots: [], clockTrusted: false }),
    } as unknown as TelemetryHandle

    const json = await call('GET', '/api/trace', {
      headers: AUTHED,
      deps: makeDeps({ tryTelemetry: () => handle }),
    })
    expect(json.status).toBe(200)
    const body = JSON.parse(json.body) as { clock: string; stats: { spans: number } }
    expect(body.clock).toBe('frozen')
    expect(body.stats.spans).toBe(1)

    const chrome = await call('GET', '/api/trace?format=chrome', {
      headers: AUTHED,
      deps: makeDeps({ tryTelemetry: () => handle }),
    })
    expect(chrome.status).toBe(200)
    expect(Array.isArray(JSON.parse(chrome.body))).toBe(true)

    const badLimit = await call('GET', '/api/trace?limit=0', {
      headers: AUTHED,
      deps: makeDeps({ tryTelemetry: () => handle }),
    })
    expect(badLimit.status).toBe(400)
    expect(codeOf(badLimit)).toBe('trace-limit-invalid')
  })

  it('管理面 default 分支：路由表外的路径 → 404（将来新增路径不会静默成功）', async () => {
    const { res, probe } = makeRes()
    const request = { method: 'POST', path: '/api/admin/not-in-table', rest: '' } as WebRequest
    await handleAdmin(makeReq('POST', request.path, {}, '{}'), res, request, makeDeps())
    expect(probe.status).toBe(404)
    expect(codeOf(probe)).toBe('web-not-found')
  })

  it('HEAD 与 DELETE：HEAD 走静态（404），DELETE 落到 405', async () => {
    expect((await call('HEAD', '/', { headers: AUTHED })).status).toBe(404)
    expect((await call('DELETE', '/api/health', { headers: AUTHED })).status).toBe(405)
  })

  it('限流命中 → 429 且带 retry-after（在凭证之前）', async () => {
    const limited = makeDeps({
      rateLimiter: { check: () => ({ ok: false, retryAfterSec: 7 }) },
    })
    const probe = await call('GET', '/api/session', { deps: limited })
    expect(probe.status).toBe(429)
    expect(probe.headers['retry-after']).toBe('7')
    expect(codeOf(probe)).toBe('web-rate-limited')
  })
})

describe('W16 分派矩阵 · 管理面', () => {
  it('路由存在性 → 来源 → 方法 → token 的顺序', async () => {
    process.env[ADMIN_TOKEN_ENV] = ADMIN_TOKEN
    const adminAuth = { authorization: `Bearer ${ADMIN_TOKEN}` }

    // ① 缺 token：401（不是 403，也不是 405）
    expect((await call('POST', '/api/admin/halt', { body: '{}' })).status).toBe(401)
    // ② 非回环：403，且不看 token
    const foreign = await call('POST', '/api/admin/halt', {
      headers: adminAuth,
      body: '{}',
      remote: '10.1.2.3',
    })
    expect(foreign.status).toBe(403)
    expect(codeOf(foreign)).toBe('web-admin-forbidden')
    // ③ 方法错：405（排在 404 之后，说明"路由存在"已被确认）
    expect((await call('GET', '/api/admin/halt', { headers: adminAuth })).status).toBe(405)
    // ④ 全对但 profile 没有 halt 服务：503（不是 500）
    expect((await call('POST', '/api/admin/halt', { headers: adminAuth, body: '{}' })).status).toBe(503)
  })

  it('管理面豁免 CSRF：CLI 没有 Origin 也能过闸', async () => {
    process.env[ADMIN_TOKEN_ENV] = ADMIN_TOKEN
    const probe = await call('POST', '/api/admin/sentry/unfreeze', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: '{"reason":"演练"}',
    })
    // 没有 CSRF 令牌也该走到业务：没有 sentry 服务 → 503 sentry-absent
    expect(probe.status).toBe(503)
    expect(codeOf(probe)).toBe('sentry-absent')
  })

  it('管理面之外的 /api/admin/* 不是管理路由：回到 Web 的闸', async () => {
    process.env[ADMIN_TOKEN_ENV] = ADMIN_TOKEN
    // 未命中管理表 → 要吃 Web 凭证；带上 Web 凭证 + 同源 → 405
    const probe = await call('POST', '/api/admin/haltx', { headers: AUTHED, body: '{}' })
    expect(probe.status).toBe(405)
    // 不带 Web 凭证 → 401（管理 token 对它无效）
    const unauth = await call('POST', '/api/admin/haltx', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: '{}',
    })
    expect(unauth.status).toBe(401)
  })

  it('03 TA-44：操作员表坏配置 → 503（fail-closed），非回环仍 403（不泄漏存在性）', async () => {
    delete process.env[ADMIN_TOKEN_ENV]
    process.env[ADMIN_OPERATORS_ENV] = '{not json'
    const loopback = await call('POST', '/api/admin/sentry/unfreeze', {
      headers: { authorization: 'Bearer whatever' },
      body: '{}',
    })
    expect(loopback.status).toBe(503)
    expect(codeOf(loopback)).toBe('web-admin-unavailable')

    const foreign = await call('POST', '/api/admin/sentry/unfreeze', {
      headers: { authorization: 'Bearer whatever' },
      body: '{}',
      remote: '10.1.2.3',
    })
    expect(foreign.status).toBe(403)
    expect(codeOf(foreign)).toBe('web-admin-forbidden')
  })
})

describe('channel:web 配置面', () => {
  it('csrf 不是对象 / enabled 不是布尔 → web-invalid-config（配置错误不许静默放行）', () => {
    expect(() => resolveWebSettings({ csrf: 'off' })).toThrow(/csrf 必须是对象/)
    expect(() => resolveWebSettings({ csrf: null })).toThrow(/csrf 必须是对象/)
    expect(() => resolveWebSettings({ csrf: [] })).toThrow(/csrf 必须是对象/)
    expect(() => resolveWebSettings({ csrf: { enabled: 'yes' } })).toThrow(/布尔/)
  })
})

describe('D6 畸形百分号编码：输入错不许报成服务错', () => {
  // `decodeURIComponent('%E0%A4%A')` 抛 URIError；不接住就冒成 500。
  // 两条入口都要覆盖：静态兜底（GET 任意路径）与票据前缀路由。
  const MALFORMED = '/%E0%A4%A'

  it('静态兜底：畸形路径 → 400 web-invalid-path（不是 500，也不是 404）', async () => {
    const probe = await call('GET', MALFORMED, { headers: AUTHED })
    expect(probe.status).toBe(400)
    expect(codeOf(probe)).toBe('web-invalid-path')
  })

  it('票据入口：批准与强验证都 → 400 web-invalid-ticket', async () => {
    for (const path of [`/api/approval${MALFORMED}`, `/api/verify${MALFORMED}`]) {
      const probe = await call('POST', path, { headers: AUTHED, body: '{}' })
      expect(probe.status, path).toBe(400)
      expect(codeOf(probe), path).toBe('web-invalid-ticket')
    }
  })

  it('闸顺序没被绕过：畸形路径仍然先吃凭证（401 而不是 400）', async () => {
    expect((await call('POST', `/api/approval${MALFORMED}`, { body: '{}' })).status).toBe(401)
  })
})

describe('03 TA-42 · 授权接进 dispatch（一个调用点）', () => {
  /** 单角色主体。 */
  function identityWith(role: 'customer' | 'agent' | 'auditor' | 'admin'): RequestIdentity {
    const principal = normalizePrincipal({
      tenantId: DEFAULT_TENANT_ID,
      userId: 'u-1',
      roles: [role],
      source: 'session-auth',
    })
    const session: AuthSession = {
      sid: 'sid-1',
      tenantId: DEFAULT_TENANT_ID,
      userId: 'u-1',
      roles: [role],
      csrf: CSRF_TOKEN,
      issuedAt: 0,
      lastSeenAt: 0,
      absoluteExpiresAt: 1_000,
    }
    return { kind: 'principal', principal, session }
  }

  /** 恒返回给定身份的运行期（password 模式，便于复现"没有 cookie"的匿名态）。 */
  function fixedRuntime(identity: RequestIdentity): AuthRuntime {
    return {
      mode: 'password',
      cookie: { name: 'bah_sid', secure: false, maxAgeSec: 60 },
      identify: () => identity,
      csrfExpectation: () => CSRF_TOKEN,
      login: async () => ({ ok: false, code: 'web-login-failed' }),
      logout: () => false,
    }
  }

  it('TA-42-1 未知 GET /api/*（无 cookie，password 模式）→ 401，不是 404', async () => {
    const deps = makeDeps({ auth: fixedRuntime({ kind: 'anonymous' }) })
    const probe = await call('GET', '/api/unknown', { deps })
    expect(probe.status).toBe(401)
    expect(codeOf(probe)).toBe('web-unauthorized')
  })

  it('TA-42-2 未知 POST /api/*（无 cookie）→ 401（先身份后 405）', async () => {
    const deps = makeDeps({ auth: fixedRuntime({ kind: 'anonymous' }) })
    const probe = await call('POST', '/api/unknown', { deps, body: '{}' })
    expect(probe.status).toBe(401)
    expect(codeOf(probe)).toBe('web-unauthorized')
  })

  it('TA-42-3 非 API 的未知路径不被授权闸误伤：POST /foo → 405（不是 401）', async () => {
    const deps = makeDeps({ auth: fixedRuntime({ kind: 'anonymous' }) })
    const probe = await call('POST', '/foo', { deps, body: '{}' })
    expect(probe.status).toBe(405)
    expect(codeOf(probe)).toBe('web-method-not-allowed')
  })

  it('TA-42-4 auditor 调 POST /api/turn → 403 web-forbidden（角色门在 CSRF 之前）', async () => {
    const deps = makeDeps({ auth: fixedRuntime(identityWith('auditor')) })
    // 故意不给 Origin / CSRF：角色 403 必须先生效（否则越权意图会被 CSRF 的 403 掩盖）
    const probe = await call('POST', '/api/turn', { deps, body: '{"text":"查余额"}' })
    expect(probe.status).toBe(403)
    expect(codeOf(probe)).toBe('web-forbidden')
  })

  it('TA-42-4b auditor 能读 /api/session（被禁的是写，不是读）', async () => {
    const deps = makeDeps({ auth: fixedRuntime(identityWith('auditor')) })
    expect((await call('GET', '/api/session', { deps })).status).toBe(200)
  })

  it('TA-42-5 customer 调 /api/handoff/resume → 403；agent 放行到业务层（409）', async () => {
    const customer = makeDeps({ auth: fixedRuntime(identityWith('customer')) })
    const forbidden = await call('POST', '/api/handoff/resume', {
      deps: customer,
      headers: { ...SAME_ORIGIN },
      body: '{}',
    })
    expect(forbidden.status).toBe(403)
    expect(codeOf(forbidden)).toBe('web-forbidden')

    const agent = makeDeps({ auth: fixedRuntime(identityWith('agent')) })
    const allowed = await call('POST', '/api/handoff/resume', {
      deps: agent,
      headers: { ...SAME_ORIGIN },
      body: '{}',
    })
    // 放行后由状态机回答：当前没接管 → 409（不是 403）
    expect(allowed.status).toBe(409)
    expect(codeOf(allowed)).toBe('handoff-not-active')
  })

  it('TA-42-6 已认证的未知 POST /api/* → 405（授权放行，方法兜底仍生效）', async () => {
    const probe = await call('POST', '/api/unknown', { headers: AUTHED, body: '{}' })
    expect(probe.status).toBe(405)
    expect(codeOf(probe)).toBe('web-method-not-allowed')
  })

  it('TA-46-1 审批先写 approval/actor、再 decide（顺序不可反）', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      auth: fixedRuntime(identityWith('customer')),
      adapter: {
        decide: () => {
          calls.push('decide')
          return { ok: true }
        },
        verify: () => Promise.resolve({ ok: true }),
        attachApproval: () => undefined,
        dispose: () => undefined,
        pendingTickets: () => ['t-1'],
        inbound: ({ text }: { text: string }) => ({ text }),
      } as never,
      tryAudit: () =>
        ({
          append: () => undefined,
          appendActor: (ticketId: string, actor: { userId: string }) => {
            calls.push(`actor:${actor.userId}:${ticketId}`)
          },
          verifyAll: () => [],
        }) as never,
    })
    const probe = await call('POST', '/api/approval/t-1', {
      deps,
      headers: { ...SAME_ORIGIN },
      body: '{}',
    })
    expect(probe.status).toBe(200)
    expect(calls).toEqual(['actor:u-1:t-1', 'decide'])
  })

  it('TA-46-1b 合成服务主体（static 模式 svc:web）不写 approval/actor：机器决策不冒充人', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      tryAudit: () =>
        ({
          append: () => undefined,
          appendActor: (ticketId: string) => calls.push(ticketId),
          verifyAll: () => [],
        }) as never,
    })
    const probe = await call('POST', '/api/approval/t-1', {
      deps,
      headers: AUTHED,
      body: '{}',
    })
    expect(probe.status).toBe(200)
    expect(calls).toEqual([])
  })

  it('TA-46-1c 未知票号不写 actor（防已认证用户刷长审计链）', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      auth: fixedRuntime(identityWith('customer')),
      tryAudit: () =>
        ({
          append: () => undefined,
          appendActor: (ticketId: string) => calls.push(ticketId),
          verifyAll: () => [],
        }) as never,
    })
    // 默认 adapter 的 pendingTickets 为空 → 没有"待答票据"
    const probe = await call('POST', '/api/approval/t-nope', {
      deps,
      headers: { ...SAME_ORIGIN },
      body: '{}',
    })
    expect(probe.status).toBe(200)
    expect(calls).toEqual([])
  })

  it('TA-46-1d 审计写 actor 失败 → 审批仍照常落结论（证据旁路不阻断资金路径）', async () => {
    const calls: string[] = []
    const warnings: string[] = []
    const original = console.error
    // 告警走 `logJson`（console.error 一行 JSON）：抓住它才能证明失败分支真的执行了
    console.error = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '))
    }
    try {
      const deps = makeDeps({
        auth: fixedRuntime(identityWith('customer')),
        adapter: {
          decide: () => {
            calls.push('decide')
            return { ok: true }
          },
          verify: () => Promise.resolve({ ok: true }),
          attachApproval: () => undefined,
          dispose: () => undefined,
          pendingTickets: () => ['t-1'],
          inbound: ({ text }: { text: string }) => ({ text }),
        } as never,
        tryAudit: () =>
          ({
            append: () => undefined,
            appendActor: () => {
              throw new Error('audit disk full')
            },
            verifyAll: () => [],
          }) as never,
      })
      const probe = await call('POST', '/api/approval/t-1', {
        deps,
        headers: { ...SAME_ORIGIN },
        body: '{}',
      })
      expect(probe.status).toBe(200)
      expect(calls).toEqual(['decide'])
      expect(warnings.join('\n')).toContain('web.approval-actor-write-failed')
      expect(warnings.join('\n')).toContain('audit disk full')
    } finally {
      console.error = original
    }
  })
})

/**
 * 测试用：**复刻 static 模式的两个口径**——Bearer 比对与进程级 CSRF。
 *
 * 不能写成"identify 恒为 service"：那样"缺凭证 401"的用例会假绿（闸被桩绕过），
 * 而闸顺序正是这个文件唯一要证的东西。
 */
function createStaticAuthRuntime(
  tenantId: typeof DEFAULT_TENANT_ID,
  staticToken: string,
  serverCsrf: string,
): AuthRuntime {
  const principal = normalizePrincipal({
    tenantId,
    userId: 'svc:web',
    roles: ['customer', 'agent', 'auditor'],
    source: 'demo-config',
  })
  return {
    mode: 'static',
    cookie: { name: 'bah_sid', secure: false, maxAgeSec: 60 },
    identify: (req) =>
      tokenMatches(staticToken, presentedWebToken(req.headers))
        ? { kind: 'service', principal }
        : { kind: 'anonymous' },
    csrfExpectation: () => serverCsrf,
    login: async () => ({ ok: false, code: 'web-login-failed' }),
    logout: () => false,
  }
}
