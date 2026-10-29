/**
 * `createHttpChannel` 的**同源装配**用例（施工单 01 §3.6 / §8 B5、TC-MCH-20..21）。
 *
 * 判据是"两个渠道的差异**只有** D2 那三项"：
 * 1. 能力位（适配器）：`/api/session` 的 capabilities 只在这五项上不同；
 * 2. 入口 HTML：`/` 落点不同、token 白名单不同；
 * 3. 默认端口：由 profile 决定（这里都传 0，所以只验证"各绑各的端口"）。
 *
 * 其余（闸序、安全头、路由表）必须**逐条相同**——任何一条不同都说明有人给移动端开了后门。
 */

import type { Context } from '@bah/core'
import { createContext } from '@bah/core'
import { APPROVAL_SERVICE, ApprovalService } from '@bah/interaction'
import { AgentRegistry, provideAgents, provideSession } from '@bah/runtime'
import { asSessionId } from '@bah/test-support'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { RUN_SERVICE } from '../../boot.ts'
import { mobilePlugin, MOBILE_SERVER } from '../mobile.ts'
import { SESSION_FILES } from '../persistence.ts'
import { WEB_TOKEN_ENV } from '../web-auth.ts'
import { WEB_SERVER, webPlugin, type WebSettings } from '../web.ts'
import type { HostPlugin } from '../../../plugin-manager/index.ts'
import type { WebServerInfo } from './channel.ts'

const WEB_TOKEN = 'channel-parity-token'

/** 两个壳：`/` 在 web 与 mobile 上落到不同文件。 */
const INDEX_HTML =
  '<!doctype html><html><head><title>desk</title></head><body>desk</body></html>'
const M_HTML = '<!doctype html><html><head><title>mobile</title></head><body>m</body></html>'
const OTHER_HTML = '<!doctype html><html><head><title>other</title></head><body>o</body></html>'

let staticRoot = ''

beforeAll(() => {
  staticRoot = mkdtempSync(join(tmpdir(), 'bah-channel-parity-'))
  writeFileSync(join(staticRoot, 'index.html'), INDEX_HTML)
  writeFileSync(join(staticRoot, 'm.html'), M_HTML)
  writeFileSync(join(staticRoot, 'other.html'), OTHER_HTML)
})

afterAll(() => {
  rmSync(staticRoot, { recursive: true, force: true })
})

interface Bound {
  readonly ctx: Context
  readonly url: string
  readonly info: WebServerInfo
  readonly serviced: (url: string, init?: RequestInit) => Promise<Response>
  readonly restore: () => void
}

const live: Bound[] = []

