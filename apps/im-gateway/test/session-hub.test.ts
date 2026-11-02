/**
 * 常驻会话运行态：快照重建 / 审批推送 / 收尾 / 接管 / 坐席发言 / 迟到回复。
 */

import { describe, expect, it } from 'vitest'

import type { ImOutbound, PlatformPushResult, PlatformReply, WebFrame } from '@bah/channels'

import { createPullStore } from '../src/bridge/outbound.ts'
import { createImLogger } from '../src/log.ts'
import { createSessionHub } from '../src/session/hub.ts'
import { configFor, fakeChild } from './harness-03.ts'

const NOW = 1_793_000_000_000
const SESSION = 'im-0123456789abcdef'
const log = createImLogger('error', () => undefined)

/** 假回复：记录主动推送文本。 */
function fakeReply(options: { fail?: boolean } = {}): PlatformReply & { pushes: string[] } {
  const pushes: string[] = []
  return {
    pushes,
    passive(outbounds: readonly ImOutbound[]) {
      return { status: 200, headers: {}, body: outbounds.map((item) => item.text).join('\n') }
    },
    async push(outbounds: readonly ImOutbound[]): Promise<PlatformPushResult> {
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

/** 审批收尾帧。 */
function closedFrame(
  overrides: Partial<Extract<WebFrame, { kind: 'approval-closed' }>> = {},
): WebFrame {
  return {
    kind: 'approval-closed',
    seq: 20,
    at: NOW,
    ticketId: 'ticket:abc',
    decision: 'rejected',
    label: '已拒绝',
    ...overrides,
  }
}

/** 接管帧。 */
function handoffFrame(overrides: Partial<Extract<WebFrame, { kind: 'handoff' }>> = {}): WebFrame {
  return { kind: 'handoff', seq: 30, at: NOW, active: true, ...overrides }
}

/** 消息帧。 */
function messageFrame(
  role: 'assistant' | 'operator',
  text: string,
  overrides: Partial<Extract<WebFrame, { kind: 'message' }>> = {},
): WebFrame {
  return {
    kind: 'message',
    seq: 40,
    at: NOW,
    role,
    blocks: [{ type: 'text', text }],
    ...overrides,
  }
}

/** 快照帧。 */
function snapshotFrame(frames: readonly WebFrame[], maxSeq: number): WebFrame {
  return { kind: 'snapshot', sessionId: SESSION, maxSeq, frames }
}

/** 快照的 maxSeq 取帧内最大 seq（避免把后续增量误判成"快照里的旧帧"）。 */
function snapshotOf(frames: readonly WebFrame[]): WebFrame {
  const maxSeq = frames.reduce((max, frame) => {
    const seq = 'seq' in frame ? frame.seq : 0
    return Math.max(max, seq)
  }, 0)
  return snapshotFrame(frames, maxSeq)
}

/** 造一个已 attach 的 hub。 */
function hubWith(reply: PlatformReply): {
  hub: ReturnType<typeof createSessionHub>
  child: ReturnType<typeof fakeChild>
} {
  const config = configFor()
  const child = fakeChild()
  const hub = createSessionHub({
    config,
    log,
    pull: createPullStore({ nowMs: () => NOW }),
    nowMs: () => NOW,
  })
  hub.attach({ sessionKey: SESSION, port: 1234, client: child }, 'mock', {
    passiveReply: true,
    asyncPush: true,
    interactiveCards: false,
    threads: false,
    maxTextBytes: 2048,
  })
  hub.setReply(SESSION, reply)
  return { hub, child }
}

describe('快照重建（§2.1）', () => {
  it('approval-closed 优先：同一票据两类帧都在 → 不在待审批列表', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotOf([approvalFrame(), closedFrame()]))
    expect(hub.pendingCount(SESSION)).toBe(0)
    await hub.flush()
    expect(reply.pushes).toEqual([])
  })

  it('快照只重建、不补发：待审批 1 张，但不推送历史审批消息', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotOf([approvalFrame({ ticketId: 't-1', seq: 5 })]))
    expect(hub.pendingCount(SESSION)).toBe(1)
    await hub.flush()
    expect(reply.pushes).toEqual([])
  })
})

