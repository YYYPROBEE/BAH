/**
 * 认证配置面（租户与鉴权 02 · TA-20）。
 *
 * 三条判据：**不写 = static**（A3 的硬门槛）、非法模式 fail-loud、password 缺目录 fail-loud。
 */

import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { DEFAULT_AUTH, resolveAuthSettings } from './config.ts'

/** 取错误码。 */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof BahError) return error.code
    throw error
  }
  throw new Error('期望抛错，但没有抛')
}

describe('resolveAuthSettings', () => {
  it('TA-20-1 不写 → 默认 static（8 个 profile 与 7 个快照靠它零变化）', () => {
    const settings = resolveAuthSettings(undefined)
    expect(settings.mode).toBe('static')
    expect(settings).toEqual(DEFAULT_AUTH)
    expect(settings.cookie.name).toBe('bah_sid')
    expect(settings.session.absoluteMs).toBe(28_800_000)
  })

  it('TA-20-2 非法模式 → web-invalid-config（不静默回落 static）', () => {
    expect(codeOf(() => resolveAuthSettings({ mode: 'jwt' }))).toBe('web-invalid-config')
  })

  it('TA-20-3 password 缺 directory.path → boot 期就抛（不等到第一次登录）', () => {
    // 空路径先被 readString 拒（boot 的 invalid-config）——两个码都表示"启动期就失败"
    expect(codeOf(() => resolveAuthSettings({ mode: 'password', directory: { path: '  ' } }))).toBe(
      'invalid-config',
    )
  })

  it('TA-20-4 未知键 / idle > absolute → 各自 fail-loud', () => {
    expect(codeOf(() => resolveAuthSettings({ mode: 'static', nope: 1 }))).toBe('unknown-config-key')
    expect(
      codeOf(() =>
        resolveAuthSettings({ session: { idleMs: 10, absoluteMs: 5 } }),
      ),
    ).toBe('web-invalid-config')
  })

  it('TA-20-5 逐块覆盖：只写 cookie，其余取默认', () => {
    const settings = resolveAuthSettings({ mode: 'password', cookie: { secure: true } })
    expect(settings.cookie).toEqual({ name: 'bah_sid', secure: true })
    expect(settings.session).toEqual(DEFAULT_AUTH.session)
    expect(settings.login).toEqual(DEFAULT_AUTH.login)
  })

  it('TA-20-6 cookie.name 会拼进 Set-Cookie：分号/空格/域名一律 fail-loud（配置注入）', () => {
    for (const name of ['bah_sid; Domain=evil', 'a b', 'sid=1']) {
      expect(
        codeOf(() => resolveAuthSettings({ mode: 'password', cookie: { name } })),
      ).toBe('web-invalid-config')
    }
    // 空串在更早的一层就被拒绝（readString 的 invalid-config）——同样是启动期失败
    expect(codeOf(() => resolveAuthSettings({ mode: 'password', cookie: { name: '' } }))).toBe(
      'invalid-config',
    )
    expect(resolveAuthSettings({ cookie: { name: 'bah_sid_v2' } }).cookie.name).toBe('bah_sid_v2')
  })
})
