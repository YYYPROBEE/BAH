/**
 * 窗口代签应答者（ADR-0010）。
 *
 * 这组用例钉的是**沉默**，不是"拒绝"：
 * 失败路径一律不许调 `view.answer()`——它一旦答了（哪怕是 reject），
 * 就把本该由人处理的票据抢答死掉（审批服务是先到者胜出）。
 *
 * 第二条主线是"认领"：只认 `authorization.kind === 'window'` 的票据，
 * 这样普通票据仍然是"无人应答 → 立即拒绝"，不会退化成等满 TTL。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId } from '@bah/test-support'

import { ApprovalService } from './service.ts'
import type { ApprovalAnswer, ApprovalInputLike, ApprovalView } from './types.ts'
import {
  WINDOW_RESPONDER_ID,
  createWindowResponder,
  levelOf,
  type WindowSignGrant,
  type WindowSignRequest,
} from './window-responder.ts'

const WINDOW_AUTH = { kind: 'window', ref: 'w-1', digest: 'd-1' } as const

/** 假视图：记录 `answer()` 的调用（没调用 = 沉默）。 */
function fakeView(overrides: Partial<ApprovalView> = {}): {
  readonly view: ApprovalView
  readonly answers: ApprovalAnswer[]
} {
  const answers: ApprovalAnswer[] = []
  const view: ApprovalView = {
    ticketId: 'ticket:c1',
    sessionId: asSessionId('s-window'),
    callId: 'c1',
    name: 'transfer_create',
    summary: { title: '执行 transfer_create', amount: 800, tier: 'yellow' },
    authorization: WINDOW_AUTH,
    signal: new AbortController().signal,
    answer: (reply) => {
      answers.push(reply)
      return { accepted: true }
    },
    ...overrides,
  }
  return { view, answers }
}

/** 核验端口替身：记录收到的请求，返回预设结论。 */
function verifier(grant: WindowSignGrant | Error): {
  readonly requests: WindowSignRequest[]
  readonly verifyWindow: (request: WindowSignRequest) => WindowSignGrant
} {
  const requests: WindowSignRequest[] = []
  return {
    requests,
    verifyWindow: (request) => {
      requests.push(request)
      if (grant instanceof Error) throw grant
      return grant
    },
  }
}

describe('createWindowResponder：只在该答的时候答', () => {
  it('窗口票据 + 核验放行 → allowed-once / window-authorized，且 by 就是渠道 id', async () => {
    const { view, answers } = fakeView()
    const deps = verifier({ ok: true, windowId: 'w-1' })
    const responder = createWindowResponder({ verifyWindow: deps.verifyWindow })

    await responder.attach(view)

    expect(answers).toEqual([{ decision: 'allowed-once', reason: 'window-authorized' }])
    expect(responder.id).toBe(WINDOW_RESPONDER_ID)
    // 核验请求带的是"票据自证的那一份"，不是页面传来的别的东西
    expect(deps.requests).toHaveLength(1)
    expect(deps.requests[0]).toMatchObject({
      ticketId: 'ticket:c1',
      callId: 'c1',
      name: 'transfer_create',
      level: 'yellow',
      amountYuan: 800,
      authorization: WINDOW_AUTH,
    })
  })

  it('没有授权来源（人工票据）→ 不回答', async () => {
    const { view, answers } = fakeView({ authorization: undefined })
    const deps = verifier({ ok: true, windowId: 'w-1' })
    await createWindowResponder({ verifyWindow: deps.verifyWindow }).attach(view)
    expect(answers).toEqual([])
    // 连核验都不该发起（人工作票据跟窗口无关）
    expect(deps.requests).toEqual([])
  })

  it('授权来源是 human → 不回答', async () => {
    const { view, answers } = fakeView({
      authorization: { kind: 'human', ref: 'u-1', digest: 'd' },
    })
    const deps = verifier({ ok: true, windowId: 'w-1' })
    await createWindowResponder({ verifyWindow: deps.verifyWindow }).attach(view)
    expect(answers).toEqual([])
    expect(deps.requests).toEqual([])
  })

  it('核验不放行（缺标记 / 缺 ref / 超预算 / 档位不符）→ 不回答，且**不是** reject', async () => {
    for (const code of ['no-wake-mark', 'window-unknown', 'over-budget', 'tier-not-allowed']) {
      const { view, answers } = fakeView()
      const deps = verifier({ ok: false, code })
      await createWindowResponder({ verifyWindow: deps.verifyWindow }).attach(view)
      expect(answers, code).toEqual([])
    }
  })

  it('核验端口抛错 → 不回答（不把"核验不了"翻译成"用户拒绝"）', async () => {
    const { view, answers } = fakeView()
    const deps = verifier(new Error('balance probe down'))
    await createWindowResponder({ verifyWindow: deps.verifyWindow }).attach(view)
    expect(answers).toEqual([])
  })

  it('红级票据把 level 透给核验端口（红级还要看预授权）', async () => {
    const challenge = {
      challengeId: 'ch-1',
      channel: 'face' as const,
      verify: async () => ({ ok: true as const }),
    }
    const { view, answers } = fakeView({
      challenge,
      summary: { title: '执行 transfer_create', amount: 5_000, tier: 'yellow' },
    })
    const deps = verifier({ ok: true, windowId: 'w-1' })
    await createWindowResponder({ verifyWindow: deps.verifyWindow }).attach(view)
    expect(deps.requests[0]?.level).toBe('red')
    expect(answers).toHaveLength(1)
  })

  it('等核验期间票据已被别人答掉（signal aborted）→ 不再提交', async () => {
    const controller = new AbortController()
    const { view, answers } = fakeView({ signal: controller.signal })
    const responder = createWindowResponder({
      verifyWindow: async () => {
        controller.abort()
        return { ok: true, windowId: 'w-1' }
      },
    })
    await responder.attach(view)
    expect(answers).toEqual([])
  })

  it('只认领窗口票据（accepts）', () => {
    const responder = createWindowResponder({ verifyWindow: () => ({ ok: false, code: 'x' }) })
    const windowish = { authorization: WINDOW_AUTH } as ApprovalInputLike
    const humanish = { authorization: { kind: 'human', ref: 'u', digest: 'd' } } as ApprovalInputLike
    const bare = {} as ApprovalInputLike
    expect(responder.accepts?.(windowish)).toBe(true)
    expect(responder.accepts?.(humanish)).toBe(false)
    expect(responder.accepts?.(bare)).toBe(false)
  })
})

