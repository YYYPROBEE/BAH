/**
 * 审批服务（施工单 09 §2）：T-APPR-001~004 + 竞态 + TTL 先于审批超时。
 *
 * 全部时间由 `fixedClock` 与手动 `Timer` 驱动——**不 sleep、不读真实时间**（硬约束 7）。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId } from '@bah/test-support'
import { BahError } from '@bah/util'

import { ApprovalService } from './service.ts'
import type { InteractionRecord, InteractionRecordSink } from './events.ts'
import type {
  ApprovalAnswer,
  ApprovalInputLike,
  ApprovalResponder,
  ChallengePort,
  Timer,
} from './types.ts'

/** 手动定时器：测试决定"超时何时发生"。 */
interface ManualTimer {
  readonly timer: Timer
  scheduled(): readonly { readonly delayMs: number; readonly cancelled: boolean }[]
  fire(index?: number): void
}

function manualTimer(): ManualTimer {
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
    fire(index = 0) {
      const item = items[index]
      if (item === undefined) throw new Error(`没有第 ${index} 个定时器`)
      if (!item.cancelled) item.fn()
    },
  }
}

/** 简易时钟（可推进）。 */
function clock(start = 1_000) {
  let now = start
  return {
    now: () => now,
    set(value: number) {
      now = value
    },
    advance(ms: number) {
      now += ms
    },
  }
}

/** 一条审批请求（默认黄级、票据 TTL 1000ms）。 */
function request(overrides: Partial<ApprovalInputLike> = {}): ApprovalInputLike {
  return {
    ticket: { ticketId: 'ticket:c1', fingerprint: 'fp', amount: 800, expiresAt: 2_000 },
    callId: 'c1',
    name: 'transfer_create',
    summary: { title: '执行 transfer_create', amount: 800, tier: 'yellow' },
    decision: { decision: 'unavailable' },
    ...overrides,
  }
}

/** 收集领域事件。 */
function records(): { list: InteractionRecord[]; sink: InteractionRecordSink } {
  const list: InteractionRecord[] = []
  return { list, sink: (record) => list.push(record) }
}

/** 一个只答一次且立刻应答的应答者。 */
function answerWith(id: string, answer: ApprovalAnswer): ApprovalResponder {
  return {
    id,
    attach(view) {
      view.answer(answer)
    },
  }
}

/** 一个"接单但永不回答"的应答者（用于超时）。 */
function silent(id: string): ApprovalResponder {
  return { id, attach() {} }
}

const sessionId = asSessionId('s-appr')

describe('T-APPR-001 批准', () => {
  it('应答者批准 → allowed-once；回执采纳；信号关闭；等待时长按注入时钟', async () => {
    const c = clock()
    const timer = manualTimer()
    const settled: string[] = []
    const service = new ApprovalService({
      sessionId,
      now: c.now,
      timer: timer.timer,
      onSettled: (item) => settled.push(`${item.by}:${item.decision}`),
    })
    service.attach({
      id: 'web',
      attach(view) {
        c.advance(5)
        const receipt = view.answer({ decision: 'allowed-once' })
        expect(receipt).toEqual({ accepted: true })
        expect(view.signal.aborted).toBe(false)
        void view.signal.addEventListener('abort', () => settled.push('aborted'))
      },
    })

    const result = await service.handle(request(), async (value) => value)

    expect(result.decision.decision).toBe('allowed-once')
    expect(settled).toContain('web:allowed-once')
    expect(service.pendingCount).toBe(0)
    expect(service.responderCount).toBe(1)
  })
})

describe('T-APPR-002 拒绝', () => {
  it('拒绝理由原样返回（落审计由管线负责）', async () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    service.attach(answerWith('im', { decision: 'rejected', reason: '金额不对' }))
    const result = await service.handle(request(), async (value) => value)
    expect(result.decision).toEqual({ decision: 'rejected', reason: '金额不对' })
  })

  it('取消也是可产生的真实结论（用户关掉弹窗）', async () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    service.attach(answerWith('web', { decision: 'cancelled', reason: 'user-closed' }))
    const result = await service.handle(request(), async (value) => value)
    expect(result.decision.decision).toBe('cancelled')
  })
})

