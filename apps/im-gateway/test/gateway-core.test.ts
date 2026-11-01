/**
 * 网关核心：配置 / 日志 / 去重 / 限流 / token / 传输（02 单单元面）。
 */

import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import {
  ACK_TEXT,
  DEFAULT_GATEWAY_PORT,
  loadConfig,
  parseUntrustedUsers,
  PULL_MAX_ITEMS,
  type Env,
} from '../src/config.ts'
import { createDedupe, inboundDedupeKey } from '../src/ingress/dedupe.ts'
import { createRateLimiter } from '../src/ingress/ratelimit.ts'
import { createImLogger, sanitizeImLogFields } from '../src/log.ts'
import { createTokenProvider, type FetchJson } from '../src/platform/wechat/token.ts'
import { createWechatPushText, mapErrcode } from '../src/platform/wechat/transport.ts'

/** 最小合法环境。 */
const BASE: Env = {
  BAH_IM_SESSION_SALT: 'salt-0123456789abcdef',
  BAH_IM_LINK_SECRET: 'link-secret-0123456789abcdefghij',
  BAH_WECHAT_APPID: 'demo-app',
  BAH_WECHAT_SECRET: 'demo-secret',
  BAH_WECHAT_TOKEN: 'demo-callback-token',
}

/** 带覆盖的环境。 */
function env(overrides: Record<string, string | undefined> = {}): Env {
  return { ...BASE, ...overrides }
}

/** 取错误码。 */
function codeOf(run: () => unknown): string {
  try {
    run()
    return 'no-throw'
  } catch (error) {
    return error instanceof BahError ? error.code : 'not-bah-error'
  }
}

