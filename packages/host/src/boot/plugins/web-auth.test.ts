/**
 * Web 凭证的纯函数面：读取、生成、注入、出示。
 *
 * 路由级行为（401 / SSE 查询参数）在 `web.test.ts` 里用真实 HTTP 验。
 */

import { describe, expect, it } from 'vitest'

import {
  generateWebToken,
  injectWebToken,
  presentedWebToken,
  readWebToken,
  WEB_TOKEN_ENV,
  WEB_TOKEN_META,
} from './web-auth.ts'

describe('Web token 读取与生成', () => {
  it('未设置 / 空白 → undefined（调用方生成一次性 token）', () => {
    expect(readWebToken({})).toBeUndefined()
    expect(readWebToken({ [WEB_TOKEN_ENV]: '' })).toBeUndefined()
    expect(readWebToken({ [WEB_TOKEN_ENV]: '   ' })).toBeUndefined()
  })

  it('去首尾空白后返回', () => {
    expect(readWebToken({ [WEB_TOKEN_ENV]: '  abc  ' })).toBe('abc')
  })

  it('生成的 token 是 URL 安全且每次不同', () => {
    const first = generateWebToken()
    const second = generateWebToken()
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })
})

describe('token 注入 index.html', () => {
  it('插到 </head> 前，并替换同名的旧标签', () => {
    const html = `<html><head><meta name="${WEB_TOKEN_META}" content="old" /><title>x</title></head><body></body></html>`
    const injected = injectWebToken(html, 'new-token')
    expect(injected).toContain(`<meta name="${WEB_TOKEN_META}" content="new-token" />`)
    expect(injected).not.toContain('content="old"')
    expect(injected.indexOf('new-token')).toBeLessThan(injected.indexOf('</head>'))
  })

  it('属性值转义（token 由我们生成，但不假设上游永远规矩）', () => {
    const injected = injectWebToken('<head></head>', 'a"b<c&d')
    expect(injected).toContain('content="a&quot;b&lt;c&amp;d"')
  })

  it('没有 head 时放在最前（仍可被浏览器解析）', () => {
    expect(injectWebToken('<html></html>', 't')).toContain('bah-web-token')
  })
})

describe('出示凭证', () => {
  it('优先 Authorization 头', () => {
    expect(presentedWebToken({ authorization: 'Bearer a' }, 'b')).toBe('Bearer a')
  })

  it('没有头时才用查询参数（仅 SSE）', () => {
    expect(presentedWebToken({}, 'q')).toBe('Bearer q')
    expect(presentedWebToken({}, null)).toBeUndefined()
    expect(presentedWebToken({}, '')).toBeUndefined()
  })
})