describe('增量审批（T-IM-004 / T-IM-005）', () => {
  it('新审批帧 → 推送摘要 + 票据 + H5 链接 + 指令提示', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotFrame([], 0))
    child.emit(approvalFrame())
    await hub.flush()
    expect(hub.pendingCount(SESSION)).toBe(1)
    const text = reply.pushes.join('\n')
    expect(text).toContain('【审批】转账')
    expect(text).toContain('票据 ticket:abc')
    expect(text).toContain('https://im.example.test/a/')
    expect(text).toContain('回复：1 批准一次')
  })

  it('收尾 unavailable → 推送"已过期"，绝不出现"已批准"', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotFrame([], 0))
    child.emit(approvalFrame())
    child.emit(closedFrame({ decision: 'unavailable', label: '不可用', code: 'approval-timeout', reason: undefined }))
    await hub.flush()
    expect(hub.pendingCount(SESSION)).toBe(0)
    const text = reply.pushes.join('\n')
    expect(text).toContain('已过期')
    expect(text).not.toContain('已批准')
  })

  it('同一 seq 的帧不重复处理（快照与增量并发）', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotFrame([], 10))
    child.emit(approvalFrame({ seq: 10 }))
    await hub.flush()
    expect(reply.pushes).toEqual([])
    expect(hub.pendingCount(SESSION)).toBe(0)
  })
})

describe('接管与坐席（T-IM-007）', () => {
  it('进入 / 认领 / 交回三态文案', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotFrame([], 0))
    child.emit(handoffFrame({ seq: 30 }))
    child.emit(handoffFrame({ seq: 31, operator: '小王' }))
    child.emit(handoffFrame({ seq: 32, active: false }))
    await hub.flush()
    expect(reply.pushes).toEqual([
      '已转人工，坐席会尽快接入；期间您的消息会排队。',
      '坐席 小王 已接入。',
      '坐席已交回，继续为您服务。',
    ])
    expect(hub.handoffActive(SESSION)).toBe(false)
  })

  it('坐席发言 → 【坐席】{name}：{text}', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotFrame([], 0))
    child.emit(messageFrame('operator', '您好，我是坐席', { operator: '小王' }))
    await hub.flush()
    expect(reply.pushes).toEqual(['【坐席】小王：您好，我是坐席'])
  })
})

describe('turn 闸门（避免重复推送）', () => {
  it('turn 进行中：助手消息由 per-turn 投递，常驻订阅不重复推', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotFrame([], 0))
    hub.beginTurn(SESSION)
    child.emit(messageFrame('assistant', '本轮回复'))
    await hub.flush()
    expect(reply.pushes).toEqual([])
    hub.endTurn(SESSION)
    child.emit(messageFrame('assistant', '迟到的回复', { seq: 41 }))
    await hub.flush()
    expect(reply.pushes).toEqual(['迟到的回复'])
  })
})

describe('推送降级与清理', () => {
  it('推送失败 → 落拉取式（回复 0 可取回）', async () => {
    const reply = fakeReply({ fail: true })
    const config = configFor()
    const child = fakeChild()
    const pull = createPullStore({ nowMs: () => NOW })
    const hub = createSessionHub({ config, log, pull, nowMs: () => NOW })
    hub.attach({ sessionKey: SESSION, port: 1234, client: child }, 'mock', {
      passiveReply: true,
      asyncPush: true,
      interactiveCards: false,
      threads: false,
      maxTextBytes: 2048,
    })
    hub.setReply(SESSION, reply)
    child.emit(snapshotFrame([], 0))
    child.emit(approvalFrame())
    await hub.flush()
    expect(pull.latest(SESSION)).toContain('【审批】转账')
  })

  it('常驻 SSE 断开 → 下一次 attach 重新订阅并按快照重建', async () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    expect(child.subscribers()).toBe(1)
    child.failStream()
    expect(child.subscribers()).toBe(0)

    hub.attach({ sessionKey: SESSION, port: 1234, client: child }, 'mock', {
      passiveReply: true,
      asyncPush: true,
      interactiveCards: false,
      threads: false,
      maxTextBytes: 2048,
    })
    expect(child.subscribers()).toBe(1)
    child.emit(snapshotOf([approvalFrame()]))
    expect(hub.pendingCount(SESSION)).toBe(1)
    await hub.flush()
  })

  it('detach 清掉待审批与接管状态', () => {
    const reply = fakeReply()
    const { hub, child } = hubWith(reply)
    child.emit(snapshotFrame([approvalFrame()], 10))
    expect(hub.pendingCount(SESSION)).toBe(1)
    hub.detach(SESSION)
    expect(hub.pendingCount(SESSION)).toBe(0)
    expect(hub.handoffActive(SESSION)).toBe(false)
    expect(child.subscribers()).toBe(0)
  })
})
