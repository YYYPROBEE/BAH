/**
 * `channel:im` 宿主行：插件形状 + 真装配 + 提示词段。
 *
 * 为什么真装配：`channel:im` 复用 `createHttpChannel`，但复用的正确性只能由一次真实请求证明；
 * 提示词段的注册/注销也只能由真实插件生命周期证明（注册即可逆是本仓的编码纪律第 1 条）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext, type Context } from '@bah/core'
import { APPROVAL_SERVICE, ApprovalService } from '@bah/interaction'
import { AgentRegistry, provideAgents, provideSession, provideSystemPrompt, SYSTEM_PROMPT_SERVICE } from '@bah/runtime'
import { IM_UNTRUSTED_SECTION_ID, IM_UNTRUSTED_SECTION_TEXT } from '@bah/safety'
import { asSessionId } from '@bah/test-support'
import { DEFAULT_TENANT_ID } from '@bah/util'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { RUN_SERVICE } from '../boot.ts'
import { IM_SERVER, imPlugin } from './im.ts'
import { SESSION_FILES } from './persistence.ts'
import { WEB_TOKEN_ENV } from './web-auth.ts'
import { webPlugin } from './web.ts'

const WEB_TOKEN = 'im-test-token'

let staticRoot = ''

const HTML = '<!doctype html><html><head><title>im-shell</title></head><body>im</body></html>'

beforeAll(() => {
  staticRoot = mkdtempSync(join(tmpdir(), 'bah-im-web-'))
  writeFileSync(join(staticRoot, 'm.html'), HTML)
})

afterAll(() => {
  rmSync(staticRoot, { recursive: true, force: true })
})

interface Booted {
  readonly ctx: Context
  readonly url: string
  readonly restore: () => void
}

async function boot(options: { operatorToken?: string } = {}): Promise<Booted> {
  const previousToken = process.env[WEB_TOKEN_ENV]
  const previousOperator = process.env['BAH_OPERATOR_TOKEN']
  process.env[WEB_TOKEN_ENV] = WEB_TOKEN
  if (options.operatorToken === undefined) delete process.env['BAH_OPERATOR_TOKEN']
  else process.env['BAH_OPERATOR_TOKEN'] = options.operatorToken
  const ctx = createContext()
  const sessionId = asSessionId('s-im-test')
  const now = (): number => 1_700_000_000_000

  ctx.provide(RUN_SERVICE, { sessionId, tenantId: DEFAULT_TENANT_ID, now })
  provideSession(ctx, { sessionId, now })
  provideAgents(ctx, new AgentRegistry())
  ctx.provide(APPROVAL_SERVICE, new ApprovalService({ sessionId, now }))
  provideSystemPrompt(ctx)
  const sessionRoot = join(tmpdir(), 'bah-im-test-sessions')
  const tenantRoot = join(sessionRoot, String(DEFAULT_TENANT_ID))
  ctx.provide(SESSION_FILES, {
    root: tenantRoot,
    baseRoot: sessionRoot,
    tenantId: DEFAULT_TENANT_ID,
    fileOf: (id) => join(tenantRoot, String(id), 'session.jsonl'),
  })

  const settings = imPlugin.validate({ port: 0, host: '127.0.0.1', staticRoot, entry: 'm.html', entries: ['m.html'] })
  await ctx.use(imPlugin.plugin, settings)
  await ctx.start()

  return {
    ctx,
    url: ctx.get(IM_SERVER).url,
    restore: () => {
      if (previousToken === undefined) delete process.env[WEB_TOKEN_ENV]
      else process.env[WEB_TOKEN_ENV] = previousToken
      if (previousOperator === undefined) delete process.env['BAH_OPERATOR_TOKEN']
      else process.env['BAH_OPERATOR_TOKEN'] = previousOperator
    },
  }
}

let active: Booted | undefined

afterEach(async () => {
  if (active !== undefined) {
    await active.ctx.dispose('test')
    active.restore()
    active = undefined
  }
})

function authed(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${WEB_TOKEN}`)
  return fetch(url, { ...init, headers })
}

describe('channel:im 插件形状（T-CH-014 前半）', () => {
  it('id 是 channel:im；inject 与 web 相同并额外依赖提示词服务', () => {
    expect(imPlugin.id).toBe('channel:im')
    expect(imPlugin.plugin.name).toBe('channel:im')
    expect([...(webPlugin.plugin.inject ?? []), SYSTEM_PROMPT_SERVICE.id]).toEqual([
      ...(imPlugin.plugin.inject ?? []),
    ])
    expect(imPlugin.validate({ port: 0 })).toEqual(webPlugin.validate({ port: 0 }))
  })
})

describe('channel:im 真装配', () => {
  it('/api/session 上报 IM 能力位（forms/streaming false、narrow）', async () => {
    active = await boot()
    const response = await authed(`${active.url}api/session`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { sessionId: string; capabilities: Record<string, unknown> }
    expect(body.sessionId).toBe('s-im-test')
    expect(body.capabilities['richCards']).toBe(true)
    expect(body.capabilities['buttons']).toBe(true)
    expect(body.capabilities['forms']).toBe(false)
    expect(body.capabilities['streaming']).toBe(false)
    expect(body.capabilities['layout']).toBe('narrow')
  })

  it('`/` 打开 m.html 并注入 token（与 web 同一份静态实现）', async () => {
    active = await boot()
    const response = await fetch(active.url)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('<title>im-shell</title>')
    expect(html).toContain('bah-web-token')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('未带 Bearer ⇒ 401（闸序没有因为换渠道而放宽）', async () => {
    active = await boot()
    const response = await fetch(`${active.url}api/session`)
    expect(response.status).toBe(401)
  })

  it('服务键是 IM_SERVER 且指向真实端口', async () => {
    active = await boot()
    const info = active.ctx.get(IM_SERVER)
    expect(info.port).toBeGreaterThan(0)
    expect(info.url).toContain(String(info.port))
    expect(info.sessionId).toBe('s-im-test')
  })
})

/** 取 CSRF cookie（`/m.html` 的 Set-Cookie）。 */
async function csrfOf(url: string): Promise<string> {
  const response = await fetch(`${url}m.html`)
  const header = response.headers.get('set-cookie') ?? ''
  const match = /bah_csrf=([^;]+)/u.exec(header)
  return match?.[1] ?? ''
}

