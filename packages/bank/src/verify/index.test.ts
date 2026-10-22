/**
 * 强验证状态机的并发边界（审查 F-C1）。
 *
 * 三个不变量：
 * 1. 同一挑战同一时刻只允许一次验证在途（`challenge-busy`）；
 * 2. 失败计数基于**当前**记录递增，不会被并发快照覆盖；
 * 3. 已 `passed` 的挑战不能被后续失败提交写回 `pending`（复活）。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId } from '@bah/test-support'

import { VerifyService, type VerifyOutcome, type VerifyProvider } from './index.ts'

const sessionId = asSessionId('s-verify-race')

/** 由测试手动放行的 Provider：模拟慢渠道。 */
function deferredProvider(): {
  readonly provider: VerifyProvider
  readonly release: (outcome: VerifyOutcome) => void
  readonly started: Promise<void>
} {
  let release: ((outcome: VerifyOutcome) => void) | undefined
  let markStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const pending = new Promise<VerifyOutcome>((resolve) => {
    release = resolve
  })
  return {
    provider: {
      verify: async () => {
        markStarted?.()
        return pending
      },
    },
    release: (outcome) => release?.(outcome),
    started,
  }
}

describe('VerifyService 并发提交', () => {
  it('同一挑战的第二次并发提交被拒（challenge-busy），第一次结果不被覆盖', async () => {
    const gate = deferredProvider()
    const verify = new VerifyService({ provider: gate.provider, maxAttempts: 3, now: () => 1_000 })
    const challenge = verify.issue(sessionId, 'face')

    const first = verify.submit(sessionId, challenge.id, 'face')
    await gate.started

    await expect(verify.submit(sessionId, challenge.id, 'face')).rejects.toMatchObject({
      code: 'challenge-busy',
    })

    gate.release({ success: false })
    const failed = await first
    expect(failed.result).toMatchObject({ success: false, attempts: 1, remainingAttempts: 2 })
    expect(verify.get(challenge.id)?.attempts).toBe(1)
    expect(verify.get(challenge.id)?.status).toBe('pending')
  })

  it('并发窗口后的连续失败仍按 1/2/3 递增，第三次触发锁定', async () => {
    const verify = new VerifyService({
      provider: { verify: async () => ({ success: false }) },
      maxAttempts: 3,
      lockMs: 60_000,
      now: () => 10_000,
    })
    const challenge = verify.issue(sessionId, 'sms')

    const first = await verify.submit(sessionId, challenge.id, 'sms')
    const second = await verify.submit(sessionId, challenge.id, 'sms')
    const third = await verify.submit(sessionId, challenge.id, 'sms')

    expect(first.result.attempts).toBe(1)
    expect(second.result.attempts).toBe(2)
    expect(third.result).toMatchObject({ attempts: 3, lockedUntil: 70_000 })
    expect(third.justLocked).toBe(true)
    expect(verify.get(challenge.id)?.status).toBe('failed')
  })

  it('通过的挑战不能复活：再提交返回 challenge-consumed，状态保持 passed', async () => {
    let success = true
    const verify = new VerifyService({
      provider: { verify: async () => ({ success }) },
      maxAttempts: 3,
      now: () => 1_000,
    })
    const challenge = verify.issue(sessionId, 'face')

    await verify.submit(sessionId, challenge.id, 'face')
    expect(verify.get(challenge.id)?.status).toBe('passed')

    success = false
    await expect(verify.submit(sessionId, challenge.id, 'face')).rejects.toMatchObject({
      code: 'challenge-consumed',
    })
    expect(verify.get(challenge.id)?.status).toBe('passed')
  })
})
