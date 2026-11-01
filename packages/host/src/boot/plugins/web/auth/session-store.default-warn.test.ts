/**
 * 认证会话存储的**默认告警出口**（02 · TA-23 纪律 6 的落地方式）。
 *
 * `session-store.test.ts` 每个夹具都显式传了 `warn: () => undefined`，于是三处
 * "跳过坏行 / 砍掉超容量 / 写盘失败"的告警在测试里全被静音了——**默认**那一条
 * （没传 warn 时走 `logJson`）一次都没被验过。它不是可有可无的装饰：
 * 生产装配如果哪天忘了传 warn，静默跳过坏行就等于"有人重启后被踢出登录，没人知道"。
 *
 * 这里只验默认出口，不动那些已经钉过语义的用例：告警必须是**结构化**的一行
 * （`level=warn` + 固定 code + reason 文本），并且降级本身不改变可用性。
 *
 * 日志探针口径与 `plugins/scheduler.test.ts` 一致：Vitest 会拦 `console.error`，
 * spy `process.stderr.write` 拿不到 `logJson`，所以 mock `@bah/util` 里的那一个导出。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSessionStore } from './session-store.ts'

const { logJson } = vi.hoisted(() => ({ logJson: vi.fn() }))
vi.mock('@bah/util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bah/util')>()),
  logJson,
}))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  logJson.mockClear()
})

/** 一份 `<dir>/auth/sessions.jsonl` 路径（目录由用例自己按内容写）。 */
function logPathWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-auth-store-default-warn-'))
  dirs.push(dir)
  const path = join(dir, 'auth', 'sessions.jsonl')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, 'utf8')
  return path
}

/** 一条合法 issue 日志（与 `issue()` 写的字段同构）。 */
function issueLine(sid: string, issuedAt: number): string {
  return JSON.stringify({
    type: 'issue',
    sid,
    tenantId: 'demo',
    userId: 'u-1',
    roles: ['customer'],
    csrf: `csrf-${sid}`,
    issuedAt,
    absoluteExpiresAt: issuedAt + 10_000,
    at: issuedAt,
  })
}

/** **不传 warn** 的存储：走默认出口才是要验的东西。 */
function storeWithoutWarn(logPath: string, capacity?: number) {
  return createSessionStore({
    now: () => 1_000,
    idleMs: 1_000,
    absoluteMs: 10_000,
    logPath,
    ...(capacity === undefined ? {} : { capacity }),
  })
}

function warnReasons(): readonly string[] {
  return logJson.mock.calls
    .filter((call) => call[1] === 'web.auth-session-store-warn')
    .map((call) => String((call[2] as { reason?: string }).reason ?? ''))
}

describe('TA-23-9 默认告警出口（未注入 warn）', () => {
  it('TA-23-9a 日志里有坏行 → 结构化 warn 一行，其余会话照旧可用', () => {
    const logPath = logPathWith(['{oops', issueLine('sid-keep', 1_000)].join('\n'))
    const store = storeWithoutWarn(logPath)

    expect(store.size()).toBe(1)
    expect(store.resolve('sid-keep', 1_500)?.userId).toBe('u-1')
    expect(warnReasons()).toEqual([expect.stringContaining('1 行无法解析')])
    const call = logJson.mock.calls.find((entry) => entry[1] === 'web.auth-session-store-warn')
    expect(call?.[0]).toBe('warn')
  })

  it('TA-23-9b 日志条目多于容量 → 只保留最近签发的，并说明砍过', () => {
    const logPath = logPathWith(
      [issueLine('sid-old', 1_000), issueLine('sid-mid', 2_000), issueLine('sid-new', 3_000)].join('\n'),
    )
    const store = storeWithoutWarn(logPath, 2)

    expect(store.size()).toBe(2)
    expect(store.resolve('sid-new', 3_000)).toBeDefined()
    expect(store.resolve('sid-mid', 3_000)).toBeDefined()
    expect(store.resolve('sid-old', 3_000)).toBeUndefined()
    expect(warnReasons()).toEqual([expect.stringContaining('超过容量上限')])
  })

  it('TA-23-9c 写盘失败 → 告警但不影响登录（会话仍在内存里）', () => {
    // 构造时日志路径还不存在（首次启动的正常形状）；签发前把它换成目录，
    // `appendFileSync` 必然失败——验的是"日志写坏了，会话照发"。
    const dir = mkdtempSync(join(tmpdir(), 'bah-auth-store-blocked-'))
    dirs.push(dir)
    const logPath = join(dir, 'auth', 'sessions.jsonl')
    const store = storeWithoutWarn(logPath)
    mkdirSync(logPath, { recursive: true })

    const session = store.issue({ tenantId: 'demo', userId: 'u-1', roles: ['customer'] })

    expect(store.resolve(session.sid, 1_500)?.userId).toBe('u-1')
    expect(warnReasons()).toEqual([expect.stringContaining('写入失败')])
  })
})