describe('T-APPR-003 超时', () => {
  it('无人应答：到票据 TTL 仍无人答 → unavailable + approval-timeout（落事件）', async () => {
    const c = clock()
    const timer = manualTimer()
    const audit = records()
    const service = new ApprovalService({
      sessionId,
      now: c.now,
      timer: timer.timer,
      record: audit.sink,
    })
    service.attach(silent('web'))

    let done = false
    const pending = service.handle(request(), async (value) => value).then((value) => {
      done = true
      return value
    })
    await Promise.resolve()
    expect(done).toBe(false)
    expect(service.pendingCount).toBe(1)

    c.advance(999)
    timer.fire()
    const result = await pending
    expect(result.decision).toEqual({ decision: 'unavailable', reason: 'approval-timeout' })
    expect(audit.list.map((record) => record.type)).toEqual(['approval/timeout'])
    expect(service.pendingCount).toBe(0)
  })

  it('没有应答者：立即 unavailable（不空等 TTL）', async () => {
    const timer = manualTimer()
    const settled: string[] = []
    const service = new ApprovalService({
      sessionId,
      now: clock().now,
      timer: timer.timer,
      onSettled: (item) => settled.push(`${item.by}:${item.decision}:${item.waitedMs}`),
    })
    const result = await service.handle(request(), async (value) => value)
    expect(result.decision).toEqual({ decision: 'unavailable', reason: 'approval-no-responder' })
    expect(timer.scheduled()).toHaveLength(0)
    expect(settled).toEqual(['no-responder:unavailable:0'])
  })

  it('票据在请求到达时已过期：ticket-expired（不开定时器）', async () => {
    const c = clock()
    const timer = manualTimer()
    const service = new ApprovalService({ sessionId, now: c.now, timer: timer.timer })
    c.set(2_000)
    service.attach(silent('web'))
    const result = await service.handle(request(), async (value) => value)
    expect(result.decision).toEqual({ decision: 'unavailable', reason: 'ticket-expired' })
    expect(timer.scheduled()).toHaveLength(0)
  })

  it('TTL 先于审批超时：迟到应答不得批准，且回执是 expired', async () => {
    const c = clock()
    const timer = manualTimer()
    const service = new ApprovalService({ sessionId, now: c.now, timer: timer.timer })
    let receipt: unknown
    let viewSignal: AbortSignal | undefined
    service.attach({
      id: 'slow-im',
      attach(view) {
        viewSignal = view.signal
        // 模拟"用户点了批准，但消息到仲裁器时票据 TTL 已过"
        c.set(2_001)
        receipt = view.answer({ decision: 'allowed-once' })
      },
    })

    const result = await service.handle(request(), async (value) => value)
    expect(receipt).toEqual({ accepted: false, code: 'expired' })
    expect(result.decision).toEqual({ decision: 'unavailable', reason: 'ticket-expired' })
    expect(viewSignal?.aborted).toBe(true)
  })
})

describe('T-APPR-004 双渠道竞答', () => {
  it('先应答者胜出；后到者收到 already-decided 并落 approval/duplicate', async () => {
    const audit = records()
    const service = new ApprovalService({ sessionId, now: clock().now, record: audit.sink })
    let late: unknown
    let first: unknown
    service.attach({
      id: 'web',
      attach(view) {
        first = view.answer({ decision: 'allowed-once' })
      },
    })
    service.attach({
      id: 'im',
      attach(view) {
        late = view.answer({ decision: 'rejected', reason: '点错渠道' })
      },
    })

    const result = await service.handle(request(), async (value) => value)
    expect(result.decision.decision).toBe('allowed-once')
    expect(first).toEqual({ accepted: true })
    expect(late).toEqual({ accepted: false, code: 'already-decided' })
    const duplicate = audit.list.find((record) => record.type === 'approval/duplicate')
    expect(duplicate?.data).toMatchObject({ responder: 'im', decision: 'rejected' })
  })

  it('重复 approval/decided 不重复执行：超时后再答只落重复报警', async () => {
    const c = clock()
    const timer = manualTimer()
    const audit = records()
    const service = new ApprovalService({
      sessionId,
      now: c.now,
      timer: timer.timer,
      record: audit.sink,
    })
    let view: Parameters<ApprovalResponder['attach']>[0] | undefined
    service.attach({
      id: 'web',
      attach(next) {
        view = next
      },
    })

    const pending = service.handle(request(), async (value) => value)
    await Promise.resolve()
    timer.fire()
    const result = await pending
    expect(result.decision.decision).toBe('unavailable')

    const receipt = view?.answer({ decision: 'allowed-once' })
    expect(receipt).toEqual({ accepted: false, code: 'already-decided' })
    expect(
      audit.list.filter((record) => record.type === 'approval/duplicate'),
    ).toHaveLength(1)
  })

  it('定时器在已结算后触发是 no-op', async () => {
    const c = clock()
    const timer = manualTimer()
    const service = new ApprovalService({ sessionId, now: c.now, timer: timer.timer })
    service.attach(answerWith('web', { decision: 'allowed-once' }))

    const result = await service.handle(request(), async (value) => value)
    expect(result.decision.decision).toBe('allowed-once')
    timer.fire()
    expect(result.decision.decision).toBe('allowed-once')
  })
})

