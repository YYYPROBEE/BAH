/**
 * 文本指令闭环（03 单）：批准 / 拒绝 / 详情 / 强验证 / 过期 / 转人工。
 *
 * 走真实的 `handleInbound` 与常驻 hub；子进程用 `harness-03` 的假实现。
 */

import { describe, expect, it } from 'vitest'

import type { ImInbound, ImOutbound, PlatformPushResult, PlatformReply, WebFrame } from '@bah/channels'
import { deriveImSessionId, verifyApprovalLink } from '@bah/channels'

import { NO_PENDING_TEXT } from '../src/approval/texts.ts'
import { isHelpRequest } from '../src/bridge/help.ts'
import { createPullStore } from '../src/bridge/outbound.ts'
import { handleInbound, type InboundDeps } from '../src/bridge/turn.ts'
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

/** 收尾帧。 */
function closedFrame(
  overrides: Partial<Extract<WebFrame, { kind: 'approval-closed' }>> = {},
): WebFrame {
  return {
    kind: 'approval-closed',
    seq: 20,
    at: NOW,
    ticketId: 't-1',
    decision: 'allowed-once',
    label: '已批准一次',
    ...overrides,
  }
}

/** 接管帧。 */
function handoffFrame(overrides: Partial<Extract<WebFrame, { kind: 'handoff' }>> = {}): WebFrame {
  return { kind: 'handoff', seq: 30, at: NOW, active: true, ...overrides }
}

/** 造一整套依赖 + 预置快照。 */
function setup(frames: readonly WebFrame[]): {
  deps: InboundDeps
  child: ReturnType<typeof fakeChild>
  reply: ReturnType<typeof fakeReply>
  sessionKey: string
} {
  const config = configFor()
  const child = fakeChild()
  const sessionKey = deriveImSessionId('mock', 'u-1', config.sessionSalt)
  const records = new Map([
    [sessionKey, recordOf({ platform: 'mock', userId: 'u-1', sessionKey, client: child })],
  ])
  const supervisor = fakeSupervisor({ salt: config.sessionSalt, records })
  const pull = createPullStore({ nowMs: () => NOW })
  const hub = createSessionHub({ config, log, pull, nowMs: () => NOW })
  const reply = fakeReply()
  hub.attach({ sessionKey, port: 1234, client: child }, 'mock', CAPABILITIES)
  hub.setReply(sessionKey, reply)
  if (frames.length > 0) {
    const maxSeq = frames.reduce((max, frame) => Math.max(max, 'seq' in frame ? frame.seq : 0), 0)
    child.emit({ kind: 'snapshot', sessionId: sessionKey, maxSeq, frames })
  }
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
  return { deps, child, reply, sessionKey }
}

/** 一条入站。 */
function inbound(text: string, messageId: string): ImInbound {
  return { platform: 'mock', accountKey: 'default', userId: 'u-1', text, messageId, at: NOW }
}

describe('T-IM-004 文本批准', () => {
  it('`1` → 子进程收到 allowed-once，回"已批准"；收尾帧再推送结果文本', async () => {
    const { deps, child, reply } = setup([approvalFrame()])
    const outcome = await handleInbound(deps, inbound('1', 'm-1'), reply)
    expect(outcome.response.body).toBe('已批准')
    expect(child.calls.decisions).toEqual([{ ticketId: 't-1', decision: 'allowed-once' }])
    await outcome.done

    child.emit(closedFrame())
    await deps.hub.flush()
    expect(reply.pushes.join('\n')).toContain('【审批结果】已批准一次')
  })
})

describe('T-IM-005 过期按拒绝处理', () => {
  it('unavailable 收尾 → 推送"已过期"，不出现"已批准"', async () => {
    const { deps, child, reply } = setup([approvalFrame()])
    child.emit(
      closedFrame({ decision: 'unavailable', label: '不可用', code: 'approval-timeout' }),
    )
    await deps.hub.flush()
    expect(reply.pushes.join('\n')).toContain('已过期')
    expect(reply.pushes.join('\n')).not.toContain('已批准')
    expect(deps.hub.pendingCount(deriveImSessionId('mock', 'u-1', deps.config.sessionSalt))).toBe(0)
  })
})

describe('T-IM-016 红级强验证', () => {
  it('未验证 `1` → 提示先验证且不调审批；`4` 通过后 `1` 才批准', async () => {
    const { deps, child, reply } = setup([
      approvalFrame({ tier: 'red', challenge: 'face', ticketId: 't-red' }),
    ])

    const blocked = await handleInbound(deps, inbound('1', 'm-1'), reply)
    expect(blocked.response.body).toContain('该票据需要强验证')
    expect(child.calls.decisions).toEqual([])

    const verified = await handleInbound(deps, inbound('4', 'm-2'), reply)
    expect(child.calls.verifies).toEqual(['t-red'])
    expect(verified.response.body).toContain('验证通过')

    const approved = await handleInbound(deps, inbound('1', 'm-3'), reply)
    expect(approved.response.body).toBe('已批准')
    expect(child.calls.decisions).toEqual([{ ticketId: 't-red', decision: 'allowed-once' }])
  })
})

