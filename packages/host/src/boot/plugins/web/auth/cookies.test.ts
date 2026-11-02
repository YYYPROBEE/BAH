/**
 * 认证 cookie 的两个头（租户与鉴权 02 · TA-26）。
 *
 * 现有用例只在登录链路上间接断言了 `HttpOnly` / `SameSite=Strict`，
 * HTTPS 部署的 `Secure` 属性与 `Max-Age` 的取整/钳位没有任何直接判据——
 * 少一个 `Secure`，会话 cookie 会随明文请求发出去。
 */

import { describe, expect, it } from 'vitest'

import { clearSessionCookieHeader, sessionCookieHeader } from './cookies.ts'

describe('sessionCookieHeader', () => {
  it('HTTPS：HttpOnly + SameSite=Strict + Secure + Path 全部在位', () => {
    expect(sessionCookieHeader('bah_sid', 'sid-1', 3600, true)).toBe(
      'bah_sid=sid-1; Path=/; SameSite=Strict; Max-Age=3600; HttpOnly; Secure',
    )
  })

  it('HTTP（本地/内网）：不带 Secure，其余安全属性不缩水', () => {
    const header = sessionCookieHeader('bah_sid', 'sid-1', 3600, false)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
    expect(header).not.toContain('Secure')
  })

  it('Max-Age 向下取整、负数钳到 0（配置或时钟异常时立即失效，不产生负寿命）', () => {
    expect(sessionCookieHeader('bah_sid', 'sid-1', 59.9, false)).toContain('Max-Age=59')
    expect(sessionCookieHeader('bah_sid', 'sid-1', -5, false)).toContain('Max-Age=0')
  })
})

describe('clearSessionCookieHeader', () => {
  it('登出：空值 + Max-Age=0，且仍带 HttpOnly / Secure', () => {
    expect(clearSessionCookieHeader('bah_sid', true)).toBe(
      'bah_sid=; Path=/; SameSite=Strict; Max-Age=0; HttpOnly; Secure',
    )
  })
})
