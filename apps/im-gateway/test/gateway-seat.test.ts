/**
 * 运营桥（03 单 T-IM-017）：未配 token 404 / 错 token 401 / 转发路径与状态码 / 列表不含用户标识。
 */

import { describe, expect, it } from 'vitest'

import { handleSeatRequest } from '../src/handoff/operator.ts'
import { createPullStore } from '../src/bridge/outbound.ts'
import { createImLogger } from '../src/log.ts'
import { createRegistry } from '../src/platform/registry.ts'
import { createGatewayServer } from '../src/server.ts'
import { createSessionHub } from '../src/session/hub.ts'
import { configFor, fakeChild, fakeSupervisor, recordOf } from './harness-03.ts'

const NOW = 1_793_000_000_000
const SESSION = 'im-0123456789abcdef'
const OPERATOR = 'seat-operator-token'
const log = createImLogger('error', () => undefined)
const CAPABILITIES = {
  passiveReply: true,
  asyncPush: true,
  interactiveCards: false,
  threads: false,
  maxTextBytes: 2048,
} as const

/** 起一个只挂运营桥的网关。 */
async function startServer(input: {
  readonly withOperator: boolean
  readonly child: ReturnType<typeof fakeChild>
}): Promise<{
  base: string
  supervisor: ReturnType<typeof fakeSupervisor>
  close(): Promise<void>
}> {
  const config = configFor(
    input.withOperator ? { BAH_IM_OPERATOR_TOKEN: OPERATOR } : { BAH_IM_OPERATOR_TOKEN: undefined },
  )
  const records = new Map([
    [SESSION, recordOf({ platform: 'mock', userId: 'u-1', sessionKey: SESSION, client: input.child })],
  ])
  const supervisor = fakeSupervisor({ salt: config.sessionSalt, records })
  const pull = createPullStore({ nowMs: () => NOW })
  const hub = createSessionHub({ config, log, pull, nowMs: () => NOW })
  hub.attach({ sessionKey: SESSION, port: 1234, client: input.child }, 'mock', CAPABILITIES)
  hub.noteHandoffRequested(SESSION)

  const server = createGatewayServer({
    registry: createRegistry([]),
    log,
    handleMessage: async () => ({
      response: { status: 200, headers: {}, body: '' },
      done: Promise.resolve(),
    }),
    children: () => 1,
    startedAtMs: NOW,
    nowMs: () => NOW,
    seatEnabled: config.operatorToken !== undefined,
    seat: (request, res) =>
      handleSeatRequest({ config, log, supervisor, hub }, request, res),
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${String(port)}`,
    supervisor,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/** 带运营凭证的请求。 */
async function call(
  base: string,
  path: string,
  options: { method?: string; token?: string; body?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers['x-bah-operator-token'] = options.token
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  })
}

describe('未配置运营 token（T-IM-017 前半）', () => {
  it('所有 /seat/*（含 /seat/sessions）一律 404，即使带着任意 token', async () => {
    const child = fakeChild()
    const app = await startServer({ withOperator: false, child })
    for (const path of [
      '/seat/sessions',
      `/seat/${SESSION}/handoff`,
      `/seat/${SESSION}/handoff/claim`,
      `/seat/${SESSION}/handoff/queue`,
    ]) {
      expect((await call(app.base, path, { token: OPERATOR })).status).toBe(404)
    }
    expect(child.calls.seats).toEqual([])
    await app.close()
  })
})

describe('运营鉴权（T-IM-017 中段）', () => {
  it('缺 token / 错 token → 401，且响应不回显 token', async () => {
    const child = fakeChild()
    const app = await startServer({ withOperator: true, child })
    const missing = await call(app.base, '/seat/sessions')
    expect(missing.status).toBe(401)
    const body = await missing.text()
    expect(body).toContain('im-seat-unauthorized')
    expect(body).not.toContain(OPERATOR)

    const wrong = await call(app.base, '/seat/sessions', { token: 'wrong-token' })
    expect(wrong.status).toBe(401)
    await app.close()
  })

  it('对 token → 200；列表只有会话键 / 平台 / 最近时刻 / 接管与待审数量', async () => {
    const child = fakeChild()
    const app = await startServer({ withOperator: true, child })
    const response = await call(app.base, '/seat/sessions', { token: OPERATOR })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain(SESSION)
    expect(text).toContain('mock')
    expect(text).toContain('handoffActive')
    expect(text).toContain('pendingCount')
    expect(text).not.toContain('u-1')
    expect(text).not.toContain('child-web-token')
    expect(text).not.toContain(OPERATOR)
    await app.close()
  })
})

describe('转发（T-IM-017 后半）', () => {
  it('GET 摘要 / GET 队列 / POST 认领 / 发言 / 心跳 / 交回 转发到白名单路径', async () => {
    const child = fakeChild()
    const app = await startServer({ withOperator: true, child })

    expect((await call(app.base, `/seat/${SESSION}/handoff`, { token: OPERATOR })).status).toBe(200)
    expect((await call(app.base, `/seat/${SESSION}/handoff/queue`, { token: OPERATOR })).status).toBe(200)
    expect(
      (await call(app.base, `/seat/${SESSION}/handoff/claim`, { token: OPERATOR, method: 'POST', body: '{}' }))
        .status,
    ).toBe(200)
    expect(
      (
        await call(app.base, `/seat/${SESSION}/handoff/message`, {
          token: OPERATOR,
          method: 'POST',
          body: '{"text":"你好"}',
        })
      ).status,
    ).toBe(200)
    expect(
      (await call(app.base, `/seat/${SESSION}/handoff/heartbeat`, { token: OPERATOR, method: 'POST', body: '{}' }))
        .status,
    ).toBe(200)
    expect(
      (await call(app.base, `/seat/${SESSION}/handoff/resume`, { token: OPERATOR, method: 'POST', body: '{}' }))
        .status,
    ).toBe(200)

    expect(child.calls.seats).toEqual([
      { method: 'GET', path: '/api/handoff' },
      { method: 'GET', path: '/api/handoff/queue' },
      { method: 'POST', path: '/api/handoff/claim', body: {} },
      { method: 'POST', path: '/api/handoff/message', body: { text: '你好' } },
      { method: 'POST', path: '/api/handoff/heartbeat', body: {} },
      { method: 'POST', path: '/api/handoff/resume', body: {} },
    ])
    await app.close()
  })

  it('未知会话 / 方法错 / 坏 body → 404 / 405 / 400，且不转发', async () => {
    const child = fakeChild()
    const app = await startServer({ withOperator: true, child })
    expect(
      (await call(app.base, '/seat/im-ffffffffffffffff/handoff/claim', { token: OPERATOR, method: 'POST', body: '{}' }))
        .status,
    ).toBe(404)
    expect(
      (await call(app.base, `/seat/${SESSION}/handoff/message`, { token: OPERATOR, method: 'GET' })).status,
    ).toBe(405)
    expect(
      (
        await call(app.base, `/seat/${SESSION}/handoff/message`, {
          token: OPERATOR,
          method: 'POST',
          body: 'not-json',
        })
      ).status,
    ).toBe(400)
    expect(child.calls.seats).toEqual([])
    await app.close()
  })

  it('子进程状态码原样回传（409 不包装成 200）', async () => {
    const child = fakeChild()
    child.setSeat({
      status: 409,
      json: { error: { code: 'handoff-not-active', reason: '不在接管中' } },
      text: '',
    })
    const app = await startServer({ withOperator: true, child })
    const response = await call(app.base, `/seat/${SESSION}/handoff/claim`, {
      token: OPERATOR,
      method: 'POST',
      body: '{}',
    })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('handoff-not-active')
    await app.close()
  })
})

describe('运营桥白名单与上游故障（安全边界）', () => {
  it('白名单外的路径 → 404，且不向子进程转发', async () => {
    const child = fakeChild()
    const app = await startServer({ withOperator: true, child })
    for (const path of ['/seat/foo', `/seat/${SESSION}/handoff/ban`, '/seat/sessions/extra']) {
      const response = await call(app.base, path, { token: OPERATOR })
      expect(response.status).toBe(404)
      expect(await response.text()).toContain('im-seat-unknown')
    }
    expect(child.calls.seats).toEqual([])
    await app.close()
  })

  it('会话列表只读：POST /seat/sessions → 405，且不向子进程转发', async () => {
    const child = fakeChild()
    const app = await startServer({ withOperator: true, child })
    const response = await call(app.base, '/seat/sessions', {
      token: OPERATOR,
      method: 'POST',
      body: '{}',
    })
    expect(response.status).toBe(405)
    expect(await response.text()).toContain('im-seat-method')
    expect(child.calls.seats).toEqual([])
    await app.close()
  })

  it('子进程不可达 / 返回非 JSON → 502，绝不把上游异常当成功回传', async () => {
    const child = fakeChild()
    const app = await startServer({ withOperator: true, child })

    child.setSeat({ status: 0, json: undefined, text: '' })
    const down = await call(app.base, `/seat/${SESSION}/handoff/claim`, {
      token: OPERATOR,
      method: 'POST',
      body: '{}',
    })
    expect(down.status).toBe(502)
    expect(await down.text()).toContain('im-seat-upstream')

    child.setSeat({ status: 200, json: undefined, text: 'oops' })
    const malformed = await call(app.base, `/seat/${SESSION}/handoff/queue`, { token: OPERATOR })
    expect(malformed.status).toBe(502)
    expect(await malformed.text()).toContain('im-seat-upstream')

    expect(child.calls.seats).toHaveLength(2)
    await app.close()
  })
})
