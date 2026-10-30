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

/** 注释外的凭证 meta（"响应体 contains"分不清注释里的示意文本与真标签）。 */
function realMeta(html: string): string | null {
  const bare = html.replace(/<!--[\s\S]*?-->/g, '')
  const match = /<meta name="bah-web-token" content="([^"]*)" \/>/.exec(bare)
  return match === null ? null : (match[1] ?? '')
}

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

  it('注释里的 head 结束标记 / 同名 meta 示例不改变注入点（2026-10-29 P0-1 回归）', () => {
    const html =
      '<html><head><!-- 响应时会在 </head> 前插入 <meta name="bah-web-token" content="…" /> --><title>x</title></head><body></body></html>'
    const injected = injectWebToken(html, 'real-token')
    // 送达的页面不再带开发注释 ⇒ "有凭证串"只可能是真标签
    expect(injected).not.toContain('<!--')
    expect(realMeta(injected)).toBe('real-token')
    const meta = `<meta name="${WEB_TOKEN_META}" content="real-token" />`
    expect(injected.indexOf(meta)).toBeLessThan(injected.toLowerCase().indexOf('</head>'))
  })

  it('同名旧 meta 全部移除（不只第一个）', () => {
    const html =
      '<html><head><meta name="bah-web-token" content="old-a" /><meta name="bah-web-token" content="old-b" /></head><body></body></html>'
    const injected = injectWebToken(html, 'new-token')
    expect(realMeta(injected)).toBe('new-token')
    expect(injected).not.toContain('old-a')
    expect(injected).not.toContain('old-b')
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
