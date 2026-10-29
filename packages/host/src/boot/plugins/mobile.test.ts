/**
 * `channel:mobile` 宿主行：插件形状 + 真装配（施工单 01 §5 TC-MCH-19 / §8 B5）。
 *
 * 为什么不止断言形状：`verify-saga-wiring` 的存在说明"装好了没人调"是本项目的常客。
 * 这里真 boot 一个 ctx、真监听端口、真打 `/api/session` 与 `/`——"移动渠道能用"必须由
 * 一次真实请求证明，而不是由常量表证明。
 */

import type { Context } from '@bah/core'
import { createContext } from '@bah/core'
import { APPROVAL_SERVICE, ApprovalService } from '@bah/interaction'
import { AgentRegistry, provideAgents, provideSession } from '@bah/runtime'
import { asSessionId } from '@bah/test-support'

import { rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { RUN_SERVICE } from '../boot.ts'
import { MOBILE_SERVER, mobilePlugin } from './mobile.ts'
import { SESSION_FILES } from './persistence.ts'
import { WEB_TOKEN_ENV } from './web-auth.ts'
import { webPlugin } from './web.ts'

const WEB_TOKEN = 'mobile-test-token'

/** 测试静态根（不入仓：临时目录，用完删）。 */
let staticRoot = ''

const HTML = '<!doctype html><html><head><title>mobile-shell</title></head><body>m</body></html>'

beforeAll(() => {
  staticRoot = mkdtempSync(join(tmpdir(), 'bah-mobile-web-'))
  writeFileSync(join(staticRoot, 'index.html'), HTML)
})

afterAll(() => {
  rmSync(staticRoot, { recursive: true, force: true })
})

/** 起一个只装了必要服务的 ctx + 真实 HTTP 端口（`port: 0` 由内核分配）。 */
async function boot(): Promise<{ ctx: Context; url: string; restore: () => void }> {
  const previousToken = process.env[WEB_TOKEN_ENV]
  process.env[WEB_TOKEN_ENV] = WEB_TOKEN
  const ctx = createContext()
  const sessionId = asSessionId('s-mobile-test')
  const now = (): number => 1_700_000_000_000

  ctx.provide(RUN_SERVICE, { sessionId, now })
  provideSession(ctx, { sessionId, now })
  provideAgents(ctx, new AgentRegistry())
  ctx.provide(APPROVAL_SERVICE, new ApprovalService({ sessionId, now }))
  // 真 profile 里 `core:persistence` 一定在；接管状态要落与会话日志同目录
  ctx.provide(SESSION_FILES, {
    root: join(tmpdir(), 'bah-mobile-test-sessions'),
    fileOf: (id) => join(tmpdir(), 'bah-mobile-test-sessions', String(id), 'session.jsonl'),
  })

  const settings = mobilePlugin.validate({ port: 0, host: '127.0.0.1', staticRoot })
  await ctx.use(mobilePlugin.plugin, settings)
  await ctx.start()

  return {
    ctx,
    url: ctx.get(MOBILE_SERVER).url,
    restore: () => {
      if (previousToken === undefined) delete process.env[WEB_TOKEN_ENV]
      else process.env[WEB_TOKEN_ENV] = previousToken
    },
  }
}

let active: { ctx: Context; url: string; restore: () => void } | undefined

afterEach(async () => {
  if (active !== undefined) {
    await active.ctx.dispose('test')
    active.restore()
    active = undefined
  }
})

/** 带 Bearer 的 fetch。 */
function authed(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${WEB_TOKEN}`)
  return fetch(url, { ...init, headers })
}

describe('channel:mobile 插件形状（TC-MCH-19）', () => {
  it('id 与 inject 与 webPlugin 逐字相同；validate 走同一份解析', () => {
    expect(mobilePlugin.id).toBe('channel:mobile')
    expect(mobilePlugin.plugin.inject).toEqual(webPlugin.plugin.inject)
    expect(mobilePlugin.validate({ port: 0 })).toEqual(webPlugin.validate({ port: 0 }))
  })
})

describe('channel:mobile 真装配（B5）', () => {
  it('/api/session 上报 10 字段能力位，layout=narrow / approvalSurface=bottom-sheet', async () => {
    active = await boot()
    const response = await authed(`${active.url}api/session`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { sessionId: string; capabilities: Record<string, unknown> }
    expect(body.sessionId).toBe('s-mobile-test')
    expect(Object.keys(body.capabilities).sort()).toEqual(
      [
        'approvalSurface',
        'buttons',
        'dagView',
        'forms',
        'gestureConfirm',
        'images',
        'layout',
        'richCards',
        'streaming',
        'voiceInput',
      ].sort(),
    )
    expect(body.capabilities['layout']).toBe('narrow')
    expect(body.capabilities['approvalSurface']).toBe('bottom-sheet')
    expect(body.capabilities['voiceInput']).toBe('ime')
  })

  it('`/` 由 entry 决定并注入 token（静态面与 web 同一份实现）', async () => {
    active = await boot()
    const response = await fetch(`${active.url}`)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('<title>mobile-shell</title>')
    expect(html).toContain('bah-web-token')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toContain('bah_csrf=')
    expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()')
  })

  it('未带 Bearer 的 /api/session ⇒ 401（闸序与 web 完全一致）', async () => {
    active = await boot()
    const response = await fetch(`${active.url}api/session`)
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('web-unauthorized')
  })

  it('admin 端点默认关闭：未设 BAH_ADMIN_TOKEN ⇒ 404（不暴露路由存在性）', async () => {
    const previous = process.env['BAH_ADMIN_TOKEN']
    delete process.env['BAH_ADMIN_TOKEN']
    try {
      active = await boot()
      const response = await fetch(`${active.url}api/admin/halt`, { method: 'POST' })
      expect(response.status).toBe(404)
    } finally {
      if (previous !== undefined) process.env['BAH_ADMIN_TOKEN'] = previous
    }
  })

  it('服务键是 MOBILE_SERVER：url 指向真实端口且与 WEB_SERVER 不共用', async () => {
    active = await boot()
    const info = active.ctx.get(MOBILE_SERVER)
    expect(info.port).toBeGreaterThan(0)
    expect(info.url).toContain(String(info.port))
    expect(info.sessionId).toBe('s-mobile-test')
  })
})
