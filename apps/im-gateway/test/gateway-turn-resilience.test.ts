/**
 * 入站一轮的韧性面（D0 真机修复周边）：
 * - 平台能力位缺失的防御性离线文案；
 * - 转人工拉起失败的两种用户可见结果；
 * - per-turn 订阅只收本轮助手消息（审批 / 接管 / 坐席帧交给常驻 hub）；
 * - SSE 断流不打断本轮投递；
 * - 回合失败的结构化兜底。
 *
 * 走真实 `handleInbound` 与常驻 hub；子进程用 `harness-03` 的假实现。
 */

import { describe, expect, it } from 'vitest'

import type { ImInbound, ImOutbound, PlatformPushResult, PlatformReply, WebFrame } from '@bah/channels'
import { deriveImSessionId } from '@bah/channels'

import { QUEUED_FOR_OPERATOR_TEXT } from '../src/approval/texts.ts'
import { createPullStore } from '../src/bridge/outbound.ts'
import { handleInbound, type InboundDeps } from '../src/bridge/turn.ts'
import { BUSY_TEXT, FAILED_TEXT, OFFLINE_TEXT } from '../src/config.ts'
import { createDedupe } from '../src/ingress/dedupe.ts'
import { createRateLimiter } from '../src/ingress/ratelimit.ts'
import { createImLogger } from '../src/log.ts'
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

/** 记录被动 / 主动出站。 */
function fakeReply(): PlatformReply & { passives: string[]; pushes: string[] } {
  const passives: string[] = []
  const pushes: string[] = []
  return {
    passives,
    pushes,
    passive(outbounds: readonly ImOutbound[]) {
      const text = outbounds.map((item) => item.text).join('\n')
      passives.push(text)
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: text }
    },
    async push(outbounds: readonly ImOutbound[]): Promise<PlatformPushResult> {
      pushes.push(...outbounds.map((item) => item.text))
      return { ok: true }
    },
  }
}

/** 造一整套依赖（可选让 `ensure` 直接抛错）。 */
function setup(options: { readonly ensureError?: Error } = {}): {
  deps: InboundDeps
  child: ReturnType<typeof fakeChild>
  reply: ReturnType<typeof fakeReply>
} {
  const config = configFor()
  const child = fakeChild()
  const sessionKey = deriveImSessionId('mock', 'u-1', config.sessionSalt)
  const records = new Map([
    [sessionKey, recordOf({ platform: 'mock', userId: 'u-1', sessionKey, client: child })],
  ])
  const supervisor = fakeSupervisor({
    salt: config.sessionSalt,
    records,
    ...(options.ensureError === undefined ? {} : { ensureError: options.ensureError }),
  })
  const pull = createPullStore({ nowMs: () => NOW })
  const hub = createSessionHub({ config, log, pull, nowMs: () => NOW })
  const reply = fakeReply()
  hub.attach({ sessionKey, port: 1234, client: child }, 'mock', CAPABILITIES)
  hub.setReply(sessionKey, reply)
  const deps: InboundDeps = {
    config,
    supervisor,
    dedupe: createDedupe({ nowMs: () => NOW }),
    rateLimiter: createRateLimiter(),
    pull,
    hub,
    log,
    capabilitiesOf: () => CAPABILITIES,
    openWaitMs: 10,
  }
  return { deps, child, reply }
}

/** 一条入站。 */
function inbound(text: string, messageId: string): ImInbound {
  return { platform: 'mock', accountKey: 'default', userId: 'u-1', text, messageId, at: NOW }
}

function messageFrame(text: string, seq: number, role: 'assistant' | 'operator' = 'assistant'): WebFrame {
  return { kind: 'message', seq, at: NOW, role, blocks: [{ type: 'text', text }] }
}

function turnEndFrame(seq: number): WebFrame {
  return { kind: 'turn', seq, at: NOW, turn: 1, phase: 'end', endKind: 'completed' }
}

function approvalFrame(seq: number): WebFrame {
  return {
    kind: 'approval',
    seq,
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
  }
}

