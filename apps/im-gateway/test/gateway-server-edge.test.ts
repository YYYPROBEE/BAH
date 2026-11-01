/**
 * 网关路由的边界分支（02/03 单）：平台解析结论的分流、请求体上限、运营桥方法白名单。
 *
 * 这些分支不在"正常一轮消息"的路径上，但都在**公网输入边界**上：
 * - 解析器判 `reject` / `unsupported` 时，网关必须按结论回包，不能落到 500 或 main 循环；
 * - 超过 64 KiB 的 body 必须在读入时截断成 413，不能整个读进内存再解析；
 * - 运营桥只认 GET/POST，其它方法不能穿透到子进程。
 */

import type { Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PlatformAdapter, PlatformParseResult, PlatformRequest } from '@bah/channels'

import { createImLogger } from '../src/log.ts'
import { createRegistry } from '../src/platform/registry.ts'
import { createGatewayServer, type GatewayServerDeps } from '../src/server.ts'

const NOW = 1_793_000_000_000
const log = createImLogger('error', () => undefined)

/** 只关心 parse 结论的假适配器（验签恒过）。 */
function fakeAdapter(parse: (request: PlatformRequest) => PlatformParseResult): PlatformAdapter {
  return {
    id: 'fake',
    capabilities: {
      passiveReply: true,
      asyncPush: true,
      interactiveCards: false,
      threads: false,
      maxTextBytes: 2048,
    },
    verify: () => ({ ok: true }),
    parse,
  }
}

/** 起一个不 listen 到固定端口的服务。 */
async function start(input: {
  readonly parse: (request: PlatformRequest) => PlatformParseResult
  readonly approvePage?: GatewayServerDeps['approvePage']
  readonly seat?: GatewayServerDeps['seat']
  readonly seatEnabled?: boolean
}): Promise<{ base: string; close(): Promise<void> }> {
  const server: Server = createGatewayServer({
    registry: createRegistry([fakeAdapter(input.parse)]),
    log,
    handleMessage: async () => ({
      response: { status: 200, headers: {}, body: 'ok' },
      done: Promise.resolve(),
    }),
    children: () => 0,
    startedAtMs: NOW,
    nowMs: () => NOW,
    ...(input.approvePage === undefined ? {} : { approvePage: input.approvePage }),
    ...(input.seat === undefined ? {} : { seat: input.seat }),
    seatEnabled: input.seatEnabled ?? false,
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

const servers: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

/** 起服务并登记到 afterEach。 */
async function startTracked(
  input: Parameters<typeof start>[0],
): Promise<{ base: string; close(): Promise<void> }> {
  const app = await start(input)
  servers.push(app)
  return app
}

describe('平台解析结论分流', () => {
  it('reject ⇒ 按结论回结构化错误（不落到 500，也不回显原文）', async () => {
    const app = await startTracked({
      parse: () => ({ kind: 'reject', status: 400, code: 'im-xml-invalid' }),
    })

    const response = await fetch(`${app.base}/im/fake/default`, { method: 'POST', body: '<xml/>' })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'im-xml-invalid', reason: '报文被拒绝' },
    })
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('unsupported ⇒ 原样回适配器给的响应（例如公众号的"暂不支持"说明）', async () => {
    const app = await startTracked({
      parse: () => ({
        kind: 'unsupported',
        response: { status: 200, headers: { 'content-type': 'text/plain' }, body: '暂不支持该消息类型' },
      }),
    })

    const response = await fetch(`${app.base}/im/fake/default`, { method: 'POST', body: 'x' })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('暂不支持该消息类型')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('请求体上限（64 KiB）', () => {
  const tooLarge = 'x'.repeat(64 * 1024 + 1)

  it('H5 审批 POST 超限 ⇒ 413，且不调用提交处理器', async () => {
    const submit = vi.fn(async () => undefined)
    const app = await startTracked({
      parse: () => ({ kind: 'unsupported', response: { status: 200, headers: {}, body: '' } }),
      approvePage: {
        get: () => undefined,
        submit,
        asset: () => false,
      },
    })

    const response = await fetch(`${app.base}/a/token-1`, { method: 'POST', body: tooLarge })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: { code: 'im-body-too-large', reason: '请求体超过网关上限' },
    })
    expect(submit).not.toHaveBeenCalled()
  })

  it('运营桥 POST 超限 ⇒ 413，且不转发到子进程', async () => {
    const seat = vi.fn(async () => undefined)
    const app = await startTracked({
      parse: () => ({ kind: 'unsupported', response: { status: 200, headers: {}, body: '' } }),
      seat,
      seatEnabled: true,
    })

    const response = await fetch(`${app.base}/seat/ticket-1`, { method: 'POST', body: tooLarge })

    expect(response.status).toBe(413)
    expect(seat).not.toHaveBeenCalled()
  })

  it('运营桥非 GET/POST ⇒ 404（不把方法名透给子进程）', async () => {
    const seat = vi.fn(async () => undefined)
    const app = await startTracked({
      parse: () => ({ kind: 'unsupported', response: { status: 200, headers: {}, body: '' } }),
      seat,
      seatEnabled: true,
    })

    const response = await fetch(`${app.base}/seat/ticket-1`, { method: 'PUT' })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'im-not-found', reason: '没有这个路径' },
    })
    expect(seat).not.toHaveBeenCalled()
  })
})
