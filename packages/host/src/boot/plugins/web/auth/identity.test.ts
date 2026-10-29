/**
 * 身份解析（租户与鉴权 02 · TA-24）。
 *
 * 三种模式各一条，外加两条"绝不 500"的边界：坏 cookie、会话里的租户与进程不一致。
 * 角色顺序也要断言（`ROLES` 固定序是审计哈希稳定的前提，01 TA-10 的不变量 2）。
 */

import { describe, expect, it } from 'vitest'

import { parseTenantId } from '@bah/util'

import type { IncomingMessage } from 'node:http'

import { createSessionStore } from './session-store.ts'
import { createAuthRuntime } from './identity.ts'
import { createStaticIdentifier } from './static.ts'
import { createThrottle } from './throttle.ts'

const TENANT = 'demo'
const SERVER_CSRF = 'process-csrf'
const SERVICE_TOKEN = 'tok-web'
const OPERATOR_TOKEN = 'tok-op'
const NOW = 1_700_000_000_000

/** static 双凭证识别器（T-06）：`svc:web=customer` / `svc:operator=agent`。 */
const staticIdentify = createStaticIdentifier({
  tenantId: parseTenantId(TENANT),
  webToken: SERVICE_TOKEN,
  operatorToken: OPERATOR_TOKEN,
})

/** 造一个请求桩（只填 identify 会读的字段）。 */
function request(headers: Record<string, string> = {}, url = '/api/session'): IncomingMessage {
  return { headers, method: 'GET', url, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage
}

/** 造一个运行期。 */
function runtime(mode: 'none' | 'static' | 'password', withSession?: { sid: string; csrf: string }) {
  const store = createSessionStore({
    now: () => NOW,
    idleMs: 60_000,
    absoluteMs: 600_000,
    randomToken: (() => {
      let next = 0
      return () => {
        next += 1
        return `tok-${String(next)}`
      }
    })(),
    warn: () => undefined,
  })
  const session = withSession === undefined ? undefined : undefined
  void session
  return createAuthRuntime({
    mode,
    tenantId: TENANT,
    now: () => NOW,
    sessions: store,
    throttle: createThrottle({ maxFailures: 5, lockMs: 1_000, backoffBaseMs: 1_000, backoffMaxMs: 2_000 }),
    serverCsrf: SERVER_CSRF,
    staticIdentify,
    absoluteMs: 600_000,
    cookieName: 'bah_sid',
    cookieSecure: false,
  })
}

describe('identify · 三种模式', () => {
  it('TA-24-1 static：客户凭证 → svc:web / customer（不含坐席角色）', () => {
    const auth = runtime('static')
    const identity = auth.identify(request({ authorization: `Bearer ${SERVICE_TOKEN}` }), NOW)
    expect(identity.kind).toBe('service')
    if (identity.kind !== 'service') throw new Error('unreachable')
    expect(identity.principal.userId).toBe('svc:web')
    expect(identity.principal.roles).toEqual(['customer'])
    // 管理面靠独立 admin token（双因子）：服务主体不许含 admin
    expect(identity.principal.roles).not.toContain('admin')
    expect(auth.csrfExpectation(identity)).toBe(SERVER_CSRF)
  })

  it('TA-24-1b static：坐席凭证 → svc:operator / agent（客户动作被角色门挡下）', () => {
    const auth = runtime('static')
    const identity = auth.identify(request({ authorization: `Bearer ${OPERATOR_TOKEN}` }), NOW)
    expect(identity.kind).toBe('service')
    if (identity.kind !== 'service') throw new Error('unreachable')
    expect(identity.principal.userId).toBe('svc:operator')
    expect(identity.principal.roles).toEqual(['agent'])
    expect(identity.principal.roles).not.toContain('customer')
  })

  it('TA-24-2 static：缺凭证 / 错凭证 → anonymous（不抛）', () => {
    const auth = runtime('static')
    expect(auth.identify(request(), NOW).kind).toBe('anonymous')
    expect(auth.identify(request({ authorization: 'Bearer wrong' }), NOW).kind).toBe('anonymous')
  })

  it('TA-24-3 password：无 cookie → anonymous；坏 cookie → anonymous（不是 500）', () => {
    const auth = runtime('password')
    expect(auth.identify(request(), NOW).kind).toBe('anonymous')
    expect(auth.identify(request({ cookie: 'bah_sid=%E0%A4%A' }), NOW).kind).toBe('anonymous')
    expect(auth.identify(request({ cookie: 'bah_sid=nope' }), NOW).kind).toBe('anonymous')
  })

  it('TA-24-4 none：恒为 service（合成主体；角色收窄到 customer，不含 agent）', () => {
    const auth = runtime('none')
    const identity = auth.identify(request(), NOW)
    expect(identity.kind).toBe('service')
    if (identity.kind !== 'service') throw new Error('unreachable')
    // T-06.2：`none` 不许带 agent——否则无凭证请求能打坐席 API
    expect(identity.principal.roles).toEqual(['customer'])
  })

  it('TA-24-5 password + 有效 cookie → principal，CSRF 期望值是该会话的', async () => {
    const store = createSessionStore({
      now: () => NOW,
      idleMs: 60_000,
      absoluteMs: 600_000,
      randomToken: (() => {
        let next = 0
        return () => {
          next += 1
          return `tok-${String(next)}`
        }
      })(),
      warn: () => undefined,
    })
    const auth = createAuthRuntime({
      mode: 'password',
      tenantId: TENANT,
      now: () => NOW,
      sessions: store,
      throttle: createThrottle({ maxFailures: 5, lockMs: 1_000, backoffBaseMs: 1_000, backoffMaxMs: 2_000 }),
      serverCsrf: SERVER_CSRF,
      staticIdentify: () => undefined,
      absoluteMs: 600_000,
      cookieName: 'bah_sid',
      cookieSecure: false,
    })
    const session = store.issue({ tenantId: TENANT, userId: 'u-1', roles: ['customer'] })
    const identity = auth.identify(request({ cookie: `bah_sid=${session.sid}` }), NOW)
    expect(identity.kind).toBe('principal')
    if (identity.kind !== 'principal') throw new Error('unreachable')
    expect(identity.principal.userId).toBe('u-1')
    expect(identity.principal.roles).toEqual(['customer'])
    expect(auth.csrfExpectation(identity)).toBe(session.csrf)
    expect(auth.csrfExpectation(identity)).not.toBe(SERVER_CSRF)
  })

  it('TA-24-6 会话里的租户与进程不一致 → anonymous（搬了日志不认）', () => {
    const store = createSessionStore({
      now: () => NOW,
      idleMs: 60_000,
      absoluteMs: 600_000,
      randomToken: (() => {
        let next = 0
        return () => {
          next += 1
          return `tok-${String(next)}`
        }
      })(),
      warn: () => undefined,
    })
    const auth = createAuthRuntime({
      mode: 'password',
      tenantId: TENANT,
      now: () => NOW,
      sessions: store,
      throttle: createThrottle({ maxFailures: 5, lockMs: 1_000, backoffBaseMs: 1_000, backoffMaxMs: 2_000 }),
      serverCsrf: SERVER_CSRF,
      staticIdentify: () => undefined,
      absoluteMs: 600_000,
      cookieName: 'bah_sid',
      cookieSecure: false,
    })
    const foreign = store.issue({ tenantId: 'acme', userId: 'u-9', roles: ['agent'] })
    expect(auth.identify(request({ cookie: `bah_sid=${foreign.sid}` }), NOW).kind).toBe('anonymous')
    void parseTenantId
  })
})