function handoffFrame(seq: number): WebFrame {
  return { kind: 'handoff', seq, at: NOW, active: true }
}

describe('handleInbound 韧性（D0 周边）', () => {
  it('平台能力位缺失 → 离线文案，不启动子进程也不送模型', async () => {
    const { deps, child, reply } = setup()
    const outcome = await handleInbound(
      { ...deps, capabilitiesOf: () => undefined },
      inbound('查余额', 'm-cap'),
      reply,
    )
    expect(outcome.response.body).toBe(OFFLINE_TEXT)
    expect(child.calls.turns).toEqual([])
  })

  it('转人工时子进程已达上限 → 当前咨询人数较多；其它拉起失败 → 系统繁忙', async () => {
    const capped = setup({
      ensureError: Object.assign(new Error('full'), { code: 'im-children-full' }),
    })
    const busy = await handleInbound(capped.deps, inbound('转人工', 'm-h1'), capped.reply)
    expect(busy.response.body).toBe(BUSY_TEXT)
    expect(capped.child.calls.handoffs).toEqual([])

    const broken = setup({ ensureError: new Error('spawn-failed') })
    const offline = await handleInbound(broken.deps, inbound('转人工', 'm-h2'), broken.reply)
    expect(offline.response.body).toBe(OFFLINE_TEXT)
    expect(broken.child.calls.handoffs).toEqual([])
  })

  it('per-turn 只投递本轮助手消息；审批 / 坐席帧不重复进被动回复', async () => {
    const { deps, child, reply } = setup()
    const assistant = '查询结果：余额 100 元'
    const originalTurn = child.turn.bind(child)
    child.turn = async (text: string) => {
      child.emit(approvalFrame(1))
      child.emit(messageFrame('坐席：您好，我是小王', 2, 'operator'))
      child.emit(messageFrame(assistant, 3))
      child.emit(turnEndFrame(4))
      return originalTurn(text)
    }

    const outcome = await handleInbound(deps, inbound('查余额', 'm-filter'), reply)
    expect(outcome.response.body).toBe(assistant)
    await outcome.done

    // 常驻订阅仍把坐席发言推给用户：per-turn 丢弃不等于静默
    await deps.hub.flush()
    expect(reply.pushes.join('\n')).toContain('坐席：您好，我是小王')
  })

  it('回合进行中收到接管帧 → 立即回"已记录"，不空等本轮结果', async () => {
    const { deps, child, reply } = setup()
    const originalTurn = child.turn.bind(child)
    child.turn = async (text: string) => {
      child.emit(handoffFrame(1))
      return originalTurn(text)
    }

    const outcome = await handleInbound(deps, inbound('查余额', 'm-takeover'), reply)
    expect(outcome.response.body).toBe(QUEUED_FOR_OPERATOR_TEXT)
    expect(deps.hub.handoffActive(deriveImSessionId('mock', 'u-1', deps.config.sessionSalt))).toBe(true)
  })

  it('SSE 断流只记日志，不打断本轮投递', async () => {
    const { deps, child, reply } = setup()
    const assistant = '已为你查到最近一笔交易'
    const originalTurn = child.turn.bind(child)
    child.turn = async (text: string) => {
      child.failStream(new Error('stream-boom'))
      child.emit(messageFrame(assistant, 1))
      child.emit(turnEndFrame(2))
      return originalTurn(text)
    }

    const outcome = await handleInbound(deps, inbound('查余额', 'm-sse'), reply)
    expect(outcome.response.body).toBe(assistant)
    await outcome.done
  })

  it('子进程回合失败（非 auth / inbox-full / halted）→ 固定失败文案，不泄露内部码', async () => {
    const { deps, child, reply } = setup()
    child.setTurn({ kind: 'failed', status: 502, code: 'upstream-500' })

    const outcome = await handleInbound(deps, inbound('查余额', 'm-fail'), reply)
    expect(outcome.response.body).toBe(FAILED_TEXT)
    expect(outcome.response.body).not.toContain('upstream-500')
  })
})
