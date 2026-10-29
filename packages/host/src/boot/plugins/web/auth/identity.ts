/**
 * 身份解析（租户与鉴权 02 · TA-24）：每个请求一个主体，且**只有这一处**解析。
 *
 * ## 三种身份
 *
 * | kind | 什么时候 | 主体 |
 * |---|---|---|
 * | `service` | `mode: none` / `mode: static` | 合成服务主体 `svc:web`（角色**不含** admin） |
 * | `principal` | `mode: password` 且 cookie 有效 | 真实用户（来自口令目录） |
 * | `anonymous` | 其余 | 无 |
 *
 * ## 两条不能做错的
 *
 * 1. **`identify()` 不抛**：cookie 畸形、目录读坏、会话过期都只能得到 `anonymous`。
 *    抛错会变成 500，而 500 与 401 的差异本身就是一条探测信道。
 * 2. **`csrfExpectation` 按身份取**：登录后 CSRF 轮换成会话值；若仍比对进程级旧值，
 *    用户第一次写请求就被判 403——"登录成功了但点什么都 403"的经典事故。
 *
 * ## 合成主体为什么不含 admin
 *
 * 管理面（`/api/admin/*`）走**独立的** `BAH_ADMIN_TOKEN` + 回环来源，属于双因子。
 * 把 admin 塞进服务主体等于让一个 Web 口令就能管理停机开关。这条写进 `tenant-model.md`。
 */

import { readCookie } from '../http.ts'
import { presentedWebToken } from '../../web-auth.ts'
import { normalizePrincipal, parseTenantId, sha256Hex, type Principal, type Role } from '@bah/util'

import type { IncomingMessage } from 'node:http'

import type { AuthMode } from './config.ts'
import type { UserDirectory } from './directory.ts'
import { verifyAgainstDummy, verifyPassword } from './password.ts'
import type { AuthSession, SessionStore } from './session-store.ts'
import type { Throttle } from './throttle.ts'

/** 落在审计链上的认证事实（**不是**会话事件）。 */
export interface AuthAuditEntry {
  readonly type: 'auth/login' | 'auth/logout' | 'auth/login-failed' | 'auth/login-locked'
  readonly data: Readonly<Record<string, unknown>>
  readonly subject: string
  readonly decision: 'allow' | 'deny'
}

/** 请求身份。 */
export type RequestIdentity =
  | { readonly kind: 'principal'; readonly principal: Principal; readonly session: AuthSession }
  | { readonly kind: 'service'; readonly principal: Principal }
  | { readonly kind: 'anonymous' }

/** 登录输入。 */
export interface LoginInput {
  readonly userId: string
  readonly password: string
  /** 来源地址（IP 桶用；缺省 `'unknown'`）。 */
  readonly ip?: string
}

/** 登录结果。 */
export type LoginResult =
  | { readonly ok: true; readonly session: AuthSession; readonly principal: Principal }
  | {
      readonly ok: false
      readonly code: 'web-login-failed' | 'web-login-locked'
      readonly retryAfterSec?: number
    }

/** 认证运行期（`WebDeps.auth`）。 */
export interface AuthRuntime {
  readonly mode: AuthMode
  /** 会话 cookie 的三个参数（handler 下发用；`maxAgeSec` 与绝对寿命一致）。 */
  readonly cookie: { readonly name: string; readonly secure: boolean; readonly maxAgeSec: number }
  identify(req: IncomingMessage, now: number): RequestIdentity
  /** 该身份对应的 CSRF 期望值（principal → 会话值；否则进程值）。 */
  csrfExpectation(identity: RequestIdentity): string
  login(input: LoginInput): Promise<LoginResult>
  logout(identity: RequestIdentity, now: number): boolean
}

/** 运行期装配参数。 */
export interface AuthRuntimeOptions {
  readonly mode: AuthMode
  readonly tenantId: string
  readonly now: () => number
  readonly sessions: SessionStore
  readonly throttle: Throttle
  readonly directory?: UserDirectory
  /** `none` / `static` 的进程级 CSRF（与改动前一致）。 */
  readonly serverCsrf: string
  /** `static` 模式的凭证比对（Bearer / SSE 的 `?token=`）。 */
  readonly staticTokenOk: (presented: string | undefined) => boolean
  /** 会话绝对寿命（cookie `Max-Age` 用）。 */
  readonly absoluteMs: number
  readonly cookieName: string
  readonly cookieSecure: boolean
  readonly onAudit?: (entry: AuthAuditEntry) => void
  /** 登录成功后把认证身份绑到银行身份（TA-27）。 */
  readonly onLogin?: (principal: Principal) => void
}

/** 服务主体（`none` / `static`）：角色刻意不含 admin。 */
const SERVICE_ROLES: readonly Role[] = ['customer', 'agent', 'auditor']

/**
 * 造认证运行期。
 *
 * @param options 见 {@link AuthRuntimeOptions}
 */
