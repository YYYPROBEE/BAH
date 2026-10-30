/**
 * 静态资源的 token 白名单用例（施工单 01 §5 TC-MCH-12..16 / §3.8 安全不变量）
 * + 坐席入口（人机接管 02 · B1）。
 *
 * 这里不启服务：直接调 `handleStatic` 并检查响应头 / 响应体，速度更快也更容易造
 * "白名单外的 HTML"。**真实 curl 矩阵**另存 `docs/evidence/.../01-static-matrix.txt`。
 *
 * 坐席入口的三条安全性质：
 * 1. `seatEnabled=false`（未配 `BAH_OPERATOR_TOKEN` 或不是 web 渠道）⇒ `/operator` 与
 *    `/operator.html` 都 404（不暴露存在性）；
 * 2. 两个入口都**零注入**：响应体不含 web token / 坐席 token / `bah-web-token` meta；
 * 3. 客户首页仍然照旧注入 token + CSRF cookie（回归，不许被 B1 带坏）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IncomingMessage, ServerResponse } from 'node:http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { WebDeps, WebRequest } from '../deps.ts'
import { handleStatic } from './static.ts'

/** 假响应：记录 status / headers / body。 */
interface Probe {
  status: number
  headers: Record<string, string>
  body: string
}

/** 造一个极简的 ServerResponse 桩（只覆盖 handleStatic 用到的四个方法）。 */
function fakeRes(): { res: ServerResponse; probe: Probe } {
  const probe: Probe = { status: 0, headers: {}, body: '' }
  const res = {
    writeHead(status: number, headers: Record<string, unknown> = {}): unknown {
      probe.status = status
      for (const [key, value] of Object.entries(headers)) probe.headers[key.toLowerCase()] = String(value)
      return res
    },
    end(chunk?: unknown): unknown {
      if (chunk !== undefined) probe.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      return res
    },
  }
  return { res: res as unknown as ServerResponse, probe }
}

/** 造请求（只有 `method` / `path` 被 handleStatic 读）。 */
function request(path: string, method = 'GET'): WebRequest {
  return { method, url: new URL(`http://127.0.0.1${path}`), path, rest: '' }
}

/** 一次静态请求。 */
async function call(deps: WebDeps, path: string, method = 'GET'): Promise<Probe> {
  const { res, probe } = fakeRes()
  await handleStatic({} as IncomingMessage, res, request(path, method), deps)
  return probe
}

const WEB_TOKEN = 'token-for-static-test'
const CSRF_TOKEN = 'csrf-for-static-test'
const OPERATOR_TOKEN = 'operator-token-secret'
const HTML = '<!doctype html><html><head><title>shell</title></head><body>hi</body></html>'
const SEAT_HTML = '<!doctype html><html><head><title>SEAT</title></head><body>SEAT</body></html>'
/** 注释里写着 head 结束标记与同名 meta 示例的入口（P0-1 的真实形态）。 */
const COMMENT_HTML =
  '<!doctype html><html><head><!-- 响应时会在 </head> 前插入 <meta name="bah-web-token" content="…" /> --><title>trap</title></head><body>trap</body></html>'

let root = ''

/** 静态根：五个 HTML（index 在默认白名单，m/other/operator/comment 不在）。 */
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-static-'))
  writeFileSync(join(dir, 'index.html'), HTML)
  writeFileSync(join(dir, 'm.html'), HTML)
  writeFileSync(join(dir, 'other.html'), HTML)
  writeFileSync(join(dir, 'operator.html'), SEAT_HTML)
  writeFileSync(join(dir, 'comment.html'), COMMENT_HTML)
  writeFileSync(join(dir, 'package.json'), '{"name":"leak"}')
  return dir
}

/**
 * 注释外的凭证 meta。
 *
 * WHY 不用 `body.includes('bah-web-token')`：注释里写一句示例文本也能让 contains 成立，
 * 而浏览器里根本没有这个元素——2026-10-29 移动走查 P0-1 就是被这种断言放过去的。
 */
