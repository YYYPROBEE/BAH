/**
 * 常驻会话运行态补漏（03 单 §2.1 / §2.6）。
 *
 * 只钉四条“错了会静默伤人”的路径：
 * 1. 断线重连的快照必须恢复接管态——否则 AI 会在坐席服务期间继续抢答；
 * 2. 推送适配器抛错必须落拉取式——否则审批提示永久丢失；
 * 3. `pushMode=pull` 必须尊重配置——否则平台未开客服消息时会反复失败；
 * 4. warning/danger 提示是用户唯一可见的系统告警出口，不能丢。
 */

import { describe, expect, it } from 'vitest'

import type { ImOutbound, PlatformPushResult, PlatformReply, WebFrame } from '@bah/channels'

import { createPullStore, type PullStore } from '../src/bridge/outbound.ts'
import { createImLogger } from '../src/log.ts'
import { createSessionHub } from '../src/session/hub.ts'
import { configFor, fakeChild } from './harness-03.ts'

const NOW = 1_793_000_000_000
const SESSION = 'im-0123456789abcdef'
const log = createImLogger('error', () => undefined)
const CAPABILITIES = {
  passiveReply: true,
  asyncPush: true,
  interactiveCards: false,
  threads: false,
  maxTextBytes: 2048,
} as const

/** 假回复：记录主动推送文本；可切换“返回失败”与“直接抛错”。 */
function fakeReply(
  options: { fail?: boolean; throwError?: boolean } = {},
): PlatformReply & { pushes: string[] } {
  const pushes: string[] = []
  return {
    pushes,
    passive(outbounds: readonly ImOutbound[]) {
      return { status: 200, headers: {}, body: outbounds.map((item) => item.text).join('\n') }
    },
    async push(outbounds: readonly ImOutbound[]): Promise<PlatformPushResult> {
      if (options.throwError === true) throw new Error('adapter-boom')
      if (options.fail === true) return { ok: false, code: 'unavailable', reason: 'fake' }
      pushes.push(...outbounds.map((item) => item.text))
      return { ok: true }
    },
  }
}

/** 审批帧。 */
function approvalFrame(overrides: Partial<Extract<WebFrame, { kind: 'approval' }>> = {}): WebFrame {
  return {
    kind: 'approval',
    seq: 10,
    at: NOW,
    ticketId: 'ticket:abc',
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

/** 接管帧。 */
function handoffFrame(overrides: Partial<Extract<WebFrame, { kind: 'handoff' }>> = {}): WebFrame {
  return { kind: 'handoff', seq: 30, at: NOW, active: true, ...overrides }
}

/** 快照帧；`maxSeq` 由帧内最大 seq 推出，避免把后续增量误判成旧帧。 */
function snapshotOf(frames: readonly WebFrame[]): WebFrame {
  const maxSeq = frames.reduce((max, frame) => Math.max(max, 'seq' in frame ? frame.seq : 0), 0)
  return { kind: 'snapshot', sessionId: SESSION, maxSeq, frames }
}

/** 造一个已 attach 的 hub（可按用例替换配置与拉取缓存）。 */
function hubWith(
  reply: PlatformReply,
  options: { readonly config?: ReturnType<typeof configFor>; readonly pull?: PullStore } = {},
): {
  hub: ReturnType<typeof createSessionHub>
  child: ReturnType<typeof fakeChild>
  pull: PullStore
} {
  const config = options.config ?? configFor()
  const pull = options.pull ?? createPullStore({ nowMs: () => NOW })
  const child = fakeChild()
  const hub = createSessionHub({ config, log, pull, nowMs: () => NOW })
  hub.attach({ sessionKey: SESSION, port: 1234, client: child }, 'mock', CAPABILITIES)
  hub.setReply(SESSION, reply)
  return { hub, child, pull }
}

describe('断线重连的接管态（§2.1 快照重建）', () => {
  it('快照里 active handoff → hub 恢复接管态（否则 AI 与坐席抢答）', () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotOf([handoffFrame({ seq: 30, operator: '小王' })]))
    expect(hub.handoffActive(SESSION)).toBe(true)
    expect(hub.summaryOf(SESSION, 'mock')).toMatchObject({
      sessionKey: SESSION,
      platform: 'mock',
      handoffActive: true,
    })
    // 快照只重建状态，不补发历史接管消息
    expect(reply.pushes).toEqual([])
  })
})

