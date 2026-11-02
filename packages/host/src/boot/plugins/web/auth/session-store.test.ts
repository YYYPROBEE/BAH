/**
 * 认证会话存储（租户与鉴权 02 · TA-23）。
 *
 * 六条纪律各一条用例：签发/过期/撤销/重启恢复/坏行容忍/容量上限。
 * 另外钉一条**诚实边界**：重启后 idle 从签发时刻重新计时（不是"精确的活跃时间"）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { createSessionStore } from './session-store.ts'

const dirs: string[] = []
function tempLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-auth-sessions-'))
  dirs.push(dir)
  return join(dir, 'auth', 'sessions.jsonl')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 确定性令牌发生器（按序发 `tok-1`, `tok-2`…）。 */
function tokens(): () => string {
  let next = 0
  return () => {
    next += 1
    return `tok-${String(next)}`
  }
}

/** 建一个存储（时间可推进）。 */
function storeAt(now: { value: number }, logPath?: string, capacity?: number) {
  return createSessionStore({
    now: () => now.value,
    idleMs: 1_000,
    absoluteMs: 10_000,
    randomToken: tokens(),
    warn: () => undefined,
    ...(logPath === undefined ? {} : { logPath }),
    ...(capacity === undefined ? {} : { capacity }),
  })
}