export function createAuthRuntime(options: AuthRuntimeOptions): AuthRuntime {
  const { mode, now, sessions, throttle, directory } = options
  const tenantId = parseTenantId(options.tenantId)

  const servicePrincipal = normalizePrincipal({
    tenantId,
    userId: 'svc:web',
    roles: SERVICE_ROLES,
    source: 'demo-config',
  })

  /** 从会话取主体；租户不一致（搬了会话日志）一律匿名。 */
  const principalOf = (session: AuthSession): Principal | undefined => {
    if (session.tenantId !== options.tenantId) return undefined
    return normalizePrincipal({
      tenantId,
      userId: session.userId,
      roles: session.roles,
      source: 'session-auth',
    })
  }

  /** 认证审计（失败只告警：审计面不能把登录打挂）。 */
  const audit = (entry: AuthAuditEntry): void => {
    try {
      options.onAudit?.(entry)
    } catch (error) {
      console.warn(`[web-auth] 认证审计写入失败（不影响登录结果）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 失败审计用的 userId 摘要（不存明文：目录里已有明文，链条目是额外暴露面）。 */
  const hashUser = (userId: string): string => sha256Hex(userId).slice(0, 12)

  return {
    mode,
    cookie: {
      name: options.cookieName,
      secure: options.cookieSecure,
      maxAgeSec: Math.floor(options.absoluteMs / 1000),
    },

    identify(req, at) {
      try {
        if (mode === 'none') return { kind: 'service', principal: servicePrincipal }
        if (mode === 'static') {
          const queryToken =
            req.method === 'GET' && (req.url ?? '').startsWith('/api/events')
              ? new URL(req.url ?? '/', 'http://localhost').searchParams.get('token')
              : null
          const presented = presentedWebToken(req.headers, queryToken)
          return options.staticTokenOk(presented)
            ? { kind: 'service', principal: servicePrincipal }
            : { kind: 'anonymous' }
        }
        // password：读 cookie → 存储
        const sid = readCookie(req.headers.cookie, options.cookieName)
        if (sid === undefined || sid === '') return { kind: 'anonymous' }
        const session = sessions.resolve(sid, at)
        if (session === undefined) return { kind: 'anonymous' }
        const principal = principalOf(session)
        if (principal === undefined) return { kind: 'anonymous' }
        sessions.touch(session, at)
        return { kind: 'principal', principal, session }
      } catch {
        // 纪律 1：identify 绝不抛
        return { kind: 'anonymous' }
      }
    },

    csrfExpectation(identity) {
      return identity.kind === 'principal' ? identity.session.csrf : options.serverCsrf
    },

    async login(input) {
      const at = now()
      const userKey = `user:${options.tenantId}/${input.userId}`
      const ipKey = `ip:${input.ip ?? 'unknown'}`

      // ① 已锁定？只有**锁定**才是 409。
      const lockedFor = Math.max(throttle.locked(userKey, at) ?? 0, throttle.locked(ipKey, at) ?? 0)
      if (lockedFor > 0) {
        audit({
          type: 'auth/login-locked',
          data: { userIdHash: hashUser(input.userId), retryAfterSec: lockedFor, at },
          subject: 'nobody',
          decision: 'deny',
        })
        return { ok: false, code: 'web-login-locked', retryAfterSec: lockedFor }
      }

      // ② **退避不拒人**。指数退避是"下次失败要多等一会儿"的提示（回在 retry-after 里），
      //    不是拒绝条件：一旦用它拒请求，"输错一次、1 秒内改对"的合法用户会被判 401，
      //    而他的口令明明是对的。防爆破的牙齿来自 ③ 的计数与锁定（5 次失败 → 15 分钟锁定），
      //    以及每次失败都要付一次 scrypt。
      const found = directory?.findById(input.userId)
      // 用户不存在也跑一次 scrypt：耗时同形（A2）
      const verified =
        found === undefined
          ? await verifyAgainstDummy(input.password)
          : await verifyPassword(input.password, found.password)

      if (!verified || found === undefined) {
        throttle.fail(userKey, at)
        throttle.fail(ipKey, at)
        audit({
          type: 'auth/login-failed',
          data: { userIdHash: hashUser(input.userId), reason: 'bad-credentials', at },
          subject: 'nobody',
          decision: 'deny',
        })
        // 这次失败本身仍回 401：`maxFailures = 5` 表示"**允许** 5 次失败"，
        // 锁定从**下一次**尝试起生效（否则第 5 次错就报"尝试过于频繁"，与文案矛盾）。
        const wait = Math.max(throttle.check(userKey, at) ?? 0, throttle.check(ipKey, at) ?? 0)
        return {
          ok: false,
          code: 'web-login-failed',
          ...(wait > 0 ? { retryAfterSec: wait } : {}),
        }
      }

      throttle.reset(userKey)
      throttle.reset(ipKey)
      const session = sessions.issue({
        tenantId: options.tenantId,
        userId: found.userId,
        roles: found.roles,
      })
      const principal = principalOf(session)
      if (principal === undefined) return { ok: false, code: 'web-login-failed' }
      audit({
        type: 'auth/login',
        data: { userId: principal.userId, roles: principal.roles, source: principal.source, at },
        subject: `principal:${options.tenantId}/${principal.userId}`,
        decision: 'allow',
      })
      options.onLogin?.(principal)
      return { ok: true, session, principal }
    },

    logout(identity, at) {
      if (identity.kind !== 'principal') return false
      const ok = sessions.revoke(identity.session.sid, at, 'logout')
      if (ok) {
        audit({
          type: 'auth/logout',
          data: { userId: identity.principal.userId, at },
          subject: `principal:${options.tenantId}/${identity.principal.userId}`,
          decision: 'allow',
        })
      }
      return ok
    },
  }
}
