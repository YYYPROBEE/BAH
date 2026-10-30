import { describe, expect, it } from 'vitest'

import {
  computeWechatSignature,
  verifyWechatSignature,
  WECHAT_SIGNATURE_WINDOW_SEC,
} from './signature.ts'

const TOKEN = 'test-callback-token'
const NOW = 1_793_000_000

/** 生成一份合法输入（签名自算，不写死十六进制——写死会在算法改动后静默失效）。 */
function valid(overrides: Partial<Parameters<typeof verifyWechatSignature>[0]> = {}) {
  const timestamp = String(NOW)
  const nonce = '1234567890'
  return {
    token: TOKEN,
    timestamp,
    nonce,
    nowSec: NOW,
    signature: computeWechatSignature(TOKEN, timestamp, nonce),
    ...overrides,
  }
}

describe('computeWechatSignature', () => {
  it('按 [token,timestamp,nonce].sort() 拼串取 sha1', () => {
    // 与微信文档给的示例算法逐字一致：排序后拼接，与入参顺序无关
    const a = computeWechatSignature('t', '1', 'n')
    const b = computeWechatSignature('n', 't', '1')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('verifyWechatSignature（T-IM-008）', () => {
  it('合法签名 → ok', () => {
    expect(verifyWechatSignature(valid())).toEqual({ ok: true })
  })

  it('大写签名也认（十六进制不区分大小写）', () => {
    expect(verifyWechatSignature(valid({ signature: valid().signature.toUpperCase() }))).toEqual({
      ok: true,
    })
  })

  it('签名错 → mismatch', () => {
    expect(verifyWechatSignature(valid({ signature: 'deadbeef' }))).toEqual({
      ok: false,
      code: 'mismatch',
    })
  })

  it('缺 token / signature / timestamp / nonce 任一 → missing', () => {
    expect(verifyWechatSignature(valid({ token: '' }))).toEqual({ ok: false, code: 'missing' })
    expect(verifyWechatSignature(valid({ signature: '' }))).toEqual({ ok: false, code: 'missing' })
    expect(verifyWechatSignature(valid({ timestamp: '' }))).toEqual({ ok: false, code: 'missing' })
    expect(verifyWechatSignature(valid({ nonce: '' }))).toEqual({ ok: false, code: 'missing' })
  })

  it('timestamp 不是 10 位秒级整数 → stale', () => {
    expect(verifyWechatSignature(valid({ timestamp: '17930000000' }))).toEqual({
      ok: false,
      code: 'stale',
    })
    expect(verifyWechatSignature(valid({ timestamp: 'abc' }))).toEqual({ ok: false, code: 'stale' })
  })

  it('早于窗口 → stale；晚于窗口也 stale（未来时间不能绕过重放保护）', () => {
    const stalePast = String(NOW - WECHAT_SIGNATURE_WINDOW_SEC - 1)
    const staleFuture = String(NOW + WECHAT_SIGNATURE_WINDOW_SEC + 1)
    expect(
      verifyWechatSignature(
        valid({ timestamp: stalePast, signature: computeWechatSignature(TOKEN, stalePast, '1234567890') }),
      ),
    ).toEqual({ ok: false, code: 'stale' })
    expect(
      verifyWechatSignature(
        valid({ timestamp: staleFuture, signature: computeWechatSignature(TOKEN, staleFuture, '1234567890') }),
      ),
    ).toEqual({ ok: false, code: 'stale' })
  })

  it('窗口边界值仍放行（±600 不走 off-by-one）', () => {
    const edge = String(NOW - WECHAT_SIGNATURE_WINDOW_SEC)
    expect(
      verifyWechatSignature(
        valid({ timestamp: edge, signature: computeWechatSignature(TOKEN, edge, '1234567890') }),
      ),
    ).toEqual({ ok: true })
  })

  it('nonce 超长 → nonce', () => {
    const nonce = 'x'.repeat(129)
    expect(
      verifyWechatSignature(
        valid({ nonce, signature: computeWechatSignature(TOKEN, String(NOW), nonce) }),
      ),
    ).toEqual({ ok: false, code: 'nonce' })
  })

  it('长度相等但内容不同 → timingSafeEqual 返回 false 的分支', () => {
    // 40 个 f 与 sha1 输出等长：走常量时间比较，而不是长度短路
    expect(verifyWechatSignature(valid({ signature: 'f'.repeat(40) }))).toEqual({
      ok: false,
      code: 'mismatch',
    })
  })

  it('长度不等先短路（不让 timingSafeEqual 抛）', () => {
    expect(verifyWechatSignature(valid({ signature: 'abc' }))).toEqual({
      ok: false,
      code: 'mismatch',
    })
  })
})

describe('负控：失败结论只给 code，不回显期望值', () => {
  it('签名错时不泄漏正确签名', () => {
    const verdict = verifyWechatSignature(valid({ signature: 'wrong' }))
    expect(verdict).not.toHaveProperty('expected')
  })
})