describe('loadConfig（T-IM-019）', () => {
  it('最小环境 → 缺省值齐全', () => {
    const config = loadConfig(env(), 'D:/repo')
    expect(config).toMatchObject({
      sessionSalt: 'salt-0123456789abcdef',
      host: '0.0.0.0',
      port: DEFAULT_GATEWAY_PORT,
      root: 'D:/repo',
      profile: 'im',
      childEntry: 'packages/cli/src/main.ts',
      childLoader: 'tsx',
      jsonlBase: 'D:/repo/sessions/im',
      maxChildren: 8,
      pushMode: 'auto',
      passiveWaitMs: 4000,
      logLevel: 'info',
    })
    expect(config.untrustedUsers.size).toBe(0)
    expect(config.wechat.accountKey).toBe('default')
    expect(config.wechat.apiBase).toBe('https://api.weixin.qq.com')
    expect(config.publicBaseUrl).toBeUndefined()
    expect(config.linkSecret).toBe('link-secret-0123456789abcdefghij')
    expect(config.operatorToken).toBeUndefined()
    expect(config.operatorName).toBe('坐席')
  })

  it('缺任一必填 → im-config-missing（不是静默用空串）', () => {
    expect(codeOf(() => loadConfig(env({ BAH_IM_SESSION_SALT: undefined }), 'D:/repo'))).toBe(
      'im-config-missing',
    )
    expect(codeOf(() => loadConfig(env({ BAH_WECHAT_APPID: '  ' }), 'D:/repo'))).toBe('im-config-missing')
    expect(codeOf(() => loadConfig(env({ BAH_WECHAT_SECRET: undefined }), 'D:/repo'))).toBe('im-config-missing')
    expect(codeOf(() => loadConfig(env({ BAH_WECHAT_TOKEN: undefined }), 'D:/repo'))).toBe('im-config-missing')
    expect(codeOf(() => loadConfig(env({ BAH_IM_LINK_SECRET: undefined }), 'D:/repo'))).toBe(
      'im-config-missing',
    )
  })

  it('盐太短 / 链接密钥太短 / 公开基址非 https → im-config-invalid', () => {
    expect(codeOf(() => loadConfig(env({ BAH_IM_SESSION_SALT: 'short' }), 'D:/repo'))).toBe(
      'im-config-invalid',
    )
    expect(codeOf(() => loadConfig(env({ BAH_IM_LINK_SECRET: 'x'.repeat(31) }), 'D:/repo'))).toBe(
      'im-config-invalid',
    )
    expect(
      codeOf(() => loadConfig(env({ BAH_IM_PUBLIC_BASE_URL: 'http://im.example.test' }), 'D:/repo')),
    ).toBe('im-config-invalid')
    expect(
      loadConfig(env({ BAH_IM_PUBLIC_BASE_URL: 'http://127.0.0.1:8080' }), 'D:/repo').publicBaseUrl,
    ).toBe('http://127.0.0.1:8080')
  })

  it('端口/上限/等待时长非法 → im-config-invalid', () => {
    expect(codeOf(() => loadConfig(env({ BAH_IM_PORT: '0' }), 'D:/repo'))).toBe('im-config-invalid')
    expect(codeOf(() => loadConfig(env({ BAH_IM_PORT: 'abc' }), 'D:/repo'))).toBe('im-config-invalid')
    expect(codeOf(() => loadConfig(env({ BAH_IM_MAX_CHILDREN: '0' }), 'D:/repo'))).toBe('im-config-invalid')
    expect(codeOf(() => loadConfig(env({ BAH_IM_PASSIVE_WAIT_MS: '6000' }), 'D:/repo'))).toBe(
      'im-config-invalid',
    )
  })

  it('枚举非法 → im-config-invalid；合法值生效', () => {
    expect(codeOf(() => loadConfig(env({ BAH_IM_PUSH_MODE: 'sometimes' }), 'D:/repo'))).toBe(
      'im-config-invalid',
    )
    expect(codeOf(() => loadConfig(env({ BAH_IM_CHILD_LOADER: 'bun' }), 'D:/repo'))).toBe(
      'im-config-invalid',
    )
    expect(codeOf(() => loadConfig(env({ BAH_IM_LOG: 'trace' }), 'D:/repo'))).toBe('im-config-invalid')
    expect(loadConfig(env({ BAH_IM_PUSH_MODE: 'pull' }), 'D:/repo').pushMode).toBe('pull')
    expect(loadConfig(env({ BAH_IM_CHILD_LOADER: 'none' }), 'D:/repo').childLoader).toBe('none')
  })

  it('可选键覆盖生效（host / root / jsonl / 账号 / API 基址）', () => {
    const config = loadConfig(
      env({
        BAH_IM_HOST: '127.0.0.1',
        BAH_IM_ROOT: 'D:/root',
        BAH_IM_JSONL_BASE: 'D:/jsonl',
        BAH_WECHAT_ACCOUNT_KEY: 'acct-1',
        BAH_WECHAT_API_BASE: 'http://127.0.0.1:9',
        BAH_IM_OPERATOR_TOKEN: 'op',
        BAH_IM_PUBLIC_BASE_URL: 'https://im.example.test',
      }),
      'D:/repo',
    )
    expect(config.host).toBe('127.0.0.1')
    expect(config.root).toBe('D:/root')
    expect(config.jsonlBase).toBe('D:/jsonl')
    expect(config.wechat.accountKey).toBe('acct-1')
    expect(config.wechat.apiBase).toBe('http://127.0.0.1:9')
    expect(config.operatorToken).toBe('op')
    expect(config.publicBaseUrl).toBe('https://im.example.test')
  })
})

describe('parseUntrustedUsers', () => {
  it('逗号分隔、去空白、空串集合', () => {
    expect(parseUntrustedUsers('wechat:o1, mock:u1 ')).toEqual(new Set(['wechat:o1', 'mock:u1']))
    expect(parseUntrustedUsers('')).toEqual(new Set())
    expect(parseUntrustedUsers(undefined)).toEqual(new Set())
  })

  it('非法元素启动失败（不静默丢弃）', () => {
    expect(codeOf(() => parseUntrustedUsers('wechat-o1'))).toBe('im-config-invalid')
    expect(codeOf(() => parseUntrustedUsers(':o1'))).toBe('im-config-invalid')
    expect(codeOf(() => parseUntrustedUsers('wechat:'))).toBe('im-config-invalid')
  })
})

