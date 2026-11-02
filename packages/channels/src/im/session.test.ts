/**
 * IM 会话键用例。
 *
 * 判据重点是**不可逆与命名空间隔离**：ID 里不能出现原文子串，同一 userId 换平台必须换 ID。
 */

import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { IM_SESSION_ID_PATTERN, assertImSessionId, deriveImSessionId } from './session.ts'

const SALT = 'im-session-salt-01'

/** 取出结构化理由码（`BahError.message` 是人话，码在 `.code`）。 */
function codeOf(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof BahError ? error.code : 'not-bah-error'
  }
}

describe('deriveImSessionId（T-CH-007）', () => {
  it('同 (platform,userId) + 同 salt 两次派生相同（重启可回放）', () => {
    const first = deriveImSessionId('wechat', 'openid-alice', SALT)
    const second = deriveImSessionId('wechat', 'openid-alice', SALT)
    expect(first).toBe(second)
    expect(IM_SESSION_ID_PATTERN.test(first)).toBe(true)
  })

  it('同一 userId 在 wechat / mock 上是两个会话（命名空间隔离）', () => {
    const wechat = deriveImSessionId('wechat', 'openid-alice', SALT)
    const mock = deriveImSessionId('mock', 'openid-alice', SALT)
    expect(wechat).not.toBe(mock)
  })

  it('不同 userId 派生不同 ID', () => {
    expect(deriveImSessionId('wechat', 'a', SALT)).not.toBe(deriveImSessionId('wechat', 'b', SALT))
  })

  it('salt 不同则 ID 不同（盐不是装饰）', () => {
    const left = deriveImSessionId('wechat', 'openid-alice', 'salt-aaaaaaaaaaaa')
    const right = deriveImSessionId('wechat', 'openid-alice', 'salt-bbbbbbbbbbbb')
    expect(left).not.toBe(right)
  })
})

describe('deriveImSessionId 非法输入（T-CH-008）', () => {
  it('空 platform / 空 userId / 短 salt 一律抛 im-*', () => {
    expect(codeOf(() => deriveImSessionId('', 'u', SALT))).toBe('im-empty-platform')
    expect(codeOf(() => deriveImSessionId('wechat', '   ', SALT))).toBe('im-empty-user')
    expect(codeOf(() => deriveImSessionId('wechat', 'u', 'short'))).toBe('im-weak-session-salt')
  })

  it('派生的 ID 不含平台或用户的原文子串', () => {
    const id = deriveImSessionId('wechat', 'openid-alice', SALT)
    expect(id).not.toContain('wechat')
    expect(id).not.toContain('openid')
    expect(id).not.toContain('alice')
  })

  it('assertImSessionId：合法原样返回，非法抛 im-invalid-session-id', () => {
    const valid = deriveImSessionId('wechat', 'openid-alice', SALT)
    expect(assertImSessionId(valid)).toBe(valid)
    expect(codeOf(() => assertImSessionId('im-XYZ'))).toBe('im-invalid-session-id')
    expect(codeOf(() => assertImSessionId('openid-alice'))).toBe('im-invalid-session-id')
    expect(codeOf(() => assertImSessionId('im-0123456789abcdef0'))).toBe('im-invalid-session-id')
  })
})
