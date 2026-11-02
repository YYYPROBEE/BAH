/**
 * `POST /api/suggest` 的输入面（与插件同批合入，当时零用例）。
 *
 * 路由闸本身（CSRF / 401 / 403 / 405）已由 `authz/matrix.test.ts` 与 `contract.test.ts` 钉住；
 * 这里补的是**闸后面的判决**：服务没装、体不是 JSON、体超过 64KB、assistant 空白或非字符串、
 * 上下文超长——每一档都要落在 200 或 400 上。建议是辅助件，任何一档变成 5xx 都会把前端
 * 「回退规则表」打死，而那正是 10fbb3a 修过的那类故障。
 *
 * 不起 HTTP：与 `sessions.test.ts` 同口径，用假 req/res 直接调函数——顺带避开 Windows 上
 * `listen(0)` 落到 undici 禁用端口段的 `bad port` 假红。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'

import type { WebDeps, WebRequest } from '../deps.ts'
import { handleSuggest } from './suggest.ts'

import type { SuggestPort } from '../../suggest.ts'

/** 收集响应（`sendJson` 走 `writeHead` + `end`）。 */
function fakeRes(): { res: ServerResponse; out: { status: number; headers: Record<string, unknown>; body: string } } {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: '' }
  const res = {
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      out.status = status
      for (const [key, value] of Object.entries(headers)) out.headers[key.toLowerCase()] = value
      return res
    },
    end(body?: unknown) {
      out.body = String(body ?? '')
      return res
    },
  } as unknown as ServerResponse
  return { res, out }
}

/** 假请求体：`readJson` 用 `for await` 读，所以给异步迭代器就够。 */
function fakeReq(body: string | undefined, onRead?: () => void): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method: 'POST',
    url: '/api/suggest',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      onRead?.()
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

/** 记账用的假建议服务。 */
function fakePort(result: readonly string[] = ['查余额', '看流水']): { port: SuggestPort; inputs: { user: string; assistant: string }[] } {
  const inputs: { user: string; assistant: string }[] = []
  return {
    inputs,
    port: {
      suggest: (input) => {
        inputs.push({ user: input.user, assistant: input.assistant })
        return Promise.resolve(result)
      },
    },
  }
}

function depsOf(port: SuggestPort | undefined): WebDeps {
  return { trySuggest: () => port } as unknown as WebDeps
}

const request: WebRequest = {
  method: 'POST',
  url: new URL('http://127.0.0.1/api/suggest'),
  path: '/api/suggest',
  rest: '',
}

/** 跑一次 handler，返回状态、头与解析后的响应体。 */
async function call(body: string | undefined, port: SuggestPort | undefined, onRead?: () => void) {
  const { res, out } = fakeRes()
  await handleSuggest(fakeReq(body, onRead), res, request, depsOf(port))
  return { status: out.status, headers: out.headers, json: JSON.parse(out.body) as Record<string, unknown> }
}

describe('POST /api/suggest · 降级优先', () => {
  it('没装建议服务：200 unavailable，连请求体都不读', async () => {
    let read = false
    const response = await call(undefined, undefined, () => {
      read = true
    })
    expect(response.status).toBe(200)
    expect(response.json).toEqual({ suggestions: [], source: 'unavailable' })
    expect(read).toBe(false)
  })

  it('模型一条也没抽出来：200 empty（不是 5xx，也不是空按钮）', async () => {
    const { port } = fakePort([])
    const response = await call(JSON.stringify({ user: '查余额', assistant: '余额 1200 元' }), port)
    expect(response.status).toBe(200)
    expect(response.json).toEqual({ suggestions: [], source: 'empty' })
  })

  it('有建议时 source=model', async () => {
    const { port, inputs } = fakePort(['查余额', '看流水'])
    const response = await call(JSON.stringify({ user: '查余额', assistant: '余额 1200 元' }), port)
    expect(response.status).toBe(200)
    expect(response.json).toEqual({ suggestions: ['查余额', '看流水'], source: 'model' })
    expect(inputs).toEqual([{ user: '查余额', assistant: '余额 1200 元' }])
  })

  /** 响应体里是会话原文，共享机器上不能被缓存下来。 */
  it('响应带 no-store', async () => {
    const { port } = fakePort()
    const response = await call(JSON.stringify({ user: '查余额', assistant: '余额 1200 元' }), port)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
  })
})

describe('POST /api/suggest · 输入校验', () => {
  it('体不是合法 JSON / 不是对象：400 web-invalid-json', async () => {
    for (const body of ['{', '[]', '"只有一段字符串"']) {
      const response = await call(body, fakePort().port)
      expect(response.status).toBe(400)
      expect((response.json.error as { code: string }).code).toBe('web-invalid-json')
    }
  })

  it('体超过 64KB：仍是 400 不是 500（错误码复用 invalid-json，reason 不区分）', async () => {
    const response = await call(JSON.stringify({ user: '查余额', assistant: '余'.repeat(70_000) }), fakePort().port)
    expect(response.status).toBe(400)
  })

  it('assistant 缺失 / 全空白 / 非字符串：200 empty 且不消耗模型调用', async () => {
    for (const body of [
      JSON.stringify({ user: '查余额' }),
      JSON.stringify({ user: '查余额', assistant: '   \n ' }),
      JSON.stringify({ user: '查余额', assistant: 12_800 }),
      '{}',
    ]) {
      const { port, inputs } = fakePort()
      const response = await call(body, port)
      expect(response.status).toBe(200)
      expect(response.json).toEqual({ suggestions: [], source: 'empty' })
      expect(inputs).toHaveLength(0)
    }
  })

  it('user 非字符串按空串送进去，assistant 原样保留', async () => {
    const { port, inputs } = fakePort()
    await call(JSON.stringify({ user: { 嵌套: '对象' }, assistant: '请选择卡片' }), port)
    expect(inputs).toEqual([{ user: '', assistant: '请选择卡片' }])
  })

  it('两段上下文各截到 2000 字再交给服务', async () => {
    const { port, inputs } = fakePort()
    await call(JSON.stringify({ user: '用'.repeat(3000), assistant: '助'.repeat(3000) }), port)
    expect(inputs[0]?.user).toHaveLength(2000)
    expect(inputs[0]?.assistant).toHaveLength(2000)
  })
})