describe('日志', () => {
  it('低于级别不打；高于级别打，并丢弃用户标识字段', () => {
    const calls: { level: string; code: string; fields: Record<string, unknown> }[] = []
    const log = createImLogger('warn', (level, code, fields) => {
      calls.push({ level, code, fields })
    })
    log.debug('im-duplicate', {})
    log.info('im-duplicate', {})
    log.warn('im-push-failed', { code: 'x' })
    log.error('im-turn-failed', {})
    expect(calls.map((call) => call.level)).toEqual(['warn', 'error'])
  })

  it('sanitize 丢弃 userId / openid / token 等字段（整条丢弃，不打码）', () => {
    const sanitized = sanitizeImLogFields({
      userId: 'o_secret',
      openid: 'o_secret',
      token: 't',
      sessionKey: 'im-abc',
      reason: 'x',
      empty: undefined,
    })
    expect(sanitized).toEqual({ sessionKey: 'im-abc', reason: 'x' })
  })
})

describe('dedupe（T-IM-010）', () => {
  const inbound = {
    platform: 'wechat',
    accountKey: 'default',
    userId: 'o-1',
    text: '查余额',
    messageId: '42',
    at: 1_793_000_000_000,
  }

  it('同 platform+account+msgId 第二次命中', () => {
    const dedupe = createDedupe({ nowMs: () => 0 })
    const key = inboundDedupeKey(inbound)
    expect(dedupe.seen(key)).toBe(false)
    expect(dedupe.seen(key)).toBe(true)
  })

  it('不同平台 / 不同账号不串键', () => {
    expect(inboundDedupeKey(inbound)).not.toBe(inboundDedupeKey({ ...inbound, platform: 'mock' }))
    expect(inboundDedupeKey(inbound)).not.toBe(inboundDedupeKey({ ...inbound, accountKey: 'other' }))
  })

  it('无 msgId 用内容哈希：同内容命中，改一个字不命中', () => {
    const noId = { ...inbound, messageId: undefined }
    const dedupe = createDedupe({ nowMs: () => 0 })
    const key = inboundDedupeKey(noId)
    expect(dedupe.seen(key)).toBe(false)
    expect(dedupe.seen(inboundDedupeKey({ ...noId, text: '查余额 ' }))).toBe(false)
    expect(dedupe.seen(key)).toBe(true)
  })

  it('TTL 过期后重新放行', () => {
    let now = 0
    const dedupe = createDedupe({ nowMs: () => now, ttlMs: 1000 })
    const key = inboundDedupeKey(inbound)
    expect(dedupe.seen(key)).toBe(false)
    now = 1001
    expect(dedupe.seen(key)).toBe(false)
  })

  it('容量满时淘汰最旧（LRU）', () => {
    const dedupe = createDedupe({ nowMs: () => 0, capacity: 2 })
    dedupe.seen('a')
    dedupe.seen('b')
    dedupe.seen('c')
    expect(dedupe.size()).toBe(2)
    // a 已被淘汰：再次登记不算重复
    expect(dedupe.seen('a')).toBe(false)
  })
})

describe('ratelimit（T-IM-018）', () => {
  it('每用户窗口：第 21 次拒绝，窗口过后恢复', () => {
    const limiter = createRateLimiter({ userLimit: 20, userWindowMs: 60_000 })
    for (let index = 0; index < 20; index += 1) {
      expect(limiter.check('u', 1_000)).toEqual({ ok: true })
    }
    const denied = limiter.check('u', 1_000)
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.scope).toBe('user')
    expect(denied.retryAfterSec).toBeGreaterThan(0)
    expect(limiter.check('u', 61_000)).toEqual({ ok: true })
  })

  it('全局窗口超限 → scope=global', () => {
    const limiter = createRateLimiter({ userLimit: 100, globalLimit: 2, globalWindowMs: 60_000 })
    expect(limiter.check('a', 0)).toEqual({ ok: true })
    expect(limiter.check('b', 0)).toEqual({ ok: true })
    const denied = limiter.check('c', 0)
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.scope).toBe('global')
  })

  it('用户窗口超过 maxUsers ⇒ 淘汰最久未用（内存有上限）', () => {
    const limiter = createRateLimiter({ userLimit: 1, userWindowMs: 60_000, maxUsers: 1 })
    expect(limiter.check('u1', 0)).toEqual({ ok: true })
    expect(limiter.check('u2', 0)).toEqual({ ok: true })
    // u1 已被淘汰：若未淘汰，这里会因 userLimit=1 被拒。
    expect(limiter.check('u1', 0)).toEqual({ ok: true })
  })
})