describe('createSessionStore', () => {
  it('TA-23-1 签发 → resolve 拿得到；idle 超时后 undefined', () => {
    const now = { value: 1_000 }
    const store = storeAt(now)
    const session = store.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })
    expect(store.resolve(session.sid, 1_500)?.userId).toBe('u-1')
    // idleMs = 1000：超过 1s 未活动即过期
    expect(store.resolve(session.sid, 2_100)).toBeUndefined()
  })

  it('TA-23-2 absolute 到期即失效（即使一直在活动）', () => {
    const now = { value: 1_000 }
    const store = storeAt(now)
    const session = store.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })
    store.touch(session, 9_000)
    expect(store.resolve(session.sid, 9_500)?.sid).toBe(session.sid)
    expect(store.resolve(session.sid, 11_000)).toBeUndefined()
  })

  it('TA-23-3 revoke 后立即失效；revokeUser 按租户 × 用户批量', () => {
    const now = { value: 1_000 }
    const store = storeAt(now)
    const first = store.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })
    const second = store.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })
    const other = store.issue({ tenantId: 'demo', userId: 'u-2', roles: ['customer'] })
    expect(store.revoke(first.sid, 1_100, 'logout')).toBe(true)
    expect(store.resolve(first.sid, 1_200)).toBeUndefined()
    expect(store.revokeUser('demo', 'u-1', 1_300)).toBe(1)
    expect(store.resolve(second.sid, 1_400)).toBeUndefined()
    expect(store.resolve(other.sid, 1_400)?.userId).toBe('u-2')
  })

  it('TA-23-4 重启恢复：活着的会话仍可用、已撤销的不可用，且 idle 从签发时刻重算', () => {
    const logPath = tempLog()
    const now = { value: 1_000 }
    const first = storeAt(now, logPath)
    const alive = first.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })
    const revoked = first.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })
    first.revoke(revoked.sid, 1_500, 'logout')

    // "重启"：新实例读同一个日志
    now.value = 1_800
    const second = storeAt(now, logPath)
    expect(second.size()).toBe(1)
    expect(second.resolve(alive.sid, 1_900)?.userId).toBe('u-1')
    expect(second.resolve(revoked.sid, 1_900)).toBeUndefined()
    // 诚实边界：lastSeenAt 重置为 issuedAt ⇒ 1s idle 从 1000 起算，1900 时已过期
    expect(second.resolve(alive.sid, 2_100)).toBeUndefined()
  })

  it('TA-23-5 日志坏行跳过 + 一条 warn（其余会话可用）', () => {
    const logPath = tempLog()
    const now = { value: 1_000 }
    const first = storeAt(now, logPath)
    const session = first.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}{不是 JSON\n`, 'utf8')

    const warnings: string[] = []
    const second = createSessionStore({
      now: () => 1_200,
      idleMs: 1_000,
      absoluteMs: 10_000,
      logPath,
      warn: (message) => warnings.push(message),
    })
    expect(second.resolve(session.sid, 1_300)?.userId).toBe('u-1')
    expect(warnings.join('\n')).toContain('无法解析')
  })

  it('TA-23-5b 合法 JSON 但形状不对的行（null / 数字 / 字段不全）同样跳过，不污染会话表', () => {
    const logPath = tempLog()
    const now = { value: 1_000 }
    const first = storeAt(now, logPath)
    const session = first.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })
    // 三种"能 JSON.parse 但不是 LogLine"的残行：非对象、非对象、缺字段的 issue
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}null\n123\n{"type":"issue","sid":"forged"}\n`, 'utf8')

    const warnings: string[] = []
    const second = createSessionStore({
      now: () => 1_200,
      idleMs: 1_000,
      absoluteMs: 10_000,
      logPath,
      warn: (message) => warnings.push(message),
    })
    expect(second.size()).toBe(1)
    expect(second.resolve(session.sid, 1_300)?.userId).toBe('u-1')
    // 伪造的 issue 行不能凭 sid 凭空造出会话
    expect(second.resolve('forged', 1_300)).toBeUndefined()
    expect(warnings.join('\n')).toContain('3 行无法解析')
  })

  it('TA-23-6 容量上限：满且清不掉过期 → web-auth-capacity（不静默淘汰最老的）', () => {
    const now = { value: 1_000 }
    const store = storeAt(now, undefined, 2)
    store.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })
    store.issue({ tenantId: 'demo', userId: 'u-2', roles: ['customer'] })
    let code = ''
    try {
      store.issue({ tenantId: 'demo', userId: 'u-3', roles: ['customer'] })
    } catch (error) {
      code = error instanceof BahError ? error.code : 'other'
    }
    expect(code).toBe('web-auth-capacity')
    expect(store.size()).toBe(2)
  })

  it('TA-23-7 重启恢复时日志条目超过容量 → 只保留最近签发的，旧的不可再解析', () => {
    const logPath = tempLog()
    const now = { value: 1_000 }
    // 先按大容量签发 4 条（时间递增，排序有据可依）
    const first = storeAt(now, logPath, 10)
    const sessions = [1, 2, 3, 4].map((index) => {
      now.value += 100
      return first.issue({ tenantId: 'demo', userId: `u-${String(index)}`, roles: ['customer'] })
    })

    // "重启"：容量收紧到 2，日志里有 4 条 → 启动期必须裁掉最老的
    now.value = 1_400
    const warnings: string[] = []
    const second = createSessionStore({
      now: () => now.value,
      idleMs: 1_000,
      absoluteMs: 10_000,
      logPath,
      capacity: 2,
      warn: (message) => warnings.push(message),
    })
    expect(second.size()).toBe(2)
    // 最近两条可用；被裁掉的旧条目不能重新变成有效会话
    expect(second.resolve(sessions[3]!.sid, 1_450)?.userId).toBe('u-4')
    expect(second.resolve(sessions[2]!.sid, 1_450)?.userId).toBe('u-3')
    expect(second.resolve(sessions[0]!.sid, 1_450)).toBeUndefined()
    expect(second.resolve(sessions[1]!.sid, 1_450)).toBeUndefined()
    expect(warnings.join('\n')).toContain('容量上限')
  })

  it('TA-23-8 会话日志写入失败只告警：会话照常签发、照常可用（日志是旁路）', () => {
    const logPath = tempLog()
    const now = { value: 1_000 }
    const warnings: string[] = []
    const store = createSessionStore({
      now: () => now.value,
      idleMs: 1_000,
      absoluteMs: 10_000,
      logPath,
      warn: (message) => warnings.push(message),
    })
    const first = store.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })
    expect(store.resolve(first.sid, 1_100)?.userId).toBe('u-1')

    // 把日志路径换成目录：append 必然失败（EISDIR），但登录/会话不能因此失败
    rmSync(logPath, { force: true })
    mkdirSync(logPath, { recursive: true })
    const second = store.issue({ tenantId: 'demo', userId: 'u-2', roles: ['customer'] })
    expect(store.resolve(second.sid, 1_200)?.userId).toBe('u-2')
    expect(warnings.join('\n')).toContain('写入失败')
  })
})
