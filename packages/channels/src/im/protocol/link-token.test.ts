/**
 * H5 审批链接（施工单 03 T-IM-015）。
 *
 * 每条安全性质都要有"改一位就红"的对照：签名、过期、版本、畸形。
 */

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  APPROVAL_LINK_MAX_TTL_MS,
  signApprovalLink,
  verifyApprovalLink,
  type ApprovalLinkPayload,
} from './link-token.ts'

const SECRET = 'link-secret-0123456789abcdefghij'
const SESSION = 'im-0123456789abcdef'
const NOW = 1_793_000_000_000

function payload(overrides: Partial<ApprovalLinkPayload> = {}): ApprovalLinkPayload {
  return {
    v: 1,
    s: SESSION,
    t: 'ticket:abc-1',
    e: NOW + APPROVAL_LINK_MAX_TTL_MS,
    ...overrides,
  }
}

/** 用同一密钥手工签任意 JSON（测"签名通过但载荷不合法"）。 */
function signRaw(json: string, secret = SECRET): string {
  const part = Buffer.from(json, 'utf8').toString('base64url')
  return `${part}.${createHmac('sha256', secret).update(part).digest('base64url')}`
}

/** 取抛出的错误码。 */
function codeOf(run: () => unknown): string {
  try {
    run()
    return 'no-throw'
  } catch (error) {
    return (error as { code?: string }).code ?? 'not-bah-error'
  }
}

describe('signApprovalLink / verifyApprovalLink', () => {
  it('正确签名 → ok，且载荷逐字段还原', () => {
    const token = signApprovalLink(payload(), SECRET)
    const verdict = verifyApprovalLink(token, SECRET, NOW)
    expect(verdict).toEqual({ ok: true, payload: payload() })
  })

  it('密钥不足 32 字符 → 签名前 fail-loud', () => {
    expect(codeOf(() => signApprovalLink(payload(), 'x'.repeat(31)))).toBe('im-link-secret-weak')
  })

  it('载荷字段非法 → im-link-payload-invalid（不签一条无法校验的链接）', () => {
    expect(codeOf(() => signApprovalLink(payload({ e: 0 }), SECRET))).toBe('im-link-payload-invalid')
    expect(codeOf(() => signApprovalLink(payload({ e: 1.5 }), SECRET))).toBe('im-link-payload-invalid')
    expect(codeOf(() => signApprovalLink(payload({ s: 'not-a-session' }), SECRET))).toBe(
      'im-link-payload-invalid',
    )
    expect(codeOf(() => signApprovalLink(payload({ t: 'bad ticket' }), SECRET))).toBe(
      'im-link-payload-invalid',
    )
  })

  it('改一位明文 → bad-signature（不改签名）', () => {
    const token = signApprovalLink(payload(), SECRET)
    const [part, signature] = token.split('.')
    const decoded = Buffer.from(part ?? '', 'base64url').toString('utf8')
    const tampered = decoded.replace('ticket:abc-1', 'ticket:abc-2')
    const forged = `${Buffer.from(tampered, 'utf8').toString('base64url')}.${signature ?? ''}`
    expect(verifyApprovalLink(forged, SECRET, NOW)).toEqual({ ok: false, code: 'bad-signature' })
  })

  it('改一位签名 → bad-signature', () => {
    const token = signApprovalLink(payload(), SECRET)
    const flipped = token.endsWith('A') ? `${token.slice(0, -1)}B` : `${token.slice(0, -1)}A`
    expect(verifyApprovalLink(flipped, SECRET, NOW)).toEqual({ ok: false, code: 'bad-signature' })
  })

  it('签名长度不等 → bad-signature（走同长比较，不提前返回）', () => {
    const [part] = signApprovalLink(payload(), SECRET).split('.')
    expect(verifyApprovalLink(`${part ?? ''}.abc`, SECRET, NOW)).toEqual({
      ok: false,
      code: 'bad-signature',
    })
  })

  it('到期（now === e）→ expired，绝不按未过期处理', () => {
    const token = signApprovalLink(payload({ e: NOW }), SECRET)
    expect(verifyApprovalLink(token, SECRET, NOW)).toEqual({ ok: false, code: 'expired' })
  })

  it('v:2 → unsupported（版本不兼容不降级）', () => {
    const token = signRaw(JSON.stringify({ v: 2, s: SESSION, t: 'ticket:abc', e: NOW + 1000 }))
    expect(verifyApprovalLink(token, SECRET, NOW)).toEqual({ ok: false, code: 'unsupported' })
  })

  it('畸形 token → malformed（空串 / 无点 / 多点 / 空段 / 超长）', () => {
    const long = 'a'.repeat(1100)
    for (const token of ['', 'abc', 'a.b.c', '.sig', 'part.', long]) {
      expect(verifyApprovalLink(token, SECRET, NOW)).toEqual({ ok: false, code: 'malformed' })
    }
  })

  it('签名通过但 JSON 畸形 / 字段非法 → malformed', () => {
    const cases = [
      'not-json',
      JSON.stringify({ v: 1, s: 'bad', t: 'ticket:abc', e: NOW + 1 }),
      JSON.stringify({ v: 1, s: SESSION, t: 'bad ticket', e: NOW + 1 }),
      JSON.stringify({ v: 1, s: SESSION, t: 'ticket:abc', e: 'x' }),
      JSON.stringify({ v: 1, s: SESSION, t: 'ticket:abc', e: -1 }),
    ]
    for (const json of cases) {
      expect(verifyApprovalLink(signRaw(json), SECRET, NOW)).toEqual({
        ok: false,
        code: 'malformed',
      })
    }
  })
})
