import { describe, expect, it } from 'vitest'

import { captureRejection, fixedClock } from '@bah/test-support'

import { bankIds } from '../core/index.ts'
import { DEMO_NOW } from '../forge/index.ts'
import type { AaGroupResult } from './dto.ts'
import { createBankHarness, createPipelineHarness } from './testing.ts'

describe('aa_create（场景 1 补齐：拆分 AA 收款）', () => {
  it('均分：余数给第一位参与人，份额之和等于总额', async () => {
    const h = createBankHarness()
    const result = (await h.call('aa_create', {
      title: '周末聚餐',
      totalYuan: 100.01,
      participants: [{ name: '张三' }, { name: '李四' }, { name: '王五' }],
    })) as AaGroupResult

    expect(result).toMatchObject({
      title: '周末聚餐',
      totalCents: 10_001,
      collectedCents: 0,
      pendingCents: 10_001,
      status: 'collecting',
    })
    expect(result.participants.map((participant) => participant.shareCents)).toEqual([
      3335, 3333, 3333,
    ])
    expect(h.auditsOf('aa/created')).toHaveLength(1)
  })

  it('自定义分摊：份额必须等于总额；status 可回读同一组', async () => {
    const h = createBankHarness()
    const created = (await h.call('aa_create', {
      title: '打车',
      totalYuan: 100,
      split: 'custom',
      participants: [
        { name: '张三', shareYuan: 60 },
        { name: '李四', shareYuan: 40 },
      ],
    })) as AaGroupResult
    expect(created.participants.map((participant) => participant.shareCents)).toEqual([6000, 4000])

    const status = (await h.call('aa_create', {
      action: 'status',
      groupId: created.groupId,
    })) as AaGroupResult
    expect(status).toEqual(created)
    expect(h.auditsOf('read/aa')).toHaveLength(1)
  })

  it('参与人不足 / 总额不足 / 份额不匹配 / 未知组：fail-loud', async () => {
    const h = createBankHarness()
    expect(
      (await captureRejection(() =>
        h.call('aa_create', { totalYuan: 10, participants: [{ name: '张三' }] }),
      )).code,
    ).toBe('aa-invalid')
    expect(
      (await captureRejection(() =>
        h.call('aa_create', {
          totalYuan: 0.01,
          participants: [{ name: '张三' }, { name: '李四' }],
        }),
      )).code,
    ).toBe('aa-invalid')
    expect(
      (await captureRejection(() =>
        h.call('aa_create', {
          totalYuan: 100,
          split: 'custom',
          participants: [
            { name: '张三', shareYuan: 60 },
            { name: '李四', shareYuan: 30 },
          ],
        }),
      )).code,
    ).toBe('aa-invalid')
    expect(
      (await captureRejection(() =>
        h.call('aa_create', {
          totalYuan: 10,
          participants: [{ name: 'x'.repeat(65) }, { name: '李四' }],
        }),
      )).code,
    ).toBe('aa-invalid')
    expect(
      (await captureRejection(() =>
        h.call('aa_create', { action: 'status', groupId: 'aa-missing' }),
      )).code,
    ).toBe('aa-unknown')
  })

  it('参与人手机号不进入结果/事件（PII 纪律）', async () => {
    const h = createBankHarness()
    const result = (await h.call('aa_create', {
      totalYuan: 20,
      participants: [
        { name: '张三', phone: '13800001111' },
        { name: '李四', phone: '13900002222' },
      ],
    })) as AaGroupResult
    expect(result.participants[0]).not.toHaveProperty('phone')
    expect(JSON.stringify(h.auditsOf('aa/created'))).not.toContain('13800001111')
  })

  it('核心层拒绝跨用户读取 AA 组', async () => {
    const h = createBankHarness()
    const created = (await h.call('aa_create', {
      totalYuan: 20,
      participants: [{ name: '张三' }, { name: '李四' }],
    })) as AaGroupResult
    expect(await h.core.getAa(bankIds.user('u-x'), created.groupId)).toBeUndefined()
  })
})