describe('归一化与默认拒绝', () => {
  it('非法结论归一化为 unavailable（回执 invalid-answer）', async () => {
    const audit = records()
    const service = new ApprovalService({ sessionId, now: clock().now, record: audit.sink })
    let receipt: unknown
    service.attach({
      id: 'bad',
      attach(view) {
        receipt = view.answer({ decision: 'maybe' } as unknown as ApprovalAnswer)
      },
    })
    const result = await service.handle(request(), async (value) => value)
    expect(receipt).toEqual({ accepted: false, code: 'invalid-answer' })
    expect(result.decision).toEqual({ decision: 'unavailable', reason: 'approval-invalid-answer' })
  })

  it('下游抛错：unavailable approval-request-failed（保留原始原因）', async () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    const result = await service.handle(request(), async () => {
      throw new BahError('boom', '下游炸了')
    })
    expect(result.decision).toEqual({
      decision: 'unavailable',
      reason: expect.stringMatching(/^approval-request-failed: .*下游炸了/),
    })
  })

  it('应答者 attach 同步抛错：unavailable approval-responder-error（保留原始原因）', async () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    service.attach({
      id: 'broken',
      attach() {
        throw new BahError('broken', '渠道不可达')
      },
    })
    const result = await service.handle(request(), async (value) => value)
    expect(result.decision).toEqual({
      decision: 'unavailable',
      reason: expect.stringMatching(/^approval-responder-error: .*渠道不可达/),
    })
  })

  it('应答者 attach 异步拒绝：同样归一化为不可用', async () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    service.attach({
      id: 'async-broken',
      async attach() {
        throw new BahError('broken', '渠道不可达')
      },
    })
    const result = await service.handle(request(), async (value) => value)
    expect(result.decision.reason).toMatch(/^approval-responder-error: .*渠道不可达/)
  })

  it('下游已裁决（allowed-once）时不再仲裁，原样返回', async () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    service.attach(silent('web'))
    const answered = request({ decision: { decision: 'allowed-once' } })
    const result = await service.handle(answered, async (value) => value)
    expect(result.decision.decision).toBe('allowed-once')
  })

  it('下游已裁决 rejected 原样返回', async () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    const answered = request({ decision: { decision: 'rejected', reason: 'x' } })
    const result = await service.handle(answered, async (value) => value)
    expect(result.decision).toEqual({ decision: 'rejected', reason: 'x' })
  })
})