function realTokenMeta(body: string): string | null {
  const bare = body.replace(/<!--[\s\S]*?-->/g, '')
  const match = /<meta name="bah-web-token" content="([^"]*)" \/>/.exec(bare)
  return match === null ? null : (match[1] ?? '')
}

/** 最小依赖面（只填 handleStatic 读到的字段）。 */
function depsOf(overrides: Partial<WebDeps> = {}): WebDeps {
  return {
    staticRoot: root,
    defaultEntry: join(root, 'index.html'),
    tokenEntries: [join(root, 'index.html')],
    operatorEntry: join(root, 'operator.html'),
    // 默认坐席面关闭：与"没配 BAH_OPERATOR_TOKEN"的部署一致
    seatEnabled: false,
    webToken: WEB_TOKEN,
    operatorToken: undefined,
    csrfToken: CSRF_TOKEN,
    // 入口注入只看 `auth.mode`；静态模式是改动前的行为（A3 基线）
    auth: { mode: 'static' },
    ...overrides,
  } as unknown as WebDeps
}

beforeAll(() => {
  root = makeRoot()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('静态入口：`/` 落点由 entry 决定（TC-MCH-12）', () => {
  it('entry=index.html ⇒ `/` 返回 index.html（注入 token）', async () => {
    const probe = await call(depsOf(), '/')
    expect(probe.status).toBe(200)
    expect(realTokenMeta(probe.body)).toBe(WEB_TOKEN)
    expect(probe.body).toContain('<title>shell</title>')
  })

  it('entry=m.html ⇒ `/` 返回 m.html（同一份静态根，不同壳）', async () => {
    const probe = await call(
      depsOf({ defaultEntry: join(root, 'm.html'), tokenEntries: [join(root, 'm.html')] }),
      '/',
    )
    expect(probe.status).toBe(200)
    expect(realTokenMeta(probe.body)).toBe(WEB_TOKEN)
  })

  it('注释里的 head 结束标记不是注入点：DOM 里必须有真 meta（P0-1 回归）', async () => {
    const probe = await call(
      depsOf({ tokenEntries: [join(root, 'comment.html')] }),
      '/comment.html',
    )
    expect(probe.status).toBe(200)
    expect(realTokenMeta(probe.body)).toBe(WEB_TOKEN)
    expect(probe.body).not.toContain('<!--')
  })
})

describe('password 模式：所有 token 入口都不承载口令（T-04.1）', () => {
  const passwordDeps = (overrides: Partial<WebDeps> = {}): WebDeps =>
    depsOf({ auth: { mode: 'password' } as WebDeps['auth'], ...overrides })

  it('多入口（index + m）：两页都无 token meta，都有 mode meta，都下发 CSRF cookie', async () => {
    const entries = [join(root, 'index.html'), join(root, 'm.html')]
    for (const entry of entries) {
      const probe = await call(passwordDeps({ tokenEntries: entries }), `/${entry.split(/[\\/]/).pop()}`)
      expect(probe.status).toBe(200)
      expect(probe.body).not.toContain('bah-web-token')
      expect(probe.body).toContain('<meta name="bah-auth-mode" content="password"')
      expect(probe.headers['set-cookie']).toContain('bah_csrf=')
      expect(probe.headers['cache-control']).toBe('no-store')
    }
  })

  it('static 模式多入口：两页都注入 token（对照组，证明差异只在 mode）', async () => {
    const entries = [join(root, 'index.html'), join(root, 'm.html')]
    for (const entry of entries) {
      const probe = await call(depsOf({ tokenEntries: entries }), `/${entry.split(/[\\/]/).pop()}`)
      expect(probe.body).toContain('bah-web-token')
      expect(probe.body).not.toContain('bah-auth-mode')
    }
  })

  it('password 模式下坐席入口未启用（D2 未做）→ 404；启用时只注入 mode + CSRF', async () => {
    const off = await call(passwordDeps(), '/operator')
    expect(off.status).toBe(404)

    const on = await call(passwordDeps({ seatEnabled: true }), '/operator')
    expect(on.status).toBe(200)
    expect(on.body).not.toContain('bah-web-token')
    expect(on.body).toContain('<meta name="bah-auth-mode" content="password"')
    expect(on.headers['set-cookie']).toContain('bah_csrf=')
  })
})

describe('白名单命中 ⇒ token / no-store / CSRF cookie 三件套（TC-MCH-13）', () => {
  it('/index.html ⇒ 200 + token meta + no-store + set-cookie + 5 个安全头', async () => {
    const probe = await call(depsOf(), '/index.html')
    expect(probe.status).toBe(200)
    expect(probe.body).toContain('<meta name="bah-web-token"')
    expect(probe.headers['cache-control']).toBe('no-store')
    expect(probe.headers['set-cookie']).toContain('bah_csrf=')
    expect(probe.headers['set-cookie']).toContain('Path=/')
    expect(probe.headers['set-cookie']).toContain('SameSite=Strict')
    // 不是 HttpOnly：double-submit 需要同源脚本读 cookie 回填请求头
    expect(probe.headers['set-cookie']).not.toContain('HttpOnly')
    for (const header of [
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
      'permissions-policy',
    ]) {
      expect(probe.headers[header]).toBeDefined()
    }
    expect(probe.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()')
  })
})

describe('白名单外 HTML 不注入（TC-MCH-14，安全不变量）', () => {
  it('/other.html ⇒ 200，但无 token、no-cache、无 set-cookie', async () => {
    const probe = await call(depsOf(), '/other.html')
    expect(probe.status).toBe(200)
    expect(probe.body).not.toContain('bah-web-token')
    expect(probe.headers['cache-control']).toBe('no-cache')
    expect(probe.headers['set-cookie']).toBeUndefined()
  })

  it('同一文件在另一个渠道的白名单里才注入：m.html 对 web（entries=[index]）不注入', async () => {
    const probe = await call(depsOf(), '/m.html')
    expect(probe.status).toBe(200)
    expect(probe.body).not.toContain('bah-web-token')
  })
})

describe('白名单绕过变形（TC-MCH-15）', () => {
  it('/index.html.bak ⇒ 404（不存在），不注入', async () => {
    const probe = await call(depsOf(), '/index.html.bak')
    expect(probe.status).toBe(404)
    expect(probe.body).not.toContain('bah-web-token')
  })

  it('//index.html 与 /./index.html ⇒ 归一化后是**同一个文件**，注入（不构成泄漏）', async () => {
    // ⚠ 施工单 01 §3.8 与 00 §8 C2 曾把这两种写法列为"不得注入"，这是事实错误：
    // `normalize` 后它们就是 index.html 本身，路径精确等值命中白名单。判安全性的判据不是
    // "拼写不同"，而是"**有没有别的文件**拿到 token"——见下一条。
    for (const path of ['//index.html', '/./index.html']) {
      const probe = await call(depsOf(), path)
      expect(probe.status).toBe(200)
      expect(probe.body).toContain('bah-web-token')
    }
  })

  it('/index.html/ 与 /index.html%2f ⇒ 只会是"同一文件"或 404；**任何平台都不得注入别的文件**', async () => {
    // Windows 的 readFile 会把尾随分隔符解析成同一文件（resolve 也把尾随分隔符抹掉 ⇒
    // 精确等值命中白名单，注入的是 index.html 本体）；POSIX 下目录不可读 ⇒ 404。
    // 判据不是"拼写"，而是"token 只可能出现在 index.html 这一个文件的内容里"。
    for (const path of ['/index.html/', '/index.html%2f']) {
      const probe = await call(depsOf(), path)
      expect([200, 404]).toContain(probe.status)
      if (probe.status === 200) expect(probe.body).toContain('bah-web-token')
      expect(probe.body).not.toContain('leak')
    }
  })

  it('/INDEX.HTML ⇒ 大小写不同 ⇒ 不注入（Windows 大小写不敏感则读到同一文件，但不命中白名单）', async () => {
    const probe = await call(depsOf(), '/INDEX.HTML')
    const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
    // 大小写不敏感平台：文件读得到（200）但路径与白名单项不精确相等 ⇒ 不注入；
    // 敏感平台：直接 404。两种平台都**不得**出现 token —— 这是真正的判据。
    expect(probe.status).toBe(caseInsensitive ? 200 : 404)
    expect(probe.body).not.toContain('bah-web-token')
  })

  it('/index.html?x=1 ⇒ query 不参与路径判定，正常注入', async () => {
    const probe = await call(depsOf(), '/index.html')
    expect(probe.status).toBe(200)
    expect(probe.body).toContain('bah-web-token')
  })
})

describe('路径穿越与畸形编码回归（TC-MCH-16）', () => {
  it('/../package.json 与 /%2e%2e%2fpackage.json ⇒ 404 且正文不含文件内容', async () => {
    for (const path of ['/../package.json', '/%2e%2e%2fpackage.json']) {
      const probe = await call(depsOf(), path)
      expect(probe.status).toBe(404)
      expect(probe.body).not.toContain('leak')
    }
  })

  it('/%E0%A4%A ⇒ 400 web-invalid-path（畸形百分号不得变成 500）', async () => {
    const probe = await call(depsOf(), '/%E0%A4%A')
    expect(probe.status).toBe(400)
    expect(probe.body).toContain('web-invalid-path')
  })
})

describe('坐席入口（B1：零注入、未启用即 404）', () => {
  it('未启用坐席面 ⇒ /operator 与 /operator.html 都 404（存在性不白给）', async () => {
    for (const path of ['/operator', '/operator.html']) {
      const probe = await call(depsOf(), path)
      expect(probe.status).toBe(404)
      expect(probe.body).toContain('web-not-found')
    }
  })

  it('启用 ⇒ /operator 200 text/html，零凭证、不写 CSRF cookie、no-store', async () => {
    const probe = await call(depsOf({ seatEnabled: true, operatorToken: OPERATOR_TOKEN }), '/operator')
    expect(probe.status).toBe(200)
    expect(probe.headers['content-type']).toContain('text/html')
    expect(probe.body).toContain('SEAT')
    expect(probe.body).not.toContain(WEB_TOKEN)
    expect(probe.body).not.toContain(OPERATOR_TOKEN)
    expect(probe.body).not.toContain('bah-web-token')
    expect(probe.headers['set-cookie']).toBeUndefined()
    // 合流 T-04：入口页（token 入口与坐席入口）统一 no-store——注入值随进程变化
    expect(probe.headers['cache-control']).toBe('no-store')
  })

  it('启用 ⇒ /operator.html 直接访问同样零注入', async () => {
    const probe = await call(
      depsOf({ seatEnabled: true, operatorToken: OPERATOR_TOKEN }),
      '/operator.html',
    )
    expect(probe.status).toBe(200)
    expect(probe.body).toContain('SEAT')
    expect(probe.body).not.toContain('bah-web-token')
    expect(probe.body).not.toContain(WEB_TOKEN)
  })

  it('误配进 token 白名单也不注入（operatorEntry 是硬排除，不靠配置自觉）', async () => {
    const probe = await call(
      depsOf({
        seatEnabled: true,
        operatorToken: OPERATOR_TOKEN,
        tokenEntries: [join(root, 'index.html'), join(root, 'operator.html')],
      }),
      '/operator.html',
    )
    expect(probe.status).toBe(200)
    expect(probe.body).not.toContain('bah-web-token')
    expect(probe.headers['set-cookie']).toBeUndefined()
    // 合流 T-04：入口页（token 入口与坐席入口）统一 no-store——注入值随进程变化
    expect(probe.headers['cache-control']).toBe('no-store')
  })
})