describe('aa_create 动作式的治理面（B-04 / B-05）', () => {
  /** 取某类会话事件的载荷。 */
  function payloads(
    harness: ReturnType<typeof createPipelineHarness>,
    type: string,
  ): Record<string, unknown>[] {
    return harness
      .events()
      .filter((event) => event.type === type)
      .map((event) => event.data as Record<string, unknown>)
  }

  /** 取某类领域审计事件的载荷。 */
  function auditPayloads(
    harness: ReturnType<typeof createPipelineHarness>,
    type: string,
  ): Record<string, unknown>[] {
    return harness.audits
      .filter((record) => record.type === type)
      .map((record) => record.data as Record<string, unknown>)
  }

  it('status 是绿档只读：不签第二张票，落 tier/decided green/declared 与 read/aa', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const created = (await h.run('aa_create', {
        title: '周末聚餐',
        totalYuan: 100,
        participants: [{ name: '张三' }, { name: '李四' }, { name: '王五' }],
      })).value as AaGroupResult
      // create 是写分支：签了一张票
      expect(payloads(h, 'approval/asked')).toHaveLength(1)
      expect(h.core.tickets.size).toBe(1)

      const status = await h.run('aa_create', { action: 'status', groupId: created.groupId })
      expect(status.result.isError).toBe(false)
      expect((status.value as AaGroupResult).participants).toHaveLength(3)
      // status 不追加票据、不加审批
      expect(payloads(h, 'approval/asked')).toHaveLength(1)
      const decided = auditPayloads(h, 'tier/decided')
      expect(decided[decided.length - 1]).toMatchObject({
        name: 'aa_create',
        level: 'green',
        verdict: 'allow',
        reason: 'declared',
      })
      expect(auditPayloads(h, 'read/aa')).toHaveLength(1)
      expect(auditPayloads(h, 'aa/collected')).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('collect 是写分支：签一张票，金额等于该参与人份额；落 aa/collected 并入账', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const created = (await h.run('aa_create', {
        title: '打车',
        totalYuan: 100,
        split: 'custom',
        participants: [
          { name: '张三', shareYuan: 60 },
          { name: '李四', shareYuan: 40 },
        ],
      })).value as AaGroupResult
      const accounts = await h.core.listAccounts(bankIds.user('u-1'))
      const primary = accounts[0]!
      const before = primary.balanceCents

      const collected = await h.run('aa_create', {
        action: 'collect',
        groupId: created.groupId,
        participant: '0',
      })
      expect(collected.result.isError).toBe(false)
      const after = collected.value as AaGroupResult
      expect(after.participants[0]).toMatchObject({ name: '张三', status: 'paid', shareCents: 6_000 })
      expect(after.collectedCents).toBe(6_000)
      expect(after.pendingCents).toBe(4_000)
      expect(after.status).toBe('collecting')

      // collect 也签了一张票，金额 = 60 元（该参与人份额）
      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(2)
      expect(asked[1]).toMatchObject({ name: 'aa_create', amount: 60 })
      expect(h.core.tickets.size).toBe(2)

      // 事件只放账本事实，不含姓名/手机号
      const events = auditPayloads(h, 'aa/collected')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ participantIndex: 0, collectedCents: 6_000 })
      expect(JSON.stringify(events[0])).not.toContain('张三')

      // 主账户入账 60 元
      expect((await h.core.balance(primary.id)).balanceCents).toBe(before + 6_000)
    } finally {
      await h.dispose()
    }
  })

  it('collect 的票前拒绝：组不存在 / 参与人不存在 / 已收过 —— 都不签票', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const created = (await h.run('aa_create', {
        title: 'AA',
        totalYuan: 20,
        participants: [{ name: '张三' }, { name: '李四' }],
      })).value as AaGroupResult
      expect(payloads(h, 'approval/asked')).toHaveLength(1)

      const unknownGroup = await h.run('aa_create', {
        action: 'collect',
        groupId: 'aa-missing',
        participant: '0',
      })
      expect(unknownGroup.result.isError).toBe(true)
      expect(unknownGroup.result.code).toBe('aa-unknown')
      expect(payloads(h, 'approval/asked')).toHaveLength(1)

      const unknownParticipant = await h.run('aa_create', {
        action: 'collect',
        groupId: created.groupId,
        participant: '赵六',
      })
      expect(unknownParticipant.result.code).toBe('aa-participant-unknown')

      // 手机号不是键：不匹配姓名/序号 → unknown（不泄露、不误付）
      const phoneAsKey = await h.run('aa_create', {
        action: 'collect',
        groupId: created.groupId,
        participant: '13800001111',
      })
      expect(phoneAsKey.result.code).toBe('aa-participant-unknown')
      expect(payloads(h, 'approval/asked')).toHaveLength(1)

      // 先收一次，再收同一个人：票前就拒（不签第三张票、不重复入账）
      const first = await h.run('aa_create', {
        action: 'collect',
        groupId: created.groupId,
        participant: '0',
      })
      expect(first.result.isError).toBe(false)
      expect(payloads(h, 'approval/asked')).toHaveLength(2)
      const again = await h.run('aa_create', {
        action: 'collect',
        groupId: created.groupId,
        participant: '张三',
      })
      expect(again.result.isError).toBe(true)
      expect(again.result.code).toBe('aa-participant-paid')
      expect(payloads(h, 'approval/asked')).toHaveLength(2)
    } finally {
      await h.dispose()
    }
  })

  it('组完成后重复代收：票前返回 aa-participant-paid（与 collecting 同码，不签新票）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const created = (await h.run('aa_create', {
        title: 'AA',
        totalYuan: 20,
        participants: [{ name: '张三' }, { name: '李四' }],
      })).value as AaGroupResult
      await h.run('aa_create', { action: 'collect', groupId: created.groupId, participant: '0' })
      await h.run('aa_create', { action: 'collect', groupId: created.groupId, participant: '1' })
      expect(
        (await h.core.getAa(bankIds.user('u-1'), created.groupId as never))?.status,
      ).toBe('completed')

      const askedBefore = payloads(h, 'approval/asked').length
      const again = await h.run('aa_create', {
        action: 'collect',
        groupId: created.groupId,
        participant: '0',
      })
      expect(again.result.isError).toBe(true)
      expect(again.result.code).toBe('aa-participant-paid')
      // 幂等错误不签票、不重复落 aa/collected
      expect(payloads(h, 'approval/asked')).toHaveLength(askedBefore)
      expect(auditPayloads(h, 'aa/collected')).toHaveLength(2)
    } finally {
      await h.dispose()
    }
  })

  it('过了截止时间：票前就拒 aa-group-closed，不签票、不执行', async () => {
    const clock = fixedClock({ start: DEMO_NOW, step: 10 })
    const h = createPipelineHarness({ approval: 'allowed-once', clock })
    try {
      const created = (await h.run('aa_create', {
        title: 'AA',
        totalYuan: 20,
        expiresInHours: 1,
        participants: [{ name: '张三' }, { name: '李四' }],
      })).value as AaGroupResult
      const askedBefore = payloads(h, 'approval/asked').length
      clock.advance(3_600_000 + 1)

      const late = await h.run('aa_create', {
        action: 'collect',
        groupId: created.groupId,
        participant: '0',
      })
      expect(late.result.isError).toBe(true)
      expect(late.result.code).toBe('aa-group-closed')
      expect(payloads(h, 'approval/asked')).toHaveLength(askedBefore)
      expect(auditPayloads(h, 'aa/collected')).toHaveLength(0)
      // job 未跑：状态仍是 collecting，拒绝来自时间窗口
      expect(
        (await h.core.getAa(bankIds.user('u-1'), created.groupId as never))?.status,
      ).toBe('collecting')
    } finally {
      await h.dispose()
    }
  })
})


