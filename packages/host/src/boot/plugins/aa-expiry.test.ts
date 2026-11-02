/**
 * `aa-expire` job：到期收口的幂等与落账（ADR-0017）。
 *
 * 判据只有两条：
 * 1. 每个真正转为 `expired` 的参与人必须有一条 `aa/participant-updated`；
 * 2. 同一组无论 core 返回多少次，只落一次（job 账本 + 状态机双保险）。
 */

import { describe, expect, it } from 'vitest'

import { bankIds, type AaSettlementResult, type BankAudit } from '@bah/bank'

import { createAaExpiryJob } from './aa-expiry.ts'

const AT = 1_800_000_000_000

/** 造一个只够 job 用的收口语义结果。 */
function settlement(id: string, affected: readonly number[]): AaSettlementResult {
  return {
    group: {
      id: bankIds.aa(id),
      userId: bankIds.user('u-1'),
      title: '周末聚餐',
      totalCents: 30_000,
      participants: [
        { name: '张三', shareCents: 10_000, status: 'paid' },
        { name: '李四', shareCents: 10_000, status: 'expired' },
        { name: '王五', shareCents: 10_000, status: 'expired' },
      ],
      status: 'completed',
      createdAt: AT - 3_600_000,
      expiresAt: AT - 1,
    },
    affected,
    at: AT,
  }
}

function harness(results: readonly AaSettlementResult[]): {
  readonly events: { type: string; data: unknown }[]
  readonly job: ReturnType<typeof createAaExpiryJob>
  readonly calls: () => number
} {
  let calls = 0
  const events: { type: string; data: unknown }[] = []
  const audit: BankAudit = {
    append: (type, data) => {
      events.push({ type: String(type), data })
    },
  }
  const job = createAaExpiryJob({
    core: {
      expireAaGroups: () => {
        calls += 1
        return Promise.resolve([...results])
      },
    },
    audit,
    now: () => AT,
  })
  return { events, job, calls: () => calls }
}

describe('aa-expire job', () => {
  it('每位 expired 一条事件；载荷只有组号/序号/去向', async () => {
    const { events, job } = harness([settlement('aa-1', [1, 2])])
    await job.run()
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      type: 'aa/participant-updated',
      data: {
        groupId: 'aa-1',
        participantIndex: 1,
        from: 'pending',
        to: 'expired',
        at: AT,
      },
    })
    expect(JSON.stringify(events)).not.toContain('李四')
  })

  it('同一组第二次出现：零新事件（组级幂等账本）', async () => {
    const { events, job } = harness([settlement('aa-1', [1, 2])])
    await job.run()
    await job.run()
    expect(events).toHaveLength(2)
    expect(job.settledGroups.has('aa-1')).toBe(true)
  })

  it('core 抛错只记日志，不向 tick 抛（一条坏组不能拖垮其他 job）', async () => {
    const job = createAaExpiryJob({
      core: {
        expireAaGroups: () => Promise.reject(new Error('boom')),
      },
      audit: { append: () => {} },
      now: () => AT,
    })
    await expect(job.run()).resolves.toBeUndefined()
  })
})