describe('token（T-IM-021 的缓存面）', () => {
  /** 造一个可数次的假 fetch。 */
  function fakeFetch(body: unknown, status = 200): { fetch: FetchJson; calls: () => number } {
    let calls = 0
    return {
      fetch: async () => {
        calls += 1
        return { status, body }
      },
      calls: () => calls,
    }
  }

  it('首次换、二次缓存；过期后重换', async () => {
    let now = 0
    const fake = fakeFetch({ access_token: 't1', expires_in: 7200 })
    const provider = createTokenProvider({
      appId: 'a',
      appSecret: 's',
      apiBase: 'http://x',
      fetchJson: fake.fetch,
      nowMs: () => now,
    })
    await expect(provider.get()).resolves.toBe('t1')
    await expect(provider.get()).resolves.toBe('t1')
    expect(fake.calls()).toBe(1)
    now = (7200 - 300) * 1000
    await provider.get()
    expect(fake.calls()).toBe(2)
  })

  it('单飞：并发 get 只换一次', async () => {
    const fake = fakeFetch({ access_token: 't1', expires_in: 7200 })
    const provider = createTokenProvider({
      appId: 'a',
      appSecret: 's',
      apiBase: 'http://x',
      fetchJson: fake.fetch,
      nowMs: () => 0,
    })
    await Promise.all([provider.get(), provider.get(), provider.get()])
    expect(fake.calls()).toBe(1)
  })

  it('invalidate 让下一次重新换', async () => {
    const fake = fakeFetch({ access_token: 't1', expires_in: 7200 })
    const provider = createTokenProvider({
      appId: 'a',
      appSecret: 's',
      apiBase: 'http://x',
      fetchJson: fake.fetch,
      nowMs: () => 0,
    })
    await provider.get()
    provider.invalidate()
    await provider.get()
    expect(fake.calls()).toBe(2)
  })

  it('非 200 / 非对象 / 缺字段 → im-wechat-token', async () => {
    const cases: readonly { status?: number; body: unknown }[] = [
      { status: 500, body: {} },
      { body: 'not-object' },
      { body: { expires_in: 7200 } },
      { body: { access_token: 't' } },
      { body: { access_token: 't', expires_in: 0 } },
    ]
    for (const item of cases) {
      const provider = createTokenProvider({
        appId: 'a',
        appSecret: 's',
        apiBase: 'http://x',
        fetchJson: async () => ({ status: item.status ?? 200, body: item.body }),
        nowMs: () => 0,
      })
      await expect(provider.get()).rejects.toMatchObject({ code: 'im-wechat-token' })
    }
  })

  it('expires_in 很小也至少缓存 60 秒（不每条都刷新）', async () => {
    let now = 0
    const fake = fakeFetch({ access_token: 't1', expires_in: 300 })
    const provider = createTokenProvider({
      appId: 'a',
      appSecret: 's',
      apiBase: 'http://x',
      fetchJson: fake.fetch,
      nowMs: () => now,
    })
    await provider.get()
    now = 59_000
    await provider.get()
    expect(fake.calls()).toBe(1)
  })

  it('snapshot 不暴露 token 原文', async () => {
    const fake = fakeFetch({ access_token: 'secret-token', expires_in: 7200 })
    const provider = createTokenProvider({
      appId: 'a',
      appSecret: 's',
      apiBase: 'http://x',
      fetchJson: fake.fetch,
      nowMs: () => 0,
    })
    await provider.get()
    const snapshot = provider.snapshot()
    expect(JSON.stringify(snapshot)).not.toContain('secret-token')
    expect(snapshot.expiresAtMs).toBeGreaterThan(0)
    expect(snapshot.refreshing).toBe(false)
  })
})

