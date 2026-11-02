/**
 * H5 审批页的错误边：强验证失败与失效链接。
 *
 * 覆盖三个此前没有判据的状态：
 * 1. 强验证子进程返回非 200 → 状态码按理由码映射，票据不得被标成"已验"；
 * 2. 子进程返回非 JSON → 统一 400「处理失败」，内部原文不透给用户；
 * 3. 链接有效但票据已不在待办（重启 / 已处理）→ 200 不可用页，不渲染审批壳。
 */

import type { ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'

import { signApprovalLink, type WebFrame } from '@bah/channels'

import { createUsedLinkStore, handleApproveGet, handleApproveSubmit } from '../src/approval/page.ts'
import { createPullStore } from '../src/bridge/outbound.ts'
import { createImLogger } from '../src/log.ts'
import { createSessionHub } from '../src/session/hub.ts'
import { configFor, fakeChild, fakeSupervisor, recordOf } from './harness-03.ts'

const NOW = 1_793_000_000_000
const SESSION_KEY = 'im-0123456789abcdef'
const log = createImLogger('error', () => undefined)
const CAPABILITIES = {
  passiveReply: true,
  asyncPush: true,
  interactiveCards: false,
  threads: false,
  maxTextBytes: 2048,
} as const

function approvalFrame(
  overrides: Partial<Extract<WebFrame, { kind: 'approval' }>> = {},
): WebFrame {
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

function setup(frames: readonly WebFrame[] = []): {
  config: ReturnType<typeof configFor>
  child: ReturnType<typeof fakeChild>
  hub: ReturnType<typeof createSessionHub>
  deps: Parameters<typeof handleApproveSubmit>[3]
} {
  const config = configFor()
  const child = fakeChild()
  const records = new Map([
    [SESSION_KEY, recordOf({ platform: 'mock', userId: 'u-1', sessionKey: SESSION_KEY, client: child })],
  ])
  const supervisor = fakeSupervisor({ salt: config.sessionSalt, records })
  const pull = createPullStore({ nowMs: () => NOW })
  const hub = createSessionHub({ config, log, pull, nowMs: () => NOW })
  hub.attach({ sessionKey: SESSION_KEY, port: 1234, client: child }, 'mock', CAPABILITIES)
  if (frames.length > 0) {
    child.emit({ kind: 'snapshot', sessionId: SESSION_KEY, maxSeq: 10, frames })
  }
  const deps = {
    config,
    hub,
    supervisor,
    log,
    usedLinks: createUsedLinkStore({ nowMs: () => NOW }),
    nowMs: () => NOW,
  }
  return { config, child, hub, deps }
}

function linkOf(config: ReturnType<typeof configFor>, ticketId = 't-1'): string {
  return signApprovalLink(
    { v: 1, s: SESSION_KEY, t: ticketId, e: NOW + 60_000 },
    config.linkSecret,
  )
}

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

describe('H5 强验证失败路径', () => {
  it('子进程 403 foreign-ticket ⇒ H5 403，票据保持未验证', async () => {
    const app = setup([approvalFrame({ tier: 'red', challenge: 'sms' })])
    app.child.setVerify({
      status: 403,
      json: { error: { code: 'foreign-ticket', reason: '不属于本会话' } },
      text: '{"error":{"code":"foreign-ticket"}}',
    })
    const captured = captureResponse()

    await handleApproveSubmit(linkOf(app.config), '', captured.res, app.deps, 'verify')

    expect(captured.status()).toBe(403)
    expect(JSON.parse(captured.body())).toMatchObject({ error: { code: 'foreign-ticket' } })
    expect(app.child.calls.verifies).toEqual(['t-1'])
    expect(app.hub.pendingGet(SESSION_KEY, 't-1')?.verified).toBe(false)
  })

  it('子进程返回非 JSON ⇒ 400 处理失败，内部原文不透给用户', async () => {
    const app = setup([approvalFrame({ tier: 'red', challenge: 'ushield' })])
    app.child.setVerify({ status: 500, json: undefined, text: 'upstream-boom-6222' })
    const captured = captureResponse()

    await handleApproveSubmit(linkOf(app.config), '', captured.res, app.deps, 'verify')

    expect(captured.status()).toBe(400)
    expect(JSON.parse(captured.body())).toMatchObject({ error: { code: 'failed', reason: '处理失败' } })
    expect(captured.body()).not.toContain('upstream-boom')
    expect(captured.body()).not.toContain('6222')
    expect(app.hub.pendingGet(SESSION_KEY, 't-1')?.verified).toBe(false)
  })
})

describe('H5 失效链接的页面态', () => {
  it('链接有效但票据已不在待办 ⇒ 200 不可用页，不渲染审批壳', () => {
    const app = setup()
    const captured = captureResponse()

    handleApproveGet(linkOf(app.config), captured.res, app.deps)

    expect(captured.status()).toBe(200)
    expect(captured.body()).toContain('票据已处理或状态未知')
    expect(captured.body()).not.toContain('批准')
  })
})