/** 手动定时器（必须能证明"没有开 120s 的等待"）。 */
function manualTimer(): { readonly set: (fn: () => void, ms: number) => () => void; count: () => number } {
  let scheduled = 0
  return {
    set: () => {
      scheduled += 1
      return () => {}
    },
    count: () => scheduled,
  }
}

/** 一条审批请求（默认窗口票据、TTL 10s）。 */
function request(overrides: Partial<ApprovalInputLike> = {}): ApprovalInputLike {
  return {
    ticket: { ticketId: 'ticket:c1', fingerprint: 'fp', amount: 800, expiresAt: 11_000 },
    callId: 'c1',
    name: 'transfer_create',
    summary: { title: '执行 transfer_create', amount: 800, tier: 'yellow' },
    authorization: WINDOW_AUTH,
    decision: { decision: 'unavailable' },
    ...overrides,
  }
}

describe('审批服务里：by 落在窗口代签上', () => {
  it('窗口票据代签成功 → allowed-once，返回体带 by=window-responder', async () => {
    const timer = manualTimer()
    const service = new ApprovalService({
      sessionId: asSessionId('s-window'),
      now: () => 1_000,
      timer,
    })
    service.attach(createWindowResponder({ verifyWindow: () => ({ ok: true, windowId: 'w-1' }) }))

    const settled = await service.handle(request(), (value) => Promise.resolve(value))

    expect(settled.decision.decision).toBe('allowed-once')
    expect(settled.by).toBe(WINDOW_RESPONDER_ID)
  })

  it('人工票据 + 只有窗口应答者 → 立即 approval-no-responder（不开定时器）', async () => {
    const timer = manualTimer()
    const calls: WindowSignRequest[] = []
    const service = new ApprovalService({
      sessionId: asSessionId('s-window'),
      now: () => 1_000,
      timer,
    })
    service.attach(
      createWindowResponder({
        verifyWindow: (req) => {
          calls.push(req)
          return { ok: true, windowId: 'w-1' }
        },
      }),
    )

    const settled = await service.handle(
      request({ authorization: undefined }),
      (value) => Promise.resolve(value),
    )

    expect(settled.decision).toMatchObject({ decision: 'unavailable', reason: 'approval-no-responder' })
    // 关键：没有进入仲裁（否则会等满 TTL）
    expect(timer.count()).toBe(0)
    expect(calls).toEqual([])
    // 人工票据不写 by（人工签署人由渠道自己记）
    expect(settled.by).toBeUndefined()
  })

  it('核验不放行 → 走超时（unavailable），不是抢答 reject', async () => {
    let fire: (() => void) | undefined
    const service = new ApprovalService({
      sessionId: asSessionId('s-window'),
      now: () => 1_000,
      timer: {
        set: (fn) => {
          fire = fn
          return () => {}
        },
      },
    })
    service.attach(createWindowResponder({ verifyWindow: () => ({ ok: false, code: 'over-budget' }) }))

    const pending = service.handle(request(), (value) => Promise.resolve(value))
    // 让 attach 的微任务跑完（核验是 async 的）
    await Promise.resolve()
    await Promise.resolve()
    expect(service.pendingCount).toBe(1)
    fire?.()
    const settled = await pending
    expect(settled.decision).toMatchObject({ decision: 'unavailable', reason: 'approval-timeout' })
  })
})

describe('levelOf：红级 ⇔ 有挑战句柄', () => {
  it('有挑战 → red；无挑战 → yellow；声明红但无挑战 → red（更严）', () => {
    const challenge = { challengeId: 'c', channel: 'sms' as const, verify: async () => ({ ok: true as const }) }
    const view = (over: Partial<ApprovalView>): ApprovalView => ({
      ticketId: 't',
      sessionId: asSessionId('s'),
      callId: 'c',
      name: 'n',
      summary: { title: 't', tier: 'yellow' },
      signal: new AbortController().signal,
      answer: () => ({ accepted: true }),
      ...over,
    })
    expect(levelOf(view({ challenge }))).toBe('red')
    expect(levelOf(view({}))).toBe('yellow')
    expect(levelOf(view({ summary: { title: 't', tier: 'red' } }))).toBe('red')
  })
})
