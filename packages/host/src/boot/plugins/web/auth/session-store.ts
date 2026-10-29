/**
 * 认证会话存储（租户与鉴权 02 · TA-23）：内存 + 一条 append-only 日志。
 *
 * ## 为什么不是 JWT
 *
 * 银行场景的硬需求是**撤销**（员工离职、手机丢失）。无状态签名令牌做不到"立即失效"，
 * 除非再维护一张黑名单——那等于又回到状态，只是把状态藏在不叫"存储"的地方。
 *
 * ## 六条纪律
 *
 * 1. `sid = randomBytes(32).toString('base64url')`（43 字符，无连字符，放 cookie 不用转义）
 * 2. **落盘只写 `issue` / `revoke`**：`touch` 每条请求一次，写盘会让 IO 与 QPS 成正比
 * 3. **重启的诚实边界**：`lastSeenAt` 重置为 `issuedAt` ⇒ idle 从签发时刻重新计时
 * 4. **上限 1024**：满了先清过期，仍满 → `web-auth-capacity`（不静默淘汰最老的 = 不随机踢人）
 * 5. 日志在 `<租户根>/auth/sessions.jsonl`，**不是**会话事件（不进 `session/event` 流）
 * 6. **损坏容忍**：坏行跳过 + 一条 warn；文件不存在是正常的（首次启动）
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { BahError, logJson, type Role } from '@bah/util'

/** 一个已签发的会话。 */
export interface AuthSession {
  readonly sid: string
  readonly tenantId: string
  readonly userId: string
  readonly roles: readonly Role[]
  /** 与该会话绑定的 CSRF 令牌（登录时轮换）。 */
  readonly csrf: string
  readonly issuedAt: number
  /** 最近一次活动（**只在内存更新**）。 */
  lastSeenAt: number
  readonly absoluteExpiresAt: number
}

/** 会话存储。 */
export interface SessionStore {
  issue(input: {
    readonly tenantId: string
    readonly userId: string
    readonly roles: readonly Role[]
  }): AuthSession
  /** 顺带做 idle / absolute 判定；过期或被撤销返回 `undefined`。 */
  resolve(sid: string, now: number): AuthSession | undefined
  touch(session: AuthSession, now: number): void
  revoke(sid: string, now: number, reason: string): boolean
  revokeUser(tenantId: string, userId: string, now: number): number
  size(): number
}

/** 建存储的输入。 */
export interface SessionStoreOptions {
  readonly now: () => number
  readonly idleMs: number
  readonly absoluteMs: number
  /** 日志文件（缺省 = 纯内存，重启即全员重新登录）。 */
  readonly logPath?: string
  /** 容量上限（缺省 1024）。 */
  readonly capacity?: number
  readonly warn?: (message: string) => void
  /** 测试注入（会话 ID 与 CSRF 的确定性来源）。 */
  readonly randomToken?: () => string
}

/** 缺省容量。 */
export const DEFAULT_SESSION_CAPACITY = 1024

/** 日志行。 */
interface LogLine {
  readonly type: 'issue' | 'revoke'
  readonly sid: string
  readonly tenantId?: string
  readonly userId?: string
  readonly roles?: readonly Role[]
  readonly csrf?: string
  readonly issuedAt?: number
  readonly absoluteExpiresAt?: number
  readonly at: number
  readonly reason?: string
}

/** 造一个会话 ID（43 字符 base64url）。 */
function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 建会话存储。
 *
 * 启动时回放日志：`issue` 建条目、`revoke` 删条目。回放**不延长**任何寿命，
 * 过期的条目在第一次 `resolve` 时自然淘汰。
 */