describe('transport（推送降级）', () => {
  const log = createImLogger('debug', () => undefined)

  /** 固定 token 的假 provider。 */
  function tokenOf(value = 't1', onInvalidate?: () => void) {
    return {
      get: async (): Promise<string> => value,
      invalidate: (): void => {
        onInvalidate?.()
      },
      snapshot: () => ({ expiresAtMs: 0, refreshing: false }),
    }
  }

  it('错误码映射：45015 / 48001 / 45009 / 其它', () => {
    expect(mapErrcode(45015)).toBe('expired-window')
    expect(mapErrcode(48001)).toBe('unauthorized')
    expect(mapErrcode(45009)).toBe('quota')
    expect(mapErrcode(99999)).toBe('failed')
  })

  it('成功 → ok', async () => {
    const push = createWechatPushText({
      token: tokenOf(),
      apiBase: 'http://x',
      fetchJson: async () => ({ status: 200, body: { errcode: 0 } }),
      log,
    })
    await expect(push('o-1', 'hi')).resolves.toEqual({ ok: true })
  })

  it('各错误码 → 对应语义（不向用户暴露 errcode）', async () => {
    const cases: readonly [number, string][] = [
      [45015, 'expired-window'],
      [48001, 'unauthorized'],
      [45009, 'quota'],
      [99999, 'failed'],
    ]
    for (const [errcode, code] of cases) {
      const push = createWechatPushText({
        token: tokenOf(),
        apiBase: 'http://x',
        fetchJson: async () => ({ status: 200, body: { errcode } }),
        log,
      })
      const result = await push('o-1', 'hi')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe(code)
      expect(result.reason).not.toContain(String(errcode))
    }
  })

  it('40001 → 失效刷新后重试一次成功', async () => {
    let calls = 0
    let invalidated = 0
    const push = createWechatPushText({
      token: tokenOf('t1', () => {
        invalidated += 1
      }),
      apiBase: 'http://x',
      fetchJson: async () => {
        calls += 1
        return calls === 1 ? { status: 200, body: { errcode: 40001 } } : { status: 200, body: { errcode: 0 } }
      },
      log,
    })
    await expect(push('o-1', 'hi')).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
    expect(invalidated).toBe(1)
  })

  it('40001 连续两次 → unauthorized（不再刷第三次）', async () => {
    let calls = 0
    const push = createWechatPushText({
      token: tokenOf(),
      apiBase: 'http://x',
      fetchJson: async () => {
        calls += 1
        return { status: 200, body: { errcode: 42001 } }
      },
      log,
    })
    const result = await push('o-1', 'hi')
    expect(result).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(calls).toBe(2)
  })

  it('token 换不到 / 网络异常 → failed（不抛）', async () => {
    const tokenFail = createWechatPushText({
      token: {
        get: async () => {
          throw new Error('boom')
        },
        invalidate: () => undefined,
        snapshot: () => ({ expiresAtMs: 0, refreshing: false }),
      },
      apiBase: 'http://x',
      fetchJson: async () => ({ status: 200, body: { errcode: 0 } }),
      log,
    })
    await expect(tokenFail('o-1', 'hi')).resolves.toMatchObject({ ok: false, code: 'failed' })

    const networkFail = createWechatPushText({
      token: tokenOf(),
      apiBase: 'http://x',
      fetchJson: async () => {
        throw new Error('offline')
      },
      log,
    })
    await expect(networkFail('o-1', 'hi')).resolves.toMatchObject({ ok: false, code: 'failed' })
  })

  it('非 200 且无 errcode → failed', async () => {
    const push = createWechatPushText({
      token: tokenOf(),
      apiBase: 'http://x',
      fetchJson: async () => ({ status: 502, body: 'bad gateway' }),
      log,
    })
    await expect(push('o-1', 'hi')).resolves.toMatchObject({ ok: false, code: 'failed' })
  })
})

describe('拉取式文案常量', () => {
  it('ack 文案提示"回复 0"，拉取上限是 5', () => {
    expect(ACK_TEXT).toContain('回复 0')
    expect(PULL_MAX_ITEMS).toBe(5)
  })
})
