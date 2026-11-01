/**
 * 强验证工具（施工单 08 §3.12–§3.14 / 施工单 09 §6）。
 *
 * T-TOOLS-007：独立调用无挑战链 → `no-challenge`；
 * T-TOOLS-008：三连败 → 锁 30 分钟 + `verify/locked`。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import type { VerifyResult } from './dto.ts'
import { createBankHarness } from './testing.ts'
import { VerifyService, createMockVerifyProvider } from '../verify/index.ts'

/** 永远失败的 Provider（T-TOOLS-008 用）。 */
const ALWAYS_FAIL = { verify: async () => ({ success: false }) }

describe('强验证渠道', () => {
  it('T-TOOLS-007 独立调用：没有挑战 → no-challenge', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() =>
      h.call('verify_face', { challengeId: 'vc-missing' }),
    )
    expect(error.code).toBe('no-challenge')
  })

  it('T-VER-001 人脸成功：挑战通过并落 verify/face', async () => {
    const h = createBankHarness()
    const challenge = h.verify.issue(h.ctx.sessionId, 'face')
    const result = (await h.call('verify_face', { challengeId: challenge.id })) as VerifyResult

    expect(result.success).toBe(true)
    expect(result.channel).toBe('face')
    expect(result.remainingAttempts).toBe(2)
    expect(h.auditsOf('verify/face')).toHaveLength(1)
    expect(h.tools.get('verify_face')?.presentResult?.({}, result)).toMatchObject({
      kind: 'bank.verify',
    })
    const content = h.tools.get('verify_face')?.projectContent?.(result) ?? []
    expect((content[0] as { text: string }).text).toBe('verify_face 通过（第 1 次）。')
  })

  it('渠道不符：challenge-channel-mismatch', async () => {
    const h = createBankHarness()
    const challenge = h.verify.issue(h.ctx.sessionId, 'sms')
    const error = await captureRejection(() =>
      h.call('verify_face', { challengeId: challenge.id }),
    )
    expect(error.code).toBe('challenge-channel-mismatch')
  })

  it('T-VER-002 三连败：第 3 次锁 30 分钟并落 verify/locked；第 4 次直接 verify-locked', async () => {
    const clock = { now: 1_700_000_000_000 }
    const verify = new VerifyService({
      provider: ALWAYS_FAIL,
      maxAttempts: 3,
      lockMs: 30 * 60 * 1000,
      now: () => clock.now,
    })
    const h = createBankHarness({ verify })
    const challenge = verify.issue(h.ctx.sessionId, 'sms')

    const first = (await h.call('verify_sms', { challengeId: challenge.id })) as VerifyResult
    expect(first.success).toBe(false)
    expect(first.remainingAttempts).toBe(2)

    const second = (await h.call('verify_sms', { challengeId: challenge.id })) as VerifyResult
    expect(second.remainingAttempts).toBe(1)

    const third = (await h.call('verify_sms', { challengeId: challenge.id })) as VerifyResult
    expect(third.success).toBe(false)
    expect(third.lockedUntil).toBe(clock.now + 30 * 60 * 1000)
    const thirdText = (
      (h.tools.get('verify_sms')?.projectContent?.(third) ?? [])[0] as { text: string }
    ).text
    expect(thirdText).toContain('剩余 0 次')
    expect(thirdText).toContain('红色操作已锁定')
    expect(h.auditsOf('verify/locked')).toHaveLength(1)
    expect(h.auditsOf('verify/locked')[0]?.channel).toBe('sms')
    expect(verify.isLocked(h.ctx.sessionId)).toBe(true)

    const fourth = await captureRejection(() =>
      h.call('verify_sms', { challengeId: challenge.id }),
    )
    expect(fourth.code).toBe('verify-locked')

    // 30 分钟后自动解锁
    clock.now += 30 * 60 * 1000
    expect(verify.isLocked(h.ctx.sessionId)).toBe(false)
  })

  it('跨会话挑战不可用（不泄露存在性）', async () => {
    const h = createBankHarness()
    const challenge = h.verify.issue('s-other' as never, 'face')
    const error = await captureRejection(() =>
      h.call('verify_face', { challengeId: challenge.id }),
    )
    expect(error.code).toBe('no-challenge')
  })

  it('已通过的挑战不能重复使用', async () => {
    const h = createBankHarness()
    const challenge = h.verify.issue(h.ctx.sessionId, 'ushield')
    await h.call('verify_ushield', { challengeId: challenge.id })
    const error = await captureRejection(() =>
      h.call('verify_ushield', { challengeId: challenge.id }),
    )
    expect(error.code).toBe('challenge-consumed')
  })

  it('默认 mock Provider：第 successAfter 次起成功', async () => {
    const provider = createMockVerifyProvider({ successAfter: 2 })
    const first = await provider.verify({ challengeId: 'x', channel: 'face', attempt: 1 })
    const second = await provider.verify({ challengeId: 'x', channel: 'face', attempt: 2 })
    expect(first.success).toBe(false)
    expect(second.success).toBe(true)
  })
})