/** 用指定插件 boot 一个真端口（`port: 0`）。 */
async function boot(
  plugin: HostPlugin<WebSettings>,
  serverKey: typeof MOBILE_SERVER,
  settings: Partial<WebSettings>,
): Promise<Bound> {
  const previousToken = process.env[WEB_TOKEN_ENV]
  process.env[WEB_TOKEN_ENV] = WEB_TOKEN

  const ctx = createContext()
  const sessionId = asSessionId('s-parity')
  const now = (): number => 1_700_000_000_000
  ctx.provide(RUN_SERVICE, { sessionId, now })
  provideSession(ctx, { sessionId, now })
  provideAgents(ctx, new AgentRegistry())
  ctx.provide(APPROVAL_SERVICE, new ApprovalService({ sessionId, now }))
  // 两个渠道共用一份装配 ⇒ 都要有会话根（接管状态落与会话日志同目录）
  ctx.provide(SESSION_FILES, {
    root: join(tmpdir(), 'bah-channel-parity-sessions'),
    fileOf: (id) => join(tmpdir(), 'bah-channel-parity-sessions', String(id), 'session.jsonl'),
  })

  await ctx.use(plugin.plugin, plugin.validate({ port: 0, host: '127.0.0.1', staticRoot, ...settings }))
  await ctx.start()

  const info = ctx.get(serverKey)
  const bound: Bound = {
    ctx,
    url: info.url,
    info,
    serviced: (url, init = {}) => {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${WEB_TOKEN}`)
      return fetch(url, { ...init, headers })
    },
    restore: () => {
      if (previousToken === undefined) delete process.env[WEB_TOKEN_ENV]
      else process.env[WEB_TOKEN_ENV] = previousToken
    },
  }
  live.push(bound)
  return bound
}

afterEach(async () => {
  while (live.length > 0) {
    const bound = live.pop()
    if (bound !== undefined) {
      await bound.ctx.dispose('test')
      bound.restore()
    }
  }
})

/** web：`/` → index.html，白名单只有 index。 */
function bootWeb(): Promise<Bound> {
  return boot(webPlugin, WEB_SERVER, {})
}

/** mobile：`/` → m.html，白名单 = [m.html, index.html]。 */
function bootMobile(): Promise<Bound> {
  return boot(mobilePlugin, MOBILE_SERVER, { entry: 'm.html', entries: ['m.html', 'index.html'] })
}

describe('两渠道同源：能力位只差 D2 的五项（TC-MCH-20 / D2）', () => {
  it('/api/session 的 capabilities 五项相同、五项按渠道不同', async () => {
    const web = await bootWeb()
    const mobile = await bootMobile()
    const read = async (bound: Bound): Promise<Record<string, unknown>> => {
      const response = await bound.serviced(`${bound.url}api/session`)
      return ((await response.json()) as { capabilities: Record<string, unknown> }).capabilities
    }
    const webCaps = await read(web)
    const mobileCaps = await read(mobile)

    for (const field of ['richCards', 'buttons', 'forms', 'images', 'streaming']) {
      expect(mobileCaps[field]).toBe(webCaps[field])
    }
    expect(webCaps['layout']).toBe('wide')
    expect(mobileCaps['layout']).toBe('narrow')
    expect(webCaps['approvalSurface']).toBe('dialog')
    expect(mobileCaps['approvalSurface']).toBe('bottom-sheet')
    expect(webCaps['dagView']).toBe('graph')
    expect(mobileCaps['dagView']).toBe('steps')
    expect(webCaps['voiceInput']).toBe('none')
    expect(mobileCaps['voiceInput']).toBe('ime')
    expect(webCaps['gestureConfirm']).toBe(false)
    expect(mobileCaps['gestureConfirm']).toBe(true)
  })
})

describe('两渠道同源：入口与白名单是唯一允许的静态差异', () => {
  it('`/` 分别落到 index.html 与 m.html', async () => {
    const web = await bootWeb()
    const mobile = await bootMobile()
    expect(await (await fetch(web.url)).text()).toContain('<title>desk</title>')
    expect(await (await fetch(mobile.url)).text()).toContain('<title>mobile</title>')
  })

  it('token 只注入各自白名单：web 不注入 m.html，mobile 两个都注入', async () => {
    const web = await bootWeb()
    const mobile = await bootMobile()

    const webM = await fetch(`${web.url}m.html`)
    expect(webM.status).toBe(200)
    expect(await webM.text()).not.toContain('bah-web-token')

    for (const path of ['m.html', 'index.html']) {
      const response = await fetch(`${mobile.url}${path}`)
      expect(await response.text()).toContain('bah-web-token')
    }
    // 白名单外（other.html）在两个渠道都不注入
    expect(await (await fetch(`${mobile.url}other.html`)).text()).not.toContain('bah-web-token')
  })
})

describe('两渠道同源：闸序与安全头逐条一致（TC-MCH-20..21）', () => {
  it('无 Bearer ⇒ 401；有 Bearer 无 CSRF 的 POST ⇒ 403；方法不支持 ⇒ 405（两边相同）', async () => {
    const web = await bootWeb()
    const mobile = await bootMobile()
    const probe = async (bound: Bound): Promise<number[]> => {
      const noToken = await fetch(`${bound.url}api/session`)
      const noCsrf = await bound.serviced(`${bound.url}api/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '查余额' }),
      })
      // 405 要排在 CSRF 之后：带同源 Origin 让 CSRF 放行，才走得到"方法不支持"
      const wrongMethod = await bound.serviced(`${bound.url}api/session`, {
        method: 'POST',
        headers: { origin: new URL(bound.url).origin },
      })
      return [noToken.status, noCsrf.status, wrongMethod.status]
    }
    const webStatuses = await probe(web)
    const mobileStatuses = await probe(mobile)
    expect(webStatuses).toEqual([401, 403, 405])
    expect(mobileStatuses).toEqual(webStatuses)
  })

  it('安全头逐字节相同，permissions-policy 保持全关（00 D10）', async () => {
    const web = await bootWeb()
    const mobile = await bootMobile()
    const headersOf = async (bound: Bound): Promise<Record<string, string>> => {
      const response = await fetch(bound.url)
      return {
        csp: response.headers.get('content-security-policy') ?? '',
        nosniff: response.headers.get('x-content-type-options') ?? '',
        frame: response.headers.get('x-frame-options') ?? '',
        referrer: response.headers.get('referrer-policy') ?? '',
        permissions: response.headers.get('permissions-policy') ?? '',
      }
    }
    const webHeaders = await headersOf(web)
    const mobileHeaders = await headersOf(mobile)
    expect(mobileHeaders).toEqual(webHeaders)
    expect(mobileHeaders.permissions).toBe('camera=(), microphone=(), geolocation=()')
    expect(mobileHeaders.csp).toContain("script-src 'self'")
  })

  it('两个渠道各绑各的端口，服务键不共用', async () => {
    const web = await bootWeb()
    const mobile = await bootMobile()
    expect(web.info.port).not.toBe(mobile.info.port)
    expect(web.info.url).not.toBe(mobile.info.url)
    // 服务键不共用：各自 ctx 里只能取到自己的那条
    expect(web.ctx.get(WEB_SERVER).port).toBe(web.info.port)
    expect(mobile.ctx.get(MOBILE_SERVER).port).toBe(mobile.info.port)
  })
})
