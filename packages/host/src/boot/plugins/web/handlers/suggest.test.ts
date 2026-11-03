/**
 * `POST /api/suggest`：建议端点的**降级契约**。
 *
 * 这个端点永远 200（除非法 JSON），因为"没有建议"不是错误：
 * 没装 `bah:suggest` → unavailable；助手正文为空 → empty；模型没产出 → empty。
 * 一旦这里开始回 5xx，前端就会把一次锦上添花的失败升级成对话报错。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleSuggest } from './suggest.ts'

import type { WebDeps, WebRequest } from '../deps.ts'
import type { SuggestPort } from '../../suggest.ts'

const SERVICE_IDENTITY = { tenantId: 'demo', userId: 'u-1', roles: [] } as never

class FakeRes extends EventEmitter {
  statusCode = 0
  headers: Record<string, string> = {}
  body = ''

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status
    this.headers = headers
    return this
  }

  end(chunk?: string): void {
    this.body = chunk ?? ''
  }
}

function reqOf(body?: unknown): IncomingMessage {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const chunks = text === '' ? [] : [Buffer.from(text, 'utf8')]
  return {
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

function request(): WebRequest {
  return {
    method: 'POST',
    url: new URL('http://127.0.0.1/api/suggest'),
    path: '/api/suggest',
    rest: '',
    identity: SERVICE_IDENTITY,
  }
}

function depsWith(port: SuggestPort | undefined): WebDeps {
  return { trySuggest: () => port } as unknown as WebDeps
}

async function call(body: unknown, port: SuggestPort | undefined): Promise<FakeRes> {
  const res = new FakeRes()
  await handleSuggest(reqOf(body), res as unknown as ServerResponse, request(), depsWith(port))
  return res
}

describe('POST /api/suggest', () => {
  it('没装建议端口 ⇒ 200 unavailable（不是 501，也不是 5xx）', async () => {
    const res = await call({ user: '查余额', assistant: '余额 1298.00 元' }, undefined)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ suggestions: [], source: 'unavailable' })
  })

  it('非法 JSON ⇒ 400 web-invalid-json（装了建议端口才会去读体）', async () => {
    const res = await call('{不是 json', { suggest: async () => [] })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)['error'].code).toBe('web-invalid-json')
  })

  it('助手正文空白 ⇒ 200 empty，且根本不问模型', async () => {
    let asked = 0
    const port: SuggestPort = {
      suggest: async () => {
        asked += 1
        return []
      },
    }
    const res = await call({ user: '在吗', assistant: '   ' }, port)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ suggestions: [], source: 'empty' })
    expect(asked).toBe(0)
  })

  it('模型给出两条 ⇒ source=model，并把截断后的上下文传下去', async () => {
    const seen: { user: string; assistant: string }[] = []
    const port: SuggestPort = {
      suggest: async (input) => {
        seen.push(input)
        return ['查流水', '看账单']
      },
    }
    const res = await call({ user: 'u'.repeat(2500), assistant: '余额 1298.00 元' }, port)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ suggestions: ['查流水', '看账单'], source: 'model' })
    // 上下文按 2000 字符截断：建议请求不能变成整段会话的二次推理
    expect(seen[0]?.user).toHaveLength(2000)
    expect(seen[0]?.assistant).toBe('余额 1298.00 元')
  })

  it('模型空手而归 ⇒ 200 empty（前端据此回退规则表）', async () => {
    const res = await call({ user: '查余额', assistant: '余额 1298.00 元' }, { suggest: async () => [] })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ suggestions: [], source: 'empty' })
  })
})
