/**
 * 强验证端口（施工单 09 §6）：审批挑战链用的 `bank:challenge` 适配器。
 *
 * 与 `verify_*` 工具走同一个 `VerifyService`，因此「审批弹窗里做的验证」和
 * 「模型直接调工具」在状态机与审计上完全同构。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId } from '@bah/test-support'

import type { BankAudit } from '../tools/events.ts'
import { VerifyService, createMockVerifyProvider } from './index.ts'
import { createBankChallengePort } from './port.ts'

/** 永远失败的 Provider。 */
const ALWAYS_FAIL = { verify: async () => ({ success: false }) }

/** 内存审计出口。 */
function auditSink(): { records: { type: string; data: unknown }[]; audit: BankAudit } {
  const records: { type: string; data: unknown }[] = []
  const audit: BankAudit = {
    append: (type, data) => {
      records.push({ type, data })
    },
  }
  return { records, audit }
}

const sessionId = asSessionId('s-port')

describe('bank:challenge 端口', () => {
  it('issue → 挑战 ID；verify 成功 → ok；passed 为真', async () => {
    const { records, audit } = auditSink()
    const verify = new VerifyService({ provider: createMockVerifyProvider(), now: () => 1_000 })
    const port = createBankChallengePort({ verify, sessionId, audit })

    const issued = port.issue('face')
    expect(issued.ok).toBe(true)
    if (!issued.ok) throw new Error('unreachable')

    expect(port.passed(issued.challengeId)).toBe(false)
    expect(await port.verify(issued.challengeId, 'face')).toEqual({ ok: true })
    expect(port.passed(issued.challengeId)).toBe(true)
    expect(records.map((record) => record.type)).toEqual(['verify/face'])
  })

  it('验证失败：结构化 verify-failed（不带异常）', async () => {
    const verify = new VerifyService({ provider: ALWAYS_FAIL, now: () => 1_000 })
    const port = createBankChallengePort({ verify, sessionId })
    const issued = port.issue('sms')
    if (!issued.ok) throw new Error('unreachable')

    const verdict = await port.verify(issued.challengeId, 'sms')
    expect(verdict).toMatchObject({ ok: false, code: 'verify-failed' })
  })

  it('三连败：锁 30 分钟，端口返回 verify-failed + lockedUntil，并落 verify/locked', async () => {
    const { records, audit } = auditSink()
    const clock = { now: 1_700_000_000_000 }
    const verify = new VerifyService({
      provider: ALWAYS_FAIL,
      maxAttempts: 3,
      lockMs: 30 * 60 * 1000,
      now: () => clock.now,
    })
    const port = createBankChallengePort({ verify, sessionId, audit })
    const issued = port.issue('ushield')
    if (!issued.ok) throw new Error('unreachable')

    await port.verify(issued.challengeId, 'ushield')
    await port.verify(issued.challengeId, 'ushield')
    const third = await port.verify(issued.challengeId, 'ushield')
    expect(third).toMatchObject({
      ok: false,
      code: 'verify-failed',
      lockedUntil: clock.now + 30 * 60 * 1000,
    })
    expect(records.some((record) => record.type === 'verify/locked')).toBe(true)
  })

  it('锁定中的第 4 次提交：verify-locked + lockedUntil（异常不外泄）', async () => {
    const verify = new VerifyService({
      provider: ALWAYS_FAIL,
      maxAttempts: 1,
      lockMs: 60_000,
      now: () => 5_000,
    })
    const port = createBankChallengePort({ verify, sessionId })
    const issued = port.issue('face')
    if (!issued.ok) throw new Error('unreachable')
    await port.verify(issued.challengeId, 'face')

    const verdict = await port.verify(issued.challengeId, 'face')
    expect(verdict).toMatchObject({ ok: false, code: 'verify-locked', lockedUntil: 65_000 })
  })

  it('TC-W09-08：失败逐次落账 + 锁定一条，事件计数与内存计数一致', async () => {
    const { records, audit } = auditSink()
    const clock = { now: 1_700_000_000_000 }
    const verify = new VerifyService({
      provider: ALWAYS_FAIL,
      maxAttempts: 3,
      lockMs: 30 * 60_000,
      now: () => clock.now,
    })
    const port = createBankChallengePort({ verify, sessionId, audit })
    const issued = port.issue('face')
    if (!issued.ok) throw new Error('unreachable')

    await port.verify(issued.challengeId, 'face')
    await port.verify(issued.challengeId, 'face')
    await port.verify(issued.challengeId, 'face')

    const attempts = records.filter((record) => record.type === 'verify/face')
    expect(attempts).toHaveLength(3)
    expect(
      attempts.map((record) => (record.data as { result: { attempts: number } }).result.attempts),
    ).toEqual([1, 2, 3])
    const locked = records.filter((record) => record.type === 'verify/locked')
    expect(locked).toHaveLength(1)
    expect(locked[0]?.data).toEqual({
      sessionId,
      channel: 'face',
      until: clock.now + 30 * 60_000,
      attempts: 3,
    })
    expect(verify.get(issued.challengeId)?.attempts).toBe(3)
    expect(verify.lockedUntil(sessionId)).toBe(clock.now + 30 * 60_000)
  })

  it('未知挑战 / 渠道不符：结构化理由码', async () => {
    const verify = new VerifyService({ provider: createMockVerifyProvider(), now: () => 1_000 })
    const port = createBankChallengePort({ verify, sessionId })
    expect(await port.verify('vc-missing', 'sms')).toMatchObject({ ok: false, code: 'no-challenge' })

    const issued = port.issue('sms')
    if (!issued.ok) throw new Error('unreachable')
    expect(await port.verify(issued.challengeId, 'face')).toMatchObject({
      ok: false,
      code: 'challenge-channel-mismatch',
    })
  })

  it('passed 对未知挑战返回 false（默认拒绝）', () => {
    const verify = new VerifyService({ now: () => 1_000 })
    const port = createBankChallengePort({ verify, sessionId })
    expect(port.passed('vc-missing')).toBe(false)
  })
})