describe('channel:im 坐席 API（03 单运营桥前置）', () => {
  it('配置 BAH_OPERATOR_TOKEN → 5 条坐席 API 可达；/operator 页面仍 404（IM 无坐席 UI）', async () => {
    active = await boot({ operatorToken: 'im-operator-token' })
    const queue = await fetch(`${active.url}api/handoff/queue`, {
      headers: { authorization: 'Bearer im-operator-token' },
    })
    expect(queue.status).toBe(200)

    const csrf = await csrfOf(active.url)
    const claim = await fetch(`${active.url}api/handoff/claim`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer im-operator-token',
        'x-bah-csrf': csrf,
        cookie: `bah_csrf=${csrf}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    // 路由存在且 token 被接受：无接管时状态机给 409，而不是 404/401/403
    expect(claim.status).toBe(409)

    const operatorPage = await fetch(`${active.url}operator`)
    expect(operatorPage.status).toBe(404)
  })

  it('未配置 BAH_OPERATOR_TOKEN → 坐席 API 404（不暴露存在性）', async () => {
    active = await boot()
    const queue = await fetch(`${active.url}api/handoff/queue`, {
      headers: { authorization: 'Bearer im-operator-token' },
    })
    expect(queue.status).toBe(404)
  })
})

describe('im.untrusted 提示词段（T-CH-014 后半）', () => {
  it('装配后位于 order 5（identity.safety 与 bank.domain 之间）', async () => {
    active = await boot()
    const registry = active.ctx.get(SYSTEM_PROMPT_SERVICE)
    expect(registry.has(IM_UNTRUSTED_SECTION_ID)).toBe(true)
    expect(registry.get(IM_UNTRUSTED_SECTION_ID).order).toBe(5)

    const composed = registry.compose({
      capabilities: { toolCall: true, image: false, reasoning: false },
      tools: [],
      channel: 'im',
    })
    expect(composed.header).toContain(IM_UNTRUSTED_SECTION_TEXT)
    expect(composed.header).toContain('⟦UNTRUSTED:im⟧')
    const ids = composed.parts.map((part) => part.id)
    expect(ids.indexOf(IM_UNTRUSTED_SECTION_ID)).toBeGreaterThan(ids.indexOf('identity.safety'))
    expect(ids.indexOf(IM_UNTRUSTED_SECTION_ID)).toBeLessThan(ids.indexOf('bank.domain'))
  })

  it('插件卸载后段被注销（注册即可逆）', async () => {
    const booted = await boot()
    const registry = booted.ctx.get(SYSTEM_PROMPT_SERVICE)
    expect(registry.has(IM_UNTRUSTED_SECTION_ID)).toBe(true)
    await booted.ctx.dispose('test')
    booted.restore()
    expect(registry.has(IM_UNTRUSTED_SECTION_ID)).toBe(false)
  })

  it('默认六段不被污染：段只由 channel:im 注册', () => {
    const ctx = createContext()
    provideSystemPrompt(ctx)
    const registry = ctx.get(SYSTEM_PROMPT_SERVICE)
    expect(registry.ids()).toEqual([
      'identity.safety',
      'bank.domain',
      'bank.capabilities',
      'runtime.context',
      'policy.approval',
      'style',
    ])
    expect(registry.has(IM_UNTRUSTED_SECTION_ID)).toBe(false)
  })
})