describe('aa_create 的状态机动作（ADR-0017）', () => {
  function auditPayloads(
    harness: ReturnType<typeof createPipelineHarness>,
    type: string,
  ): Record<string, unknown>[] {
    return harness.audits
      .filter((record) => record.type === type)
      .map((record) => record.data as Record<string, unknown>)
  }

  function asked(
    harness: ReturnType<typeof createPipelineHarness>,
  ): Record<string, unknown>[] {
    return harness
      .events()
      .filter((event) => event.type === 'approval/asked')
      .map((event) => event.data as Record<string, unknown>)
  }

  it('decline 是写分支：签票（金额 0）并落 aa/participant-updated；再 collect 该人被票前拒绝', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const created = (await h.run('aa_create', {
        title: '周末聚餐',
        totalYuan: 100,
        participants: [{ name: '张三' }, { name: '李四' }, { name: '王五' }],
      })).value as AaGroupResult

      const declined = await h.run('aa_create', {
        action: 'decline',
        groupId: created.groupId,
        participant: '王五',
      })
      expect(declined.result.isError).toBe(false)
      const result = declined.value as AaGroupResult
      expect(result.participants.map((participant) => participant.status)).toEqual([
        'pending',
        'pending',
        'declined',
      ])
      expect(result.status).toBe('collecting')

      const askedNow = asked(h)
      expect(askedNow).toHaveLength(2)
      expect(askedNow[1]).toMatchObject({ name: 'aa_create', amount: 0 })

      const events = auditPayloads(h, 'aa/participant-updated')
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        groupId: created.groupId,
        participantIndex: 2,
        from: 'pending',
        to: 'declined',
        at: expect.any(Number),
      })
      expect(JSON.stringify(events[0])).not.toContain('王五')

      // 已拒绝的人不能再被代收：票前就拒，不签第三张票
      const collect = await h.run('aa_create', {
        action: 'collect',
        groupId: created.groupId,
        participant: '王五',
      })
      expect(collect.result.isError).toBe(true)
      expect(collect.result.code).toBe('aa-participant-closed')
      expect(asked(h)).toHaveLength(2)
    } finally {
      await h.dispose()
    }
  })

  it('close：剩余 pending 各落一条 expired 事件；有 paid → completed', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const created = (await h.run('aa_create', {
        title: '打车',
        totalYuan: 100,
        participants: [{ name: '张三' }, { name: '李四' }, { name: '王五' }],
      })).value as AaGroupResult
      await h.run('aa_create', {
        action: 'collect',
        groupId: created.groupId,
        participant: '张三',
      })

      const closed = await h.run('aa_create', {
        action: 'close',
        groupId: created.groupId,
      })
      expect(closed.result.isError).toBe(false)
      const result = closed.value as AaGroupResult
      expect(result.status).toBe('completed')
      expect(result.participants.map((participant) => participant.status)).toEqual([
        'paid',
        'expired',
        'expired',
      ])
      // 待收只统计 pending：expired 的份额不会再进钱
      expect(result.pendingCents).toBe(0)
      expect(result.collectedCents).toBe(3_334)

      const events = auditPayloads(h, 'aa/participant-updated')
      expect(events.map((event) => event['participantIndex'])).toEqual([1, 2])
      expect(events.every((event) => event['to'] === 'expired')).toBe(true)
    } finally {
      await h.dispose()
    }
  })

  it('expiresInHours：结果带截止时刻；0 与 169 都 fail-loud', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const created = (await h.run('aa_create', {
        title: 'AA',
        totalYuan: 20,
        expiresInHours: 1,
        participants: [{ name: '张三' }, { name: '李四' }],
      })).value as AaGroupResult
      expect(created.expiresAt).toBe(created.createdAt + 3_600_000)

      const zero = await h.run('aa_create', {
        title: 'AA',
        totalYuan: 20,
        expiresInHours: 0,
        participants: [{ name: '张三' }, { name: '李四' }],
      })
      expect(zero.result.isError).toBe(true)
      expect(zero.result.code).toBe('tool-args-invalid')

      const tooLong = await h.run('aa_create', {
        title: 'AA',
        totalYuan: 20,
        expiresInHours: 169,
        participants: [{ name: '张三' }, { name: '李四' }],
      })
      expect(tooLong.result.isError).toBe(true)
      expect(tooLong.result.code).toBe('aa-invalid')
    } finally {
      await h.dispose()
    }
  })
})