describe('T-H5-004 多票据歧义', () => {
  it('两张待审批时 `1` 不带票号 → 要求带票号，不误批', async () => {
    const { deps, child, reply } = setup([
      approvalFrame({ ticketId: 't-1', seq: 1 }),
      approvalFrame({ ticketId: 't-2', seq: 2 }),
    ])
    const outcome = await handleInbound(deps, inbound('1', 'm-1'), reply)
    expect(outcome.response.body).toContain('请带票据号')
    expect(child.calls.decisions).toEqual([])
  })

  it('无待审批时裸 `1` 不拦截，按普通消息送模型（否则无法回答选择题）', async () => {
    const { deps, child, reply } = setup([])
    const outcome = await handleInbound(deps, inbound('1', 'm-1'), reply)
    expect(child.calls.turns).toEqual(['1'])
    expect(outcome.response.body).not.toContain('当前没有待审批')
  })
})

describe('T-IM-007 转人工与接管', () => {
  it('转人工 → 调 /api/handoff；接管帧与坐席发言推回 IM；接管期用户消息只回"已记录"', async () => {
    const { deps, child, reply, sessionKey } = setup([])

    const takeover = await handleInbound(deps, inbound('转人工 金额有疑问', 'm-1'), reply)
    expect(child.calls.handoffs).toEqual(['金额有疑问'])
    expect(takeover.response.body).toBe('已转人工，请稍候')
    expect(deps.hub.handoffActive(sessionKey)).toBe(true)

    child.emit(handoffFrame({ seq: 30 }))
    child.emit(handoffFrame({ seq: 31, operator: '小王' }))
    await deps.hub.flush()
    expect(reply.pushes).toContain('已转人工，坐席会尽快接入；期间您的消息会排队。')
    expect(reply.pushes).toContain('坐席 小王 已接入。')

    child.emit({
      kind: 'message',
      seq: 32,
      at: NOW,
      role: 'operator',
      blocks: [{ type: 'text', text: '您好，我在' }],
      operator: '小王',
    })
    await deps.hub.flush()
    expect(reply.pushes).toContain('【坐席】小王：您好，我在')

    const queued = await handleInbound(deps, inbound('查余额', 'm-2'), reply)
    expect(queued.response.body).toBe('已记录，等坐席查看')
    expect(child.calls.turns).toEqual(['查余额'])

    child.emit(handoffFrame({ seq: 33, active: false }))
    await deps.hub.flush()
    expect(reply.pushes).toContain('坐席已交回，继续为您服务。')
    expect(deps.hub.handoffActive(sessionKey)).toBe(false)
  })
})

describe('T-IM-017 详情指令', () => {
  it('`3 票据号` → 只回摘要 + 可验签的 H5 链接，不送模型也不调审批', async () => {
    const { deps, child, reply, sessionKey } = setup([approvalFrame()])
    const outcome = await handleInbound(deps, inbound('3 t-1', 'm-1'), reply)

    const body = outcome.response.body
    expect(body).toContain('【审批】转账')
    expect(body).toContain('金额：100 元')
    const link = /H5：(https:\/\/im\.example\.test\/a\/\S+)/.exec(body)
    expect(link).not.toBeNull()

    const token = link?.[1]?.split('/a/')[1] ?? ''
    const verdict = verifyApprovalLink(token, deps.config.linkSecret, NOW)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.payload).toMatchObject({ s: sessionKey, t: 't-1' })

    expect(child.calls.turns).toEqual([])
    expect(child.calls.decisions).toEqual([])
  })

  it('有票据但子进程未就绪 → 回"当前没有待审批"，不转发也不为该指令拉起子进程', async () => {
    const { deps, child, reply, sessionKey } = setup([approvalFrame()])
    await deps.supervisor.stop(sessionKey, 'idle')

    const outcome = await handleInbound(deps, inbound('1', 'm-1'), reply)
    expect(outcome.response.body).toBe(NO_PENDING_TEXT)
    expect(child.calls.decisions).toEqual([])
    expect(child.calls.turns).toEqual([])
  })
})

describe('T-IM-HELP 文本菜单', () => {
  it('「菜单」→ 回业务入口与防诈提醒，不启动子进程、不运行模型', async () => {
    const { deps, child, reply } = setup([])
    const outcome = await handleInbound(deps, inbound('菜单', 'm-help'), reply)

    const body = outcome.response.body
    expect(body).toContain('查余额')
    expect(body).toContain('挂失银行卡')
    expect(body).toContain('不会索要密码')
    expect(body).toContain('信用卡还款')
    expect(child.calls.turns).toEqual([])
    expect(child.calls.decisions).toEqual([])
  })

  it('「?」与「help」同样命中；普通业务文本不被菜单劫持', async () => {
    const { deps, reply } = setup([])
    const question = await handleInbound(deps, inbound('?', 'm-help-2'), reply)
    expect(question.response.body).toContain('【智能银行助手】')
    const english = await handleInbound(deps, inbound('help', 'm-help-3'), reply)
    expect(english.response.body).toContain('【智能银行助手】')

    expect(isHelpRequest('查余额')).toBe(false)
    expect(isHelpRequest('给王建国转 800 元')).toBe(false)
  })
})
