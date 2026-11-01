/**
 * headless 自动应答者（施工单 09 §6）：默认拒绝之外的**显式**演示/回归通道。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId } from '@bah/test-support'

import { createHeadlessResponder } from './headless-responder.ts'
import type { ApprovalAnswer, ApprovalView, ChallengeView, Timer } from './types.ts'

/** 造一个可观察应答的视图。 */
function makeView(challenge?: ChallengeView): { view: ApprovalView; answers: ApprovalAnswer[] } {
  const answers: ApprovalAnswer[] = []
  const view: ApprovalView = {
    ticketId: 'ticket:c1',
    sessionId: asSessionId('s-1'),
    callId: 'c1',
    name: 'transfer_create',
    summary: { title: '执行 transfer_create', amount: 800, tier: 'yellow' },
    ...(challenge === undefined ? {} : { challenge }),
    signal: new AbortController().signal,
    answer: (answer) => {
      answers.push(answer)
      return { accepted: true }
    },
  }
  return { view, answers }
}

/** 手动定时器。 */
function manualTimer(): {
  timer: Timer
  scheduled(): readonly { readonly delayMs: number; readonly cancelled: boolean }[]
  fire(): void
} {
  const items: { fn: () => void; delayMs: number; cancelled: boolean }[] = []
  return {
    timer: {
      set(fn, delayMs) {
        const item = { fn, delayMs, cancelled: false }
        items.push(item)
        return () => {
          item.cancelled = true
        }
      },
    },
    scheduled: () => items,
    fire() {
      const item = items[0]
      if (item === undefined) throw new Error('没有定时器')
      if (!item.cancelled) item.fn()
    },
  }
}

describe('headless 自动应答者', () => {
  it('缺省：立即 allowed-once', () => {
    const responder = createHeadlessResponder()
    expect(responder.id).toBe('headless-auto')
    const { view, answers } = makeView()
    responder.attach(view)
    expect(answers).toEqual([{ decision: 'allowed-once' }])
  })

  it('驳回 / 取消带理由', () => {
    const reject = createHeadlessResponder({ decision: 'rejected', reason: 'demo-reject' })
    const first = makeView()
    reject.attach(first.view)
    expect(first.answers[0]).toEqual({ decision: 'rejected', reason: 'demo-reject' })

    const cancel = createHeadlessResponder({ decision: 'cancelled', reason: 'demo-cancel' })
    const second = makeView()
    cancel.attach(second.view)
    expect(second.answers[0]).toEqual({ decision: 'cancelled', reason: 'demo-cancel' })
  })

  it('红级：先验证，通过才应答 allowed-once', async () => {
    let verified = 0
    const challenge: ChallengeView = {
      challengeId: 'vc-1',
      channel: 'sms',
      verify: async () => {
        verified += 1
        return { ok: true }
      },
    }
    const responder = createHeadlessResponder()
    const { view, answers } = makeView(challenge)
    responder.attach(view)
    await Promise.resolve()
    await Promise.resolve()
    expect(verified).toBe(1)
    expect(answers).toEqual([{ decision: 'allowed-once' }])
  })

  it('红级验证失败：直接驳回（批准不可达）', async () => {
    const challenge: ChallengeView = {
      challengeId: 'vc-2',
      channel: 'sms',
      verify: async () => ({ ok: false, code: 'verify-failed', reason: '第 1 次验证未通过' }),
    }
    const responder = createHeadlessResponder()
    const { view, answers } = makeView(challenge)
    responder.attach(view)
    await Promise.resolve()
    await Promise.resolve()
    expect(answers[0]).toEqual({ decision: 'rejected', reason: '第 1 次验证未通过' })
  })

  it('验证端口抛错：归一化为 unavailable（默认拒绝）', async () => {
    const challenge: ChallengeView = {
      challengeId: 'vc-3',
      channel: 'face',
      verify: async () => {
        throw new Error('provider down')
      },
    }
    const responder = createHeadlessResponder()
    const { view, answers } = makeView(challenge)
    responder.attach(view)
    await Promise.resolve()
    await Promise.resolve()
    expect(answers[0]).toEqual({ decision: 'unavailable', reason: 'approval-responder-error' })
  })

  it('verifyChallenge=false：不验证直接应答（由审批服务负责拒绝）', async () => {
    const challenge: ChallengeView = {
      challengeId: 'vc-4',
      channel: 'sms',
      verify: async () => {
        throw new Error('不该被调用')
      },
    }
    const responder = createHeadlessResponder({ verifyChallenge: false })
    const { view, answers } = makeView(challenge)
    responder.attach(view)
    expect(answers).toEqual([{ decision: 'allowed-once' }])
  })

  it('delayMs：经注入定时器延后应答（可被更快的渠道抢先）', () => {
    const timer = manualTimer()
    const responder = createHeadlessResponder({ delayMs: 50, timer: timer.timer })
    const { view, answers } = makeView()
    responder.attach(view)
    expect(timer.scheduled()[0]?.delayMs).toBe(50)
    expect(answers).toHaveLength(0)
    timer.fire()
    expect(answers).toEqual([{ decision: 'allowed-once' }])
  })

  it('不认领窗口票据（ADR-0010：不许夹具替窗口签字）', () => {
    const responder = createHeadlessResponder()
    const windowTicket = {
      authorization: { kind: 'window', ref: 'w-1', digest: 'd-1' },
    } as const
    const humanTicket = {
      authorization: { kind: 'human', ref: 'u-1', digest: 'd-1' },
    } as const
    expect(responder.accepts?.(windowTicket as never)).toBe(false)
    expect(responder.accepts?.(humanTicket as never)).toBe(true)
    // 没有 authorization 的历史票据照常认领（老日志零改动）
    expect(responder.accepts?.({} as never)).toBe(true)
  })
})
