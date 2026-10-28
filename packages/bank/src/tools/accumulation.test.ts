/**
 * 施工单 09 §1.1 第 1 条（日累计）与第 5 条（组合风险）的**跨边界**证据。
 *
 * 两条唯一定义性证据：
 * - T-TIER-005：日累计跨 turn 正确（runtime 侧只是缓存，权威口径在 core 账本）；
 * - T-TIER-006：换会话不重置（新会话仍按账本累计）。
 */

import { describe, expect, it } from 'vitest'

import { createPipelineHarness, TEST_CONFIG, type PipelineHarness } from './testing.ts'

/** 王建国（demo 白名单收款人）转账。 */
function transfer(amount: number): Readonly<Record<string, unknown>> {
  return { amount, payee: { name: '王建国', phone: '13900002222' } }
}

/** 取某类会话事件的载荷。 */
function payloads(h: PipelineHarness, type: string): Record<string, unknown>[] {
  return h
    .events()
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>)
}

/** 取某类审计事件的载荷。 */
function auditPayloads(h: PipelineHarness, type: string): Record<string, unknown>[] {
  return h.audits
    .filter((record) => record.type === type)
    .map((record) => record.data as Record<string, unknown>)
}

describe('T-TIER-005 跨 turn 累计', () => {
  it('turn 2 的第二笔按账本累计（800 + 300 > 1000）→ 升红', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      h.session.append('turn/start', { turn: 1 })
      const first = await h.run('transfer_create', transfer(800))
      expect(first.result.isError).toBe(false)

      h.session.append('turn/start', { turn: 2 })
      const second = await h.run('transfer_create', transfer(300))
      expect(second.result.isError).toBe(false)

      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(2)
      expect(asked[0]?.['challenge']).toBeUndefined()
      expect(asked[1]?.['challenge']).toBe(TEST_CONFIG.redChallenge)
      expect(auditPayloads(h, 'tier/decided')[1]).toMatchObject({
        level: 'red',
        reason: 'daily-limit',
      })
    } finally {
      await h.dispose()
    }
  })
})

describe('T-TIER-006 换会话不重置', () => {
  it('新会话的第二笔仍按同一本账累计（600 + 500 > 1000）→ 升红', async () => {
    const first = createPipelineHarness({
      approval: 'allowed-once',
      sessionId: 's-account-a',
      callIdPrefix: 'a-',
    })
    const second = createPipelineHarness({
      approval: 'allowed-once',
      sessionId: 's-account-b',
      callIdPrefix: 'b-',
      core: first.core,
    })
    try {
      const one = await first.run('transfer_create', transfer(600))
      expect(one.result.isError).toBe(false)

      const two = await second.run('transfer_create', transfer(500))
      expect(two.result.isError).toBe(false)

      const asked = payloads(second, 'approval/asked')
      expect(asked).toHaveLength(1)
      expect(asked[0]?.['challenge']).toBe(TEST_CONFIG.redChallenge)
      expect(auditPayloads(second, 'tier/decided')[0]).toMatchObject({
        level: 'red',
        reason: 'daily-limit',
      })
      // 账本口径是"自然日 + 账户"，与会话无关：两笔都记在同一张卡的日累计里
      expect(first.core.tickets.size).toBe(2)
    } finally {
      await second.dispose()
      await first.dispose()
    }
  })
})

describe('T-TIER-010 组合风险超阈（治理层）', () => {
  it('同一 turn 第 4 次风险调用：reason = risky-calls；绿级不受影响', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      h.session.append('turn/start', { turn: 1 })
      for (let index = 0; index < 4; index += 1) {
        const execution = await h.run('transfer_create', transfer(100))
        expect(execution.result.isError).toBe(false)
      }

      const decided = auditPayloads(h, 'tier/decided')
      expect(decided).toHaveLength(4)
      expect(decided[3]).toMatchObject({ level: 'yellow', reason: 'risky-calls', verdict: 'ask' })

      const green = await h.run('account_balance')
      expect(green.result.isError).toBe(false)
      const last = auditPayloads(h, 'tier/decided')[4]
      expect(last).toMatchObject({ name: 'account_balance', level: 'green', verdict: 'allow' })
    } finally {
      await h.dispose()
    }
  })
})

describe('T-TIER-008 红级重试不降级（治理层）', () => {
  it('首次超时拒绝后重试：仍是红级 + 挑战，绝不变黄', async () => {
    const timedOut = createPipelineHarness({
      approval: 'unavailable',
      sessionId: 's-red-retry-1',
      callIdPrefix: 'r1-',
    })
    const retry = createPipelineHarness({
      approval: 'allowed-once',
      sessionId: 's-red-retry-2',
      callIdPrefix: 'r2-',
      core: timedOut.core,
    })
    try {
      const first = await timedOut.run('transfer_create', transfer(6_000))
      expect(first.result.isError).toBe(true)
      expect(first.result.code).toBe('approval-unavailable')
      expect(payloads(timedOut, 'approval/asked')[0]?.['challenge']).toBe(TEST_CONFIG.redChallenge)

      const second = await retry.run('transfer_create', transfer(6_000))
      expect(second.result.isError).toBe(false)
      expect(payloads(retry, 'approval/asked')[0]?.['challenge']).toBe(TEST_CONFIG.redChallenge)
      expect(auditPayloads(retry, 'tier/decided')[0]).toMatchObject({
        level: 'red',
        reason: 'daily-limit',
      })
    } finally {
      await retry.dispose()
      await timedOut.dispose()
    }
  })
})
