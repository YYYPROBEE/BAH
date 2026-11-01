/**
 * CSRF 同源判定（租户与鉴权 04 · TA-52）。
 *
 * 旧实现写死 `origin === 'http://' + Host`：HTTPS / 反代下浏览器的 Origin 是 `https://…`，
 * 所有写请求都会 403。这里钉住"只比 host 段 + 协议开关"的四条边界，
 * **不放松** double-submit 那条路径（缺 cookie/头仍是 403）。
 */

import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { csrfVerdict, sameOriginHost } from './csrf.ts'

/** 最小请求桩（只给 csrfVerdict 读的三个头）。 */
function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('TA-52 · sameOriginHost', () => {
  it('HTTP 同 host（含端口）→ 同源；端口不同 → 不同源', () => {
    expect(sameOriginHost('http://x:7331', 'x:7331')).toBe(true)
    expect(sameOriginHost('http://x:7331', 'x')).toBe(false)
    expect(sameOriginHost('http://x', 'x:7331')).toBe(false)
  })

  it('HTTPS 只在 allowHttps（cookie.secure）时放行；HTTP 在 secure 开关下不再被接受', () => {
    expect(sameOriginHost('https://x', 'x', { allowHttps: false })).toBe(false)
    expect(sameOriginHost('https://x', 'x', { allowHttps: true })).toBe(true)
    // 整站 HTTPS 的部署里，http Origin 不允许（避免降级）
    expect(sameOriginHost('http://x', 'x', { allowHttps: true })).toBe(false)
  })

  it('默认端口归一化：https://x 与 Host: x:443 同源', () => {
    expect(sameOriginHost('https://x', 'x:443', { allowHttps: true })).toBe(true)
  })

  it('畸形 Origin / 带凭据的 Origin / 空 Host → 不同源（不抛）', () => {
    expect(sameOriginHost('not a url', 'x')).toBe(false)
    expect(sameOriginHost('http://user:pass@x', 'x')).toBe(false)
    expect(sameOriginHost('http://x', '')).toBe(false)
    expect(sameOriginHost('http://x', undefined)).toBe(false)
    expect(sameOriginHost('ftp://x', 'x')).toBe(false)
  })

  it('畸形 **Host** 头（Origin 本身合法）→ 不同源：解析不了就 fail-closed', () => {
    // Host 是外部可控头：`[::1`（IPv6 字面量没闭合）、多冒号端口都会让 URL 解析抛错。
    // 抛错必须落成 `false`（→ 403），既不能冒出异常打断整条请求，也不能当同源放行。
    expect(sameOriginHost('http://x', '[::1')).toBe(false)
    expect(sameOriginHost('http://x', 'x:7331:80')).toBe(false)
    expect(sameOriginHost('https://x', '[::1', { allowHttps: true })).toBe(false)
    // 同一个畸形 Host 走 csrfVerdict：Origin 在场时不做同源判定就直接判 mismatch
    expect(csrfVerdict(req({ origin: 'http://x', host: '[::1' }), 'tok', {})).toBe('mismatch')
  })
})

describe('TA-52 · csrfVerdict 走 Origin 路径', () => {
  it('https Origin + secure:true → pass；secure:false → mismatch', () => {
    expect(csrfVerdict(req({ origin: 'https://x', host: 'x' }), 'tok', { allowHttps: true })).toBe(
      'pass',
    )
    expect(csrfVerdict(req({ origin: 'https://x', host: 'x' }), 'tok', { allowHttps: false })).toBe(
      'mismatch',
    )
  })

  it('Origin 缺失时仍走 double-submit：什么都没有 → missing，不一致 → mismatch', () => {
    expect(csrfVerdict(req({ host: 'x' }), 'tok')).toBe('missing')
    expect(
      csrfVerdict(
        req({ host: 'x', cookie: 'bah_csrf=a', 'x-bah-csrf': 'b' }),
        'tok',
      ),
    ).toBe('mismatch')
    expect(
      csrfVerdict(req({ host: 'x', cookie: 'bah_csrf=tok', 'x-bah-csrf': 'tok' }), 'tok'),
    ).toBe('pass')
  })
})