describe('红级挑战链', () => {
  it('签发挑战 → 落 approval/challenge-issued → 验证通过才允许批准', async () => {
    const audit = records()
    let passed = false
    const port: ChallengePort = {
      issue: () => ({ ok: true, challengeId: 'vc-1' }),
      verify: async () => {
        passed = true
        return { ok: true }
      },
      passed: () => passed,
    }
    const service = new ApprovalService({
      sessionId,
      now: clock().now,
      challenges: port,
      record: audit.sink,
    })
    let challengeId: string | undefined
    service.attach({
      id: 'headless',
      async attach(view) {
        challengeId = view.challenge?.challengeId
        const verdict = await view.challenge?.verify()
        expect(verdict).toEqual({ ok: true })
        view.answer({ decision: 'allowed-once' })
      },
    })

    const result = await service.handle(
      request({ challenge: 'sms', summary: { title: '执行', tier: 'red' } }),
      async (value) => value,
    )

    expect(challengeId).toBe('vc-1')
    expect(result.decision.decision).toBe('allowed-once')
    const issued = audit.list.find((record) => record.type === 'approval/challenge-issued')
    expect(issued?.data).toMatchObject({ challengeId: 'vc-1', channel: 'sms' })
  })

  it('未验过就批准：拒绝（challenge-required）并落 approval/challenge-failed', async () => {
    const audit = records()
    const port: ChallengePort = {
      issue: () => ({ ok: true, challengeId: 'vc-2' }),
      verify: async () => ({ ok: false, code: 'verify-failed', reason: '未通过' }),
      passed: () => false,
    }
    const service = new ApprovalService({
      sessionId,
      now: clock().now,
      challenges: port,
      record: audit.sink,
    })
    service.attach(answerWith('web', { decision: 'allowed-once' }))

    const result = await service.handle(request({ challenge: 'sms' }), async (value) => value)
    expect(result.decision).toEqual({ decision: 'rejected', reason: 'challenge-required' })
    const failed = audit.list.find((record) => record.type === 'approval/challenge-failed')
    expect(failed?.data).toMatchObject({ challengeId: 'vc-2', code: 'challenge-required' })
  })

  it('下游同步批准但挑战未通过：同样拒绝', async () => {
    const service = new ApprovalService({
      sessionId,
      now: clock().now,
      challenges: {
        issue: () => ({ ok: true, challengeId: 'vc-3' }),
        verify: async () => ({ ok: false, code: 'verify-failed', reason: 'x' }),
        passed: () => false,
      },
    })
    const answered = request({ challenge: 'sms', decision: { decision: 'allowed-once' } })
    const result = await service.handle(answered, async (value) => value)
    expect(result.decision).toEqual({ decision: 'rejected', reason: 'challenge-required' })
  })

  it('下游同步批准且挑战已通过：放行', async () => {
    const service = new ApprovalService({
      sessionId,
      now: clock().now,
      challenges: {
        issue: () => ({ ok: true, challengeId: 'vc-4' }),
        verify: async () => ({ ok: true }),
        passed: () => true,
      },
    })
    const answered = request({ challenge: 'sms', decision: { decision: 'allowed-once' } })
    const result = await service.handle(answered, async (value) => value)
    expect(result.decision.decision).toBe('allowed-once')
  })

  it('没有挑战端口：红级 unavailable（绝不降级为黄级放行）', async () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    service.attach(answerWith('web', { decision: 'allowed-once' }))
    const result = await service.handle(request({ challenge: 'sms' }), async (value) => value)
    expect(result.decision).toEqual({
      decision: 'unavailable',
      reason: 'challenge-unavailable',
    })
  })

  it('挑战签发失败：unavailable + 签发方理由码', async () => {
    const service = new ApprovalService({
      sessionId,
      now: clock().now,
      challenges: {
        issue: () => ({ ok: false, code: 'verify-locked', reason: '锁定中' }),
        verify: async () => ({ ok: true }),
        passed: () => false,
      },
    })
    const result = await service.handle(request({ challenge: 'sms' }), async (value) => value)
    expect(result.decision).toEqual({ decision: 'unavailable', reason: 'verify-locked' })
  })
})

describe('注册与销毁', () => {
  it('重复注册同一渠道 id：fail-loud', () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    service.attach(silent('web'))
    expect(() => service.attach(silent('web'))).toThrow(/已注册/)
  })

  it('disposer 后不再参与仲裁', () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    const dispose = service.attach(silent('web'))
    expect(service.responderCount).toBe(1)
    dispose()
    expect(service.responderCount).toBe(0)
  })

  it('dispose 把在途审批归一化为 cancelled（绝不放行）', async () => {
    const timer = manualTimer()
    const settled: string[] = []
    const service = new ApprovalService({
      sessionId,
      now: clock().now,
      timer: timer.timer,
      onSettled: (item) => settled.push(`${item.by}:${item.decision}`),
    })
    service.attach(silent('web'))

    const pending = service.handle(request(), async (value) => value)
    await Promise.resolve()
    expect(service.pendingCount).toBe(1)
    service.dispose()
    const result = await pending
    expect(result.decision).toEqual({ decision: 'cancelled', reason: 'approval-cancelled' })
    expect(settled).toEqual(['dispose:cancelled'])
  })

  it('dispose 之后到达的请求立即取消，不进入仲裁', async () => {
    const settled: string[] = []
    const service = new ApprovalService({
      sessionId,
      now: clock().now,
      onSettled: (item) => settled.push(`${item.by}:${item.decision}`),
    })
    service.dispose()

    const result = await service.handle(request(), async (value) => value)
    expect(result.decision).toEqual({ decision: 'cancelled', reason: 'approval-cancelled' })
    expect(settled).toEqual(['dispose:cancelled'])
  })

  it('dispose 发生在 await next 期间：返回后立即取消，不留下孤儿 pending', async () => {
    const service = new ApprovalService({ sessionId, now: clock().now })
    let release: (() => void) | undefined
    const pending = service.handle(request(), (value) =>
      new Promise((resolve) => {
        release = () => resolve(value)
      }),
    )
    await Promise.resolve()
    service.dispose()
    release?.()
    const result = await pending
    expect(result.decision).toEqual({ decision: 'cancelled', reason: 'approval-cancelled' })
    expect(service.pendingCount).toBe(0)
  })
})
