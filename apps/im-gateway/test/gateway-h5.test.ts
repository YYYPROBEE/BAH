/**
 * H5 审批页（03 单）：签名 / 一次性 / CSP / 转义 / 红级 / 跨会话。
 */

import type { ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'

import { signApprovalLink, type WebFrame } from '@bah/channels'

import {
  createUsedLinkStore,
  handleApprovalAsset,
  handleApproveGet,
  handleApproveSubmit,
  H5_SECURITY_HEADERS,
} from '../src/approval/page.ts'
import { createPullStore } from '../src/bridge/outbound.ts'
import { createImLogger } from '../src/log.ts'
import { createRegistry } from '../src/platform/registry.ts'
import { createGatewayServer } from '../src/server.ts'
import { createSessionHub } from '../src/session/hub.ts'
import { configFor, fakeChild, fakeSupervisor, recordOf } from './harness-03.ts'

const NOW = 1_793_000_000_000
const log = createImLogger('error', () => undefined)
const CAPABILITIES = {
  passiveReply: true,
  asyncPush: true,
  interactiveCards: false,
  threads: false,
  maxTextBytes: 2048,
} as const

/** 审批帧。 */
function approvalFrame(overrides: Partial<Extract<WebFrame, { kind: 'approval' }>> = {}): WebFrame {
  return {
    kind: 'approval',
    seq: 10,
    at: NOW,
    ticketId: 't-1',
    callId: 'call-1',
    name: 'transfer_create',
    operation: '转账',
    amountText: '100 元',
    payeeName: '张三',
    tier: 'yellow',
    expiresAt: NOW + 60_000,
    amountConfirmed: false,
    rejectReasonRequired: true,
    ...overrides,
  }
}

/** 起一个只挂 H5 路由的网关。 */
async function startServer(input: {
  readonly config: ReturnType<typeof configFor>
  readonly child: ReturnType<typeof fakeChild>
  readonly sessionKey: string
}): Promise<{
  base: string
  hub: ReturnType<typeof createSessionHub>
  supervisor: ReturnType<typeof fakeSupervisor>
  close(): Promise<void>
}> {
  const config = input.config
  const child = input.child
  const records = new Map([
    [
      input.sessionKey,
      recordOf({ platform: 'mock', userId: 'u-1', sessionKey: input.sessionKey, client: child }),
    ],
  ])
  const supervisor = fakeSupervisor({ salt: config.sessionSalt, records })
  const pull = createPullStore({ nowMs: () => NOW })
  const hub = createSessionHub({ config, log, pull, nowMs: () => NOW })
  hub.attach({ sessionKey: input.sessionKey, port: 1234, client: child }, 'mock', CAPABILITIES)
  const pageDeps = {
    config,
    hub,
    supervisor,
    log,
    usedLinks: createUsedLinkStore({ nowMs: () => NOW }),
    nowMs: () => NOW,
  }
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
    seatEnabled: false,
    approvePage: {
      get: (token, res) => handleApproveGet(token, res, pageDeps),
      submit: (token, body, res, kind) => handleApproveSubmit(token, body, res, pageDeps, kind),
      asset: (name, res) => handleApprovalAsset(name, res),
    },
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${String(port)}`,
    hub,
    supervisor,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/** 签一条链接。 */
function linkOf(
  config: ReturnType<typeof configFor>,
  sessionKey: string,
  ticketId: string,
  e = NOW + 60_000,
): string {
  return signApprovalLink({ v: 1, s: sessionKey, t: ticketId, e }, config.linkSecret)
}

/** 发一次 POST。 */
async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 捕获一次直接调用的响应（不启端口，避免并行跑批时的网络抖动）。 */
function captureResponse(): {
  res: ServerResponse
  status: () => number
  body: () => string
} {
  let status = 0
  let body = ''
  const res = {
    writeHead: (code: number): typeof res => {
      status = code
      return res
    },
    end: (payload?: string): void => {
      body = payload ?? ''
    },
  } as unknown as ServerResponse
  return { res, status: () => status, body: () => body }
}

describe('T-H5-001 页面安全头与零远程', () => {
  it('CSP 固定串 / no-store / no-referrer / 无内联脚本 / 无远程 URL', async () => {
    const config = configFor()
    const sessionKey = 'im-0123456789abcdef'
    const child = fakeChild()
    const app = await startServer({ config, child, sessionKey })
    child.emit({ kind: 'snapshot', sessionId: sessionKey, maxSeq: 10, frames: [approvalFrame()] })

    const token = linkOf(config, sessionKey, 't-1')
    const response = await fetch(`${app.base}/a/${token}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(H5_SECURITY_HEADERS['content-security-policy'])
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const body = await response.text()
    expect(body).not.toMatch(/https?:\/\//)
    expect(body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    expect(body).toContain('转账')
    expect(body).toContain('100 元')
    await app.close()
  })

  it('所有动态字段转义（收款人名里的标签不会变成 HTML）', () => {
    const config = configFor()
    const sessionKey = 'im-0123456789abcdef'
    const child = fakeChild()
    const records = new Map([
      [sessionKey, recordOf({ platform: 'mock', userId: 'u-1', sessionKey, client: child })],
    ])
    const supervisor = fakeSupervisor({ salt: config.sessionSalt, records })
    const pull = createPullStore({ nowMs: () => NOW })
    const hub = createSessionHub({ config, log, pull, nowMs: () => NOW })
    hub.attach({ sessionKey, port: 1234, client: child }, 'mock', CAPABILITIES)
    child.emit({
      kind: 'snapshot',
      sessionId: sessionKey,
      maxSeq: 10,
      frames: [approvalFrame({ payeeName: '<script>alert(1)</script>' })],
    })
    const captured = captureResponse()
    handleApproveGet(linkOf(config, sessionKey, 't-1'), captured.res, {
      config,
      hub,
      supervisor,
      log,
      usedLinks: createUsedLinkStore({ nowMs: () => NOW }),
      nowMs: () => NOW,
    })
    const body = captured.body()
    expect(body).not.toContain('<script>alert')
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('静态资源只认白名单两个文件', async () => {
    const config = configFor()
    const child = fakeChild()
    const app = await startServer({ config, child, sessionKey: 'im-0123456789abcdef' })
    const css = await fetch(`${app.base}/assets/approve.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
    const js = await fetch(`${app.base}/assets/approve.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect((await fetch(`${app.base}/assets/other.js`)).status).toBe(404)
    await app.close()
  })
})

describe('T-IM-015 链接签名', () => {
  it('改一位明文 → 403；过期 → 410', async () => {
    const config = configFor()
    const sessionKey = 'im-0123456789abcdef'
    const child = fakeChild()
    const app = await startServer({ config, child, sessionKey })
    child.emit({ kind: 'snapshot', sessionId: sessionKey, maxSeq: 10, frames: [approvalFrame()] })

    const token = linkOf(config, sessionKey, 't-1')
    const [part, signature] = token.split('.')
    const forged = `${(part ?? '').slice(0, -1)}${(part ?? '').endsWith('A') ? 'B' : 'A'}.${signature ?? ''}`
    expect((await fetch(`${app.base}/a/${forged}`)).status).toBe(403)
    expect((await fetch(`${app.base}/a/${linkOf(config, sessionKey, 't-1', NOW - 1)}`)).status).toBe(410)
    await app.close()
  })
})

describe('T-H5-002 / T-H5-003 拒绝理由与一次性', () => {
  it('空理由 → 400 reason-required；补理由后 200；二次提交 → 409', async () => {
    const config = configFor()
    const sessionKey = 'im-0123456789abcdef'
    const child = fakeChild()
    const app = await startServer({ config, child, sessionKey })
    child.emit({ kind: 'snapshot', sessionId: sessionKey, maxSeq: 10, frames: [approvalFrame()] })

    const token = linkOf(config, sessionKey, 't-1', NOW + 60_001)
    const empty = await post(app.base, `/a/${token}`, { decision: 'rejected' })
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe('reason-required')
    expect(child.calls.decisions).toEqual([])

    const valid = await post(app.base, `/a/${token}`, { decision: 'rejected', reason: '金额不对' })
    expect(valid.status).toBe(200)
    expect(child.calls.decisions).toEqual([
      { ticketId: 't-1', decision: 'rejected', reason: '金额不对' },
    ])

    const replay = await post(app.base, `/a/${token}`, { decision: 'allowed-once' })
    expect(replay.status).toBe(409)
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('im-h5-used')
    expect(child.calls.decisions.length).toBe(1)
    await app.close()
  })

  it('理由超过 500 字 → 400，且不烧链接', async () => {
    const config = configFor()
    const sessionKey = 'im-0123456789abcdef'
    const child = fakeChild()
    const app = await startServer({ config, child, sessionKey })
    child.emit({ kind: 'snapshot', sessionId: sessionKey, maxSeq: 10, frames: [approvalFrame()] })
    const token = linkOf(config, sessionKey, 't-1', NOW + 60_002)
    const tooLong = await post(app.base, `/a/${token}`, { decision: 'rejected', reason: 'x'.repeat(501) })
    expect(tooLong.status).toBe(400)
    expect(child.calls.decisions).toEqual([])
    await app.close()
  })
})

describe('T-IM-016 / T-H5-004 红级与跨会话', () => {
  it('红级未验证批准 → 400 challenge-required；验证后放行', async () => {
    const config = configFor()
    const sessionKey = 'im-0123456789abcdef'
    const child = fakeChild()
    const app = await startServer({ config, child, sessionKey })
    child.emit({
      kind: 'snapshot',
      sessionId: sessionKey,
      maxSeq: 10,
      frames: [approvalFrame({ tier: 'red', challenge: 'face' })],
    })
    const token = linkOf(config, sessionKey, 't-1', NOW + 60_003)

    const blocked = await post(app.base, `/a/${token}`, { decision: 'allowed-once' })
    expect(blocked.status).toBe(400)
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('challenge-required')
    expect(child.calls.decisions).toEqual([])

    const verified = await post(app.base, `/a/${token}/verify`, {})
    expect(verified.status).toBe(200)
    expect(child.calls.verifies).toEqual(['t-1'])

    const approved = await post(app.base, `/a/${token}`, { decision: 'allowed-once' })
    expect(approved.status).toBe(200)
    expect(child.calls.decisions).toEqual([{ ticketId: 't-1', decision: 'allowed-once' }])
    await app.close()
  })

  it('用本会话 token 提交另一张票 → 转发到本会话子进程，子进程 unknown-ticket → 404', async () => {
    const config = configFor()
    const sessionKey = 'im-0123456789abcdef'
    const child = fakeChild()
    child.setDecide({
      status: 404,
      json: { error: { code: 'unknown-ticket', reason: '没有待应答的票据' } },
      text: '',
    })
    const app = await startServer({ config, child, sessionKey })
    const token = linkOf(config, sessionKey, 't-other', NOW + 60_004)
    const response = await post(app.base, `/a/${token}`, { decision: 'allowed-once' })
    expect(response.status).toBe(404)
    // 网关按 token 里的 sessionKey 选子进程；票号原样交给子进程裁决
    expect(child.calls.decisions[0]?.ticketId).toBe('t-other')
    await app.close()
  })
})
