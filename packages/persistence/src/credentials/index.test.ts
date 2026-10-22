/**
 * 身份绑定渠道（施工单 09 §4）：mock 短信登录、IM 映射、Web 登录页接缝。
 *
 * T-IDN-002 / T-IDN-003 的“绑定后放行 / identity/bound 可回放”在
 * `packages/host/src/boot/plugins/bank-tools.test.ts` 里做端到端断言；
 * 本文件只验证渠道本身的确定性与默认拒绝方向。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, captureThrown, seededRandom } from '@bah/test-support'

import {
  CredentialsService,
  ImIdentityMap,
  MockSmsLoginService,
  type IdentityBindingMethod,
  type SessionIdentityBinding,
} from './index.ts'

/** 受控时钟。 */
function clock(start = 1_000) {
  let now = start
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

/** 两个演示用户。 */
const USERS = [
  { userId: 'u-1', phone: '13800001111' },
  { userId: 'u-2', phone: '13800002222' },
]

/** 造一个登录服务（确定性随机 → 码值可预期：000000、000001…）。 */
function loginService(now: () => number, ttlMs?: number): MockSmsLoginService {
  let value = -1
  return new MockSmsLoginService({
    users: USERS,
    now,
    ...(ttlMs === undefined ? {} : { codeTtlMs: ttlMs }),
    random: () => {
      value += 1
      return value / 1_000_000
    },
  })
}

/** 记录绑定调用的端口。 */
function bindingPort(): {
  calls: { sessionId: string; userId: string; method: IdentityBindingMethod }[]
  binding: SessionIdentityBinding
} {
  const calls: { sessionId: string; userId: string; method: IdentityBindingMethod }[] = []
  return {
    calls,
    binding: {
      bind: (sessionId, userId, method) => {
        calls.push({ sessionId: String(sessionId), userId, method })
      },
    },
  }
}

describe('mock 短信登录', () => {
  it('未知手机号：phone-unknown（不签发挑战）', () => {
    const login = loginService(clock().now)
    expect(login.request('13900000000')).toEqual({ ok: false, code: 'phone-unknown' })
  })

  it('申请验证码：6 位数字 + TTL + 递增 loginId', () => {
    const c = clock()
    const login = loginService(c.now, 60_000)
    const first = login.request(' 13800001111 ')
    const second = login.request('13800002222')
    if (!first.ok || !second.ok) throw new Error('unreachable')
    expect(first.challenge).toMatchObject({
      loginId: 'login-1',
      phone: '13800001111',
      code: '000000',
      expiresAt: 61_000,
    })
    expect(second.challenge.loginId).toBe('login-2')
    expect(second.challenge.code).toBe('000001')
  })

  it('缺省随机源与缺省 TTL 都能工作', () => {
    const c = clock()
    const login = new MockSmsLoginService({ users: USERS, now: c.now })
    const result = login.request('13800001111')
    if (!result.ok) throw new Error('unreachable')
    expect(result.challenge.code).toMatch(/^\d{6}$/)
    expect(result.challenge.expiresAt).toBe(c.now() + 5 * 60 * 1000)
  })

  it('未知登录 / 验证码不符 / 过期：结构化失败', () => {
    const c = clock()
    const login = loginService(c.now, 1_000)
    expect(login.verify('login-unknown', '000000')).toEqual({ ok: false, code: 'login-unknown' })

    const result = login.request('13800001111')
    if (!result.ok) throw new Error('unreachable')
    expect(login.verify(result.challenge.loginId, '999999')).toEqual({
      ok: false,
      code: 'code-mismatch',
    })

    c.advance(1_000)
    expect(login.verify(result.challenge.loginId, '000000')).toEqual({
      ok: false,
      code: 'code-expired',
    })
  })

  it('验证成功：返回 userId 且验证码一次性', () => {
    const login = loginService(clock().now)
    const result = login.request('13800002222')
    if (!result.ok) throw new Error('unreachable')
    expect(login.verify(result.challenge.loginId, '000000')).toEqual({ ok: true, userId: 'u-2' })
    expect(login.verify(result.challenge.loginId, '000000')).toEqual({
      ok: false,
      code: 'login-unknown',
    })
  })
})

describe('IM 映射', () => {
  it('登记 / 解析 / 未登记', () => {
    const im = new ImIdentityMap()
    im.register(' im-1 ', ' u-9 ')
    expect(im.resolve('im-1')).toBe('u-9')
    expect(im.resolve(' im-1 ')).toBe('u-9')
    expect(im.resolve('im-2')).toBeUndefined()
  })

  it('空 ID：identity-invalid', () => {
    const im = new ImIdentityMap()
    expect(captureThrown(() => im.register('', 'u-1')).code).toBe('identity-invalid')
    expect(captureThrown(() => im.register('im-1', ' ')).code).toBe('identity-invalid')
  })
})

describe('凭证服务（三个渠道的统一入口）', () => {
  it('短信登录成功：绑定当前会话（method = mock-login）', () => {
    const c = clock()
    const port = bindingPort()
    const service = new CredentialsService({
      login: loginService(c.now),
      im: new ImIdentityMap(),
      binding: port.binding,
    })
    const requested = service.requestSmsLogin('13800001111')
    if (!requested.ok) throw new Error('unreachable')
    const done = service.completeSmsLogin(
      asSessionId('s-1'),
      requested.challenge.loginId,
      requested.challenge.code,
    )
    expect(done).toEqual({ ok: true, userId: 'u-1' })
    expect(port.calls).toEqual([
      { sessionId: 's-1', userId: 'u-1', method: 'mock-login' },
    ])
  })

  it('短信验证码错误：不绑定（默认拒绝）', () => {
    const port = bindingPort()
    const service = new CredentialsService({
      login: loginService(clock().now),
      im: new ImIdentityMap(),
      binding: port.binding,
    })
    const requested = service.requestSmsLogin('13800001111')
    if (!requested.ok) throw new Error('unreachable')
    const done = service.completeSmsLogin(
      asSessionId('s-1'),
      requested.challenge.loginId,
      '000009',
    )
    expect(done).toEqual({ ok: false, code: 'code-mismatch' })
    expect(port.calls).toHaveLength(0)
  })

  it('IM 绑定：未登记 im-user-unknown；登记后成功（method = im-map）', () => {
    const port = bindingPort()
    const service = new CredentialsService({
      login: loginService(clock().now),
      im: new ImIdentityMap(),
      binding: port.binding,
    })
    expect(service.bindImUser(asSessionId('s-1'), 'im-1')).toEqual({
      ok: false,
      code: 'im-user-unknown',
    })
    service.registerImUser('im-1', 'u-2')
    expect(service.bindImUser(asSessionId('s-1'), 'im-1')).toEqual({ ok: true, userId: 'u-2' })
    expect(port.calls).toEqual([{ sessionId: 's-1', userId: 'u-2', method: 'im-map' }])
  })

  it('Web 登录页接缝：bindSession 校验空 ID；成功即绑定', () => {
    const port = bindingPort()
    const service = new CredentialsService({
      login: loginService(clock().now),
      im: new ImIdentityMap(),
      binding: port.binding,
    })
    expect(captureThrown(() => service.bindSession(asSessionId('s-1'), '  ')).code).toBe(
      'identity-invalid',
    )
    service.bindSession(asSessionId('s-1'), ' u-1 ')
    expect(port.calls).toEqual([{ sessionId: 's-1', userId: 'u-1', method: 'mock-login' }])
  })

  it('确定性随机源：同种子得到同一验证码（快照可复现）', () => {
    const a = new MockSmsLoginService({ users: USERS, now: () => 0, random: seededRandom(7) })
    const b = new MockSmsLoginService({ users: USERS, now: () => 0, random: seededRandom(7) })
    const first = a.request('13800001111')
    const second = b.request('13800001111')
    if (!first.ok || !second.ok) throw new Error('unreachable')
    expect(first.challenge.code).toBe(second.challenge.code)
  })
})
