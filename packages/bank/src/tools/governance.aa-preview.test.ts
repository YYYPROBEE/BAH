/**
 * AA 代收/结束的**票前预览**拒绝分支（B-05 / ADR-0017）。
 *
 * 治理面这里只做只读预览（`getAa`），但拒绝必须发生在签票之前：
 * 一张"不知道收谁的份额"或"组已经结束"的票据，批了就等于让用户为不存在的动作背书。
 * 判据统一两条：**错误码对**、**票据一张都没签**（`core.tickets.size === 0`）。
 */
import { describe, expect, it } from 'vitest'

import { bankIds } from '../core/model.ts'
import { createPipelineHarness } from './testing.ts'

const USER = bankIds.user('u-1')

function groupReq() {
  return {
    userId: USER,
    title: '周末聚餐',
    totalCents: 10_000,
    participants: [
      { name: '张三', shareCents: 5_000 },
      { name: '李四', shareCents: 5_000 },
    ],
  }
}

describe('aa_create 的票前预览', () => {
  it('collect / decline 缺 groupId 或缺参与人 ⇒ tool-args-invalid，且不签票', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      for (const action of ['collect', 'decline']) {
        const noGroup = await h.run('aa_create', { action, participant: '张三' })
        expect(noGroup.result.code, action).toBe('tool-args-invalid')
        const noWho = await h.run('aa_create', { action, groupId: 'aa-x' })
        expect(noWho.result.code, action).toBe('tool-args-invalid')
      }
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it('close 不给 groupId ⇒ tool-args-invalid；组不存在 ⇒ aa-unknown', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      expect((await h.run('aa_create', { action: 'close' })).result.code).toBe('tool-args-invalid')
      expect(
        (await h.run('aa_create', { action: 'close', groupId: 'aa-ghost' })).result.code,
      ).toBe('aa-unknown')
      expect(
        (
          await h.run('aa_create', {
            action: 'collect',
            groupId: 'aa-ghost',
            participant: '张三',
          })
        ).result.code,
      ).toBe('aa-unknown')
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it('组已收口 ⇒ aa-group-closed（代收与再结束各自拒绝）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const group = await h.core.createAa(groupReq())
      await h.core.closeAa({ userId: USER, groupId: group.id })

      const collect = await h.run('aa_create', {
        action: 'collect',
        groupId: group.id,
        participant: '李四',
      })
      expect(collect.result.code).toBe('aa-group-closed')

      const closeAgain = await h.run('aa_create', { action: 'close', groupId: group.id })
      expect(closeAgain.result.code).toBe('aa-group-closed')
    } finally {
      await h.dispose()
    }
  })

  it('已付参与人在 completed 组里重复代收 ⇒ aa-participant-paid（与执行期同码）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const group = await h.core.createAa(groupReq())
      await h.core.collectAa({ userId: USER, groupId: group.id, participant: 0 })
      await h.core.closeAa({ userId: USER, groupId: group.id })

      const again = await h.run('aa_create', {
        action: 'collect',
        groupId: group.id,
        participant: '张三',
      })
      expect(again.result.code).toBe('aa-participant-paid')
    } finally {
      await h.dispose()
    }
  })

  it('参与人定位四种失败各有码：序号越界 / 空 / 不存在 / 同名歧义', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const group = await h.core.createAa(groupReq())
      const ask = async (participant: string): Promise<string | undefined> =>
        (
          await h.run('aa_create', { action: 'collect', groupId: group.id, participant })
        ).result.code

      expect(await ask('9')).toBe('aa-participant-unknown')
      // 全空白的 participant 在更早的一层就被拒（读不到参数 ≠ 参与人不存在）
      expect(await ask('   ')).toBe('tool-args-invalid')
      expect(await ask('赵七')).toBe('aa-participant-unknown')

      // 同名两位 ⇒ 必须改用序号：静默取第一个等于替用户决定收谁的钱
      const twins = await h.core.createAa({
        ...groupReq(),
        participants: [
          { name: '张三', shareCents: 5_000 },
          { name: '张三', shareCents: 5_000 },
        ],
      })
      const ambiguous = await h.run('aa_create', {
        action: 'collect',
        groupId: twins.id,
        participant: '张三',
      })
      expect(ambiguous.result.code).toBe('aa-participant-ambiguous')
    } finally {
      await h.dispose()
    }
  })

  it('核心读失败 ⇒ 预览按错误码拒绝，不把异常冒到管线外', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const broken = Object.assign(h.core, {
        getAa: async () => {
          throw new Error('账本不可读')
        },
      })
      void broken
      const collect = await h.run('aa_create', {
        action: 'collect',
        groupId: 'aa-any',
        participant: '张三',
      })
      expect(collect.result.isError).toBe(true)
      const close = await h.run('aa_create', { action: 'close', groupId: 'aa-any' })
      expect(close.result.isError).toBe(true)
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })
})