export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const now = options.now
  const capacity = options.capacity ?? DEFAULT_SESSION_CAPACITY
  const warn =
    options.warn ??
    ((message: string) => logJson('warn', 'web.auth-session-store-warn', { reason: message }))
  const randomToken = options.randomToken ?? newToken
  const sessions = new Map<string, AuthSession>()
  /** 已撤销但日志里还没被回收的 sid（重启后要能拒绝它们）。 */
  const revoked = new Set<string>()

  const logPath = options.logPath
  if (logPath !== undefined) {
    mkdirSync(dirname(logPath), { recursive: true })
    restore()
  }

  /** 从日志恢复（坏行跳过）。 */
  function restore(): void {
    if (logPath === undefined || !existsSync(logPath)) return
    const text = readFileSync(logPath, 'utf8')
    let bad = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        bad += 1
        continue
      }
      if (typeof parsed !== 'object' || parsed === null) {
        bad += 1
        continue
      }
      const entry = parsed as Partial<LogLine>
      if (entry.type === 'revoke' && typeof entry.sid === 'string') {
        sessions.delete(entry.sid)
        revoked.add(entry.sid)
        continue
      }
      if (
        entry.type === 'issue' &&
        typeof entry.sid === 'string' &&
        typeof entry.tenantId === 'string' &&
        typeof entry.userId === 'string' &&
        typeof entry.csrf === 'string' &&
        typeof entry.issuedAt === 'number' &&
        typeof entry.absoluteExpiresAt === 'number' &&
        Array.isArray(entry.roles)
      ) {
        sessions.set(entry.sid, {
          sid: entry.sid,
          tenantId: entry.tenantId,
          userId: entry.userId,
          roles: entry.roles,
          csrf: entry.csrf,
          issuedAt: entry.issuedAt,
          // 纪律 3：重启后 idle 从签发时刻重新计时（诚实边界，写进文档）
          lastSeenAt: entry.issuedAt,
          absoluteExpiresAt: entry.absoluteExpiresAt,
        })
        continue
      }
      bad += 1
    }
    if (bad > 0) warn(`[web-auth] 认证会话日志有 ${String(bad)} 行无法解析，已跳过（其余会话可用）`)
    // 容量是硬上限：日志里条目多于上限时，只保留最近的
    if (sessions.size > capacity) {
      const ordered = [...sessions.values()].sort((a, b) => b.issuedAt - a.issuedAt).slice(0, capacity)
      sessions.clear()
      for (const session of ordered) sessions.set(session.sid, session)
      warn(`[web-auth] 认证会话日志超过容量上限（${String(capacity)}），只保留最近签发的会话`)
    }
  }

  /** 追加一条日志（失败只告警：日志坏了不该让登录失败）。 */
  function append(entry: LogLine): void {
    if (logPath === undefined) return
    try {
      appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      warn(`[web-auth] 认证会话日志写入失败（会话仍有效）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 清过期条目（只在触及容量时调用）。 */
  function prune(at: number): void {
    for (const [sid, session] of sessions) {
      const idle = at - session.lastSeenAt > options.idleMs
      const absolute = at >= session.absoluteExpiresAt
      if (idle || absolute) sessions.delete(sid)
    }
  }

  /** 撤销一个会话（返回是否真的删掉了）。 */
  function revokeSession(sid: string, at: number, reason: string): boolean {
    const existed = sessions.delete(sid)
    if (!existed) return false
    revoked.add(sid)
    append({ type: 'revoke', sid, at, reason })
    return true
  }

  return {
    issue(input) {
      const at = now()
      if (sessions.size >= capacity) {
        prune(at)
        if (sessions.size >= capacity) {
          throw new BahError(
            'web-auth-capacity',
            `web-auth-capacity: 认证会话已达上限（${String(capacity)}）；拒绝签发新会话（不静默踢人）`,
            { capacity },
          )
        }
      }
      const sid = randomToken()
      const session: AuthSession = {
        sid,
        tenantId: input.tenantId,
        userId: input.userId,
        roles: input.roles,
        csrf: randomToken(),
        issuedAt: at,
        lastSeenAt: at,
        absoluteExpiresAt: at + options.absoluteMs,
      }
      sessions.set(sid, session)
      append({
        type: 'issue',
        sid,
        tenantId: session.tenantId,
        userId: session.userId,
        roles: session.roles,
        csrf: session.csrf,
        issuedAt: session.issuedAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        at,
      })
      return session
    },

    resolve(sid, at) {
      if (revoked.has(sid)) return undefined
      const session = sessions.get(sid)
      if (session === undefined) return undefined
      if (at >= session.absoluteExpiresAt) return undefined
      if (at - session.lastSeenAt > options.idleMs) return undefined
      return session
    },

    touch(session, at) {
      session.lastSeenAt = at
    },

    revoke(sid, at, reason) {
      return revokeSession(sid, at, reason)
    },

    revokeUser(tenantId, userId, at) {
      let count = 0
      for (const sid of [...sessions.keys()]) {
        const session = sessions.get(sid)
        if (session === undefined) continue
        if (session.tenantId !== tenantId || session.userId !== userId) continue
        if (revokeSession(sid, at, 'revoke-user')) count += 1
      }
      return count
    },

    size() {
      return sessions.size
    },
  }
}