describe('主动推送降级（§2.6）', () => {
  it('适配器 push 抛错 → 落拉取式，审批提示不丢', async () => {
    const pull = createPullStore({ nowMs: () => NOW })
    const reply = fakeReply({ throwError: true })
    const { hub, child } = hubWith(reply, { pull })
    child.emit(snapshotOf([]))
    child.emit(approvalFrame())
    await hub.flush()
    expect(reply.pushes).toEqual([])
    expect(pull.latest(SESSION)).toContain('【审批】转账')
  })

  it('pushMode=pull → 即使平台支持异步推送也不调用 push，改落拉取式', async () => {
    const pull = createPullStore({ nowMs: () => NOW })
    const reply = fakeReply()
    const { hub, child } = hubWith(reply, {
      config: configFor({ BAH_IM_PUSH_MODE: 'pull' }),
      pull,
    })
    child.emit(snapshotOf([]))
    child.emit(approvalFrame())
    await hub.flush()
    expect(reply.pushes).toEqual([])
    expect(pull.latest(SESSION)).toContain('【审批】转账')
  })
})

describe('系统告警提示（§2.6）', () => {
  it('warning/danger 推给用户；info/success 不打扰', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotOf([]))
    child.emit({
      kind: 'notice',
      seq: 50,
      at: NOW,
      level: 'warning',
      title: '系统繁忙',
      text: '请稍后再试',
    })
    child.emit({ kind: 'notice', seq: 51, at: NOW, level: 'info', title: '普通提示' })
    await hub.flush()
    expect(reply.pushes).toEqual(['【提示】系统繁忙：请稍后再试'])
  })
})

describe('子进程重建（凭证轮换 / 重启后）', () => {
  it('同一 sessionKey 换新 client：旧订阅关闭、旧待审批清空，新流按快照重建', () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotOf([approvalFrame()]))
    expect(hub.pendingCount(SESSION)).toBe(1)
    expect(child.subscribers()).toBe(1)

    const rebuilt = fakeChild()
    hub.attach({ sessionKey: SESSION, port: 9001, client: rebuilt }, 'mock', CAPABILITIES)

    // 旧子进程的订阅必须断掉，否则两条流会把同一帧推两遍
    expect(child.subscribers()).toBe(0)
    // 旧票状态不能跨进程存活：重建后的快照才是唯一真相
    expect(hub.pendingCount(SESSION)).toBe(0)

    rebuilt.emit(snapshotOf([approvalFrame({ seq: 11, ticketId: 'ticket:new' })]))
    expect(hub.pendingList(SESSION).map((ticket) => ticket.ticketId)).toEqual(['ticket:new'])
  })
})

describe('接管帧幂等（§2.6）', () => {
  it('同状态重复帧不重复推送；operator 变化才再推一条', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotOf([]))

    child.emit(handoffFrame({ seq: 30 }))
    await hub.flush()
    child.emit(handoffFrame({ seq: 31 }))
    await hub.flush()
    child.emit(handoffFrame({ seq: 32, operator: '小王' }))
    await hub.flush()
    child.emit(handoffFrame({ seq: 33, operator: '小王' }))
    await hub.flush()

    expect(reply.pushes.filter((text) => text.includes('已转人工'))).toHaveLength(1)
    expect(reply.pushes.filter((text) => text.includes('小王 已接入'))).toHaveLength(1)
  })
})
