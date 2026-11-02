/**
 * 导航白名单（T-DTB-005）。这是桌面壳最容易被绕过的一道闸：页面里任何一段
 * 可注入文本都可能变成 `location.href`。
 */

import { describe, expect, it } from 'vitest'

import { isAllowedNavigation, LOOPBACK_HOST, loopbackOrigin, loopbackPrefix } from './navigation.ts'

const PORT = 51234

describe('isAllowedNavigation（T-DTB-005）', () => {
  it('同源 loopback 放行（含子路径、查询串、hash）', () => {
    for (const url of [
      `http://127.0.0.1:${String(PORT)}/`,
      `http://127.0.0.1:${String(PORT)}/index.html`,
      `http://127.0.0.1:${String(PORT)}/m.html?x=1`,
      `http://127.0.0.1:${String(PORT)}/#panel-audit-box`,
    ]) {
      expect(isAllowedNavigation(url, PORT), url).toBe(true)
    }
  })

  it('相对 URL 按回环源解析（`/foo` 是同源，`//evil` 不是）', () => {
    expect(isAllowedNavigation('/foo', PORT)).toBe(true)
    expect(isAllowedNavigation('//evil.example/x', PORT)).toBe(false)
  })

  it('外域 / 其它协议 / 本机其它端口一律拒绝', () => {
    for (const url of [
      'https://example.com/',
      'https://example.com/steal?t=1',
      `http://127.0.0.1:${String(PORT + 1)}/`,
      'http://localhost:51234/',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'about:blank',
      // 端口前缀相同但实际端口不同的经典绕过
      `http://127.0.0.1:${String(PORT)}1/`,
      'http://127.0.0.1.evil.example/',
      'http://[::1]:51234/',
    ]) {
      expect(isAllowedNavigation(url, PORT), url).toBe(false)
    }
  })

  it('尾点/大小写变体由 URL 解析器归一化，因此等价于同源（放行是正确的）', () => {
    // 这条断言值钱的地方在于"知道谁在做归一化"：`new URL('http://127.0.0.1.:p/')`
    // 的 hostname 会被 WHATWG URL **规范化为 `127.0.0.1`**。所以放行它不是漏洞，
    // 而是"同一个 origin 的另一种写法"。反过来若我们自己写字符串前缀比较，
    // 这条会变成绕过点——这正是 isAllowedNavigation 走 URL 解析而不是 startsWith 的理由。
    expect(new URL(`http://127.0.0.1.:${String(PORT)}/`).hostname).toBe('127.0.0.1')
    expect(isAllowedNavigation(`http://127.0.0.1.:${String(PORT)}/`, PORT)).toBe(true)
  })

  it('空串与非法 URL 不放行', () => {
    // 空串必须显式拒：`new URL('', base)` 会返回 base 本身（等价"重载当前页"）
    expect(isAllowedNavigation('', PORT)).toBe(false)
    expect(isAllowedNavigation('   ', PORT)).toBe(false)
    // 解析不出来的串（`http://` 缺主机）一律拒
    expect(isAllowedNavigation('http://', PORT)).toBe(false)
  })
})

describe('loopbackOrigin / loopbackPrefix', () => {
  it('origin 不含尾斜杠，prefix 含尾斜杠', () => {
    expect(loopbackOrigin(PORT)).toBe(`http://${LOOPBACK_HOST}:${String(PORT)}`)
    expect(loopbackPrefix(PORT)).toBe(`${loopbackOrigin(PORT)}/`)
  })

  it('origin 前缀不能代替解析判定（同前缀不同端口必须拒）', () => {
    // 经典绕过：`http://127.0.0.1:51234` 是 `http://127.0.0.1:512341/` 的**字符串前缀**。
    // 若判据写成 `url.startsWith(loopbackOrigin(port))`，这一条就会被放行。
    const origin = loopbackOrigin(PORT)
    const sneaky = `http://127.0.0.1:${String(PORT)}1/`
    expect(sneaky.startsWith(origin)).toBe(true)
    expect(isAllowedNavigation(sneaky, PORT)).toBe(false)
    // 带尾斜杠的前缀反而不会误命中（`51234/` ≠ `512341/`）——所以"前缀是否带斜杠"
    // 根本不是判据；真正的判据是 URL 解析后的端口全等。
    expect(sneaky.startsWith(loopbackPrefix(PORT))).toBe(false)
  })
})
