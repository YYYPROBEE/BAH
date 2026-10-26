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

describe('W09 强验证出口（锁定 / 隔离 / 重启）', () => {
  /** 永远失败的 Provider（不依赖 mock 的 successAfter 语义）。 */
  const alwaysFail: VerifyProvider = { verify: async () => ({ success: false }) }

  it('TC-W09-01：连续 3 次失败 → 锁 30 分钟，第 4 次直接 verify-locked', async () => {
    const clock = { now: 1_000_000 }
    const verify = new VerifyService({
      provider: alwaysFail,
      maxAttempts: 3,
      lockMs: 30 * 60_000,
      now: () => clock.now,
    })
    const challenge = verify.issue(sessionId, 'face')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const submitted = await verify.submit(sessionId, challenge.id, 'face')
      expect(submitted.result.attempts).toBe(attempt)
    }
    expect(verify.isLocked(sessionId)).toBe(true)
    expect(verify.lockedUntil(sessionId)).toBe(clock.now + 30 * 60_000)

    const next = verify.issue(sessionId, 'face')
    await expect(verify.submit(sessionId, next.id, 'face')).rejects.toMatchObject({
      code: 'verify-locked',
    })

    // 30 分钟到期自动解锁（不需要人工重置）
    clock.now += 30 * 60_000 + 1
    expect(verify.isLocked(sessionId)).toBe(false)
  })

  it('TC-W09-07：锁定按会话隔离——A 被锁后 B 的强验证仍可用', async () => {
    const a = asSessionId('s-verify-a')
    const b = asSessionId('s-verify-b')
    const clock = { now: 2_000_000 }
    const verify = new VerifyService({
      provider: alwaysFail,
      maxAttempts: 1,
      lockMs: 30 * 60_000,
      now: () => clock.now,
    })
    const challengeA = verify.issue(a, 'sms')
    await verify.submit(a, challengeA.id, 'sms')
    expect(verify.isLocked(a)).toBe(true)

    const passing = new VerifyService({ now: () => clock.now })
    const challengeB = passing.issue(b, 'sms')
    await expect(passing.submit(b, challengeB.id, 'sms')).resolves.toMatchObject({
      result: { success: true },
    })
    expect(passing.isLocked(b)).toBe(false)
  })

  it('TC-W09-09：新建 VerifyService（进程内重启）后锁定归零——已知限制，不是持久化', async () => {
    const clock = { now: 3_000_000 }
    const first = new VerifyService({
      provider: alwaysFail,
      maxAttempts: 1,
      lockMs: 30 * 60_000,
      now: () => clock.now,
    })
    const challenge = first.issue(sessionId, 'ushield')
    await first.submit(sessionId, challenge.id, 'ushield')
    expect(first.isLocked(sessionId)).toBe(true)

    const restarted = new VerifyService({ now: () => clock.now })
    expect(restarted.isLocked(sessionId)).toBe(false)
    const fresh = restarted.issue(sessionId, 'ushield')
    await expect(restarted.submit(sessionId, fresh.id, 'ushield')).resolves.toMatchObject({
      result: { success: true },
    })
  })
})

