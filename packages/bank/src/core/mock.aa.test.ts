/**
 * AA 模拟代收（B-05）的核心判定：归属 / 组状态 / 参与人定位 / 幂等 / 记账。
 *
 * 口径：**demo 模拟代收**，不是真实到账。断言只看可证伪的账本事实
 * （余额增量、流水字段、组与参与人状态、错误码），不测实现细节。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import { buildBankDataset, DEMO_NOW } from '../forge/index.ts'
import { bankIds } from './model.ts'
import { MockBankCore } from './mock.ts'
import type { AaCreateReq } from './provider.ts'

const USER = bankIds.user('u-1')

/** 可控时钟的核心（代收要断言 `paidAt`，必须是注入钟）。 */
function setup(): { readonly core: MockBankCore; readonly advance: (ms: number) => void } {
  let now = DEMO_NOW
  const core = new MockBankCore({
    data: buildBankDataset({ seed: 1 }),
    now: () => now,
  })
  return {
    core,
    advance: (ms) => {
      now += ms
    },
  }
}

/** 三人组（100 元，余数给首位）。 */
function groupReq(overrides: Partial<AaCreateReq> = {}): AaCreateReq {
  return {
    userId: USER,
    title: '周末聚餐',
    totalCents: 10_000,
    participants: [
      { name: '张三', shareCents: 3_334 },
      { name: '李四', shareCents: 3_333 },
      { name: '王五', shareCents: 3_333 },
    ],
    ...overrides,
  }
}

describe('collectAa：记账与状态收敛', () => {
  it('全部收齐 ⇒ 组 completed；主账户逐笔入账、流水带 AA 代收 memo、paidAt 用注入钟', async () => {
    const { core, advance } = setup()
    const group = await core.createAa(groupReq())
    const accounts = await core.listAccounts(USER)
    const primary = accounts[0]!
    const before = primary.balanceCents

    const first = await core.collectAa({ userId: USER, groupId: group.id, participant: 0 })
    expect(first.participantIndex).toBe(0)
    expect(first.collectedCents).toBe(3_334)
    const afterFirst = await core.getAa(USER, group.id)
    expect(afterFirst?.participants[0]).toMatchObject({ status: 'paid', paidAt: DEMO_NOW })

    advance(1_000)
    await core.collectAa({ userId: USER, groupId: group.id, participant: '李四' })
    advance(1_000)
    await core.collectAa({ userId: USER, groupId: group.id, participant: '王五' })

    const final = await core.getAa(USER, group.id)
    expect(final?.status).toBe('completed')
    expect(final?.participants.map((participant) => participant.status)).toEqual([
      'paid',
      'paid',
      'paid',
    ])
    // 余额净增 = 总额
    expect((await core.balance(primary.id)).balanceCents).toBe(before + 10_000)

    // 三条入账流水（方向 in、分类 transfer、memo 统一前缀）
    const page = await core.queryTransactions({ userId: USER, limit: 10 })
    const inflows = page.items.filter(
      (item) => item.direction === 'in' && item.counterparty.memo === 'AA 代收：周末聚餐',
    )
    expect(inflows).toHaveLength(3)
    expect(inflows.map((item) => item.amountCents).sort((a, b) => b - a)).toEqual([
      3_334, 3_333, 3_333,
    ])
    expect(inflows.every((item) => item.category === 'transfer' && item.status === 'success')).toBe(true)
  })

  it('重复代收 → aa-participant-paid（幂等错误），余额与组状态都不动', async () => {
    const { core } = setup()
    const group = await core.createAa(groupReq())
    const accounts = await core.listAccounts(USER)
    const primary = accounts[0]!

    await core.collectAa({ userId: USER, groupId: group.id, participant: '张三' })
    const balanceAfterFirst = (await core.balance(primary.id)).balanceCents
    const again = await captureRejection(() =>
      core.collectAa({ userId: USER, groupId: group.id, participant: '张三' }),
    )
    expect(again.code).toBe('aa-participant-paid')
    expect((await core.balance(primary.id)).balanceCents).toBe(balanceAfterFirst)
    expect((await core.getAa(USER, group.id))?.status).toBe('collecting')
  })

  it('组完成后重复代收 → 与 collecting 分支同码 aa-participant-paid（复审 P1-3）', async () => {
    const { core } = setup()
    const group = await core.createAa(groupReq())
    await core.collectAa({ userId: USER, groupId: group.id, participant: 0 })
    await core.collectAa({ userId: USER, groupId: group.id, participant: 1 })
    await core.collectAa({ userId: USER, groupId: group.id, participant: 2 })
    expect((await core.getAa(USER, group.id))?.status).toBe('completed')
    const accounts = await core.listAccounts(USER)
    const balanceAfterAll = (await core.balance(accounts[0]!.id)).balanceCents

    const again = await captureRejection(() =>
      core.collectAa({ userId: USER, groupId: group.id, participant: 0 }),
    )
    expect(again.code).toBe('aa-participant-paid')
    expect((await core.balance(accounts[0]!.id)).balanceCents).toBe(balanceAfterAll)
  })

  it('过了收款截止时间但 job 未跑：collect 当场拒绝，账本与组状态都不动', async () => {
    const { core, advance } = setup()
    const group = await core.createAa({ ...groupReq(), expiresInHours: 1 })
    const accounts = await core.listAccounts(USER)
    const before = (await core.balance(accounts[0]!.id)).balanceCents

    advance(3_600_000 + 1)
    const late = await captureRejection(() =>
      core.collectAa({ userId: USER, groupId: group.id, participant: 0 }),
    )
    expect(late.code).toBe('aa-group-closed')
    expect((await core.balance(accounts[0]!.id)).balanceCents).toBe(before)
    // job 没跑之前状态仍是 collecting——拒绝来自时间窗口，不是状态机被提前改写
    expect((await core.getAa(USER, group.id))?.status).toBe('collecting')
  })

  it('跨用户 / 不存在的组 → 一律 aa-unknown（不泄露他人组的存在性）', async () => {
    const { core } = setup()
    const group = await core.createAa(groupReq())
    const stolen = await captureRejection(() =>
      core.collectAa({ userId: bankIds.user('u-2'), groupId: group.id, participant: 0 }),
    )
    expect(stolen.code).toBe('aa-unknown')
    const forged = await captureRejection(() =>
      core.collectAa({ userId: USER, groupId: 'aa-missing' as typeof group.id, participant: 0 }),
    )
    expect(forged.code).toBe('aa-unknown')
  })
})

describe('collectAa：参与人定位（姓名 / 序号，不把手机号当键）', () => {
  it('姓名可定位；同名多位 → aa-participant-ambiguous；找不到 / 序号越界 → aa-participant-unknown', async () => {
    const { core } = setup()
    const group = await core.createAa(
      groupReq({
        participants: [
          { name: '张三', shareCents: 3_334 },
          { name: '张三', shareCents: 3_333 },
          { name: '王五', shareCents: 3_333 },
        ],
      }),
    )
    const ambiguous = await captureRejection(() =>
      core.collectAa({ userId: USER, groupId: group.id, participant: '张三' }),
    )
    expect(ambiguous.code).toBe('aa-participant-ambiguous')

    const unknown = await captureRejection(() =>
      core.collectAa({ userId: USER, groupId: group.id, participant: '赵六' }),
    )
    expect(unknown.code).toBe('aa-participant-unknown')

    const outOfRange = await captureRejection(() =>
      core.collectAa({ userId: USER, groupId: group.id, participant: 9 }),
    )
    expect(outOfRange.code).toBe('aa-participant-unknown')

    // 同名用序号仍然能收（序号是唯一可判别的键）
    const byIndex = await core.collectAa({ userId: USER, groupId: group.id, participant: 1 })
    expect(byIndex.participantIndex).toBe(1)
  })

  it('手机号不是键：传手机号 → aa-participant-unknown，不改账本', async () => {
    const { core } = setup()
    const group = await core.createAa(
      groupReq({
        participants: [
          { name: '张三', phone: '13800001111', shareCents: 3_334 },
          { name: '李四', shareCents: 3_333 },
          { name: '王五', shareCents: 3_333 },
        ],
      }),
    )
    const accounts = await core.listAccounts(USER)
    const before = (await core.balance(accounts[0]!.id)).balanceCents
    const byPhone = await captureRejection(() =>
      core.collectAa({ userId: USER, groupId: group.id, participant: '13800001111' }),
    )
    expect(byPhone.code).toBe('aa-participant-unknown')
    expect((await core.balance(accounts[0]!.id)).balanceCents).toBe(before)
    expect((await core.getAa(USER, group.id))?.participants[0]?.status).toBe('pending')
  })
})

describe('ADR-0017：参与人状态机与收口边界', () => {
  const HOUR = 3_600_000

  it('建组缺省 72h 截止；expiresInHours 1–168 可设，越界 fail-loud', async () => {
    const { core } = setup()
    const normal = await core.createAa(groupReq())
    expect(normal.expiresAt).toBe(DEMO_NOW + 72 * HOUR)

    const short = await core.createAa({ ...groupReq(), expiresInHours: 1 })
    expect(short.expiresAt).toBe(DEMO_NOW + HOUR)

    for (const expiresInHours of [0, -1, 169, 1.5]) {
      const error = await captureRejection(() =>
        core.createAa({ ...groupReq(), expiresInHours }),
      )
      expect(error.code).toBe('aa-invalid')
    }
  })

  it('decline：一人拒绝不散组；重复拒绝幂等（affected 为空）', async () => {
    const { core } = setup()
    const group = await core.createAa(groupReq())

    const first = await core.declineAa({ userId: USER, groupId: group.id, participant: '李四' })
    expect(first.affected).toEqual([1])
    expect(first.group.status).toBe('collecting')
    expect(first.group.participants.map((participant) => participant.status)).toEqual([
      'pending',
      'declined',
      'pending',
    ])

    const again = await core.declineAa({ userId: USER, groupId: group.id, participant: 1 })
    expect(again.affected).toEqual([])
    expect(again.group).toEqual(first.group)
  })

  it('decline 最后一位：有 paid → completed，无 paid → cancelled', async () => {
    const { core } = setup()
    const withPaid = await core.createAa(groupReq())
    await core.collectAa({ userId: USER, groupId: withPaid.id, participant: 0 })
    await core.declineAa({ userId: USER, groupId: withPaid.id, participant: 1 })
    const settled = await core.declineAa({
      userId: USER,
      groupId: withPaid.id,
      participant: 2,
    })
    expect(settled.group.status).toBe('completed')
    expect(settled.group.participants.map((participant) => participant.status)).toEqual([
      'paid',
      'declined',
      'declined',
    ])

    const noPaid = await core.createAa(groupReq())
    await core.declineAa({ userId: USER, groupId: noPaid.id, participant: 0 })
    await core.declineAa({ userId: USER, groupId: noPaid.id, participant: 1 })
    const cancelled = await core.declineAa({
      userId: USER,
      groupId: noPaid.id,
      participant: 2,
    })
    expect(cancelled.group.status).toBe('cancelled')
  })

  it('collect 已拒绝 / 已过期 → aa-participant-closed，账本与状态都不动', async () => {
    const { core } = setup()
    const group = await core.createAa(groupReq())
    await core.declineAa({ userId: USER, groupId: group.id, participant: '王五' })
    const accounts = await core.listAccounts(USER)
    const before = (await core.balance(accounts[0]!.id)).balanceCents

    const declined = await captureRejection(() =>
      core.collectAa({ userId: USER, groupId: group.id, participant: 2 }),
    )
    expect(declined.code).toBe('aa-participant-closed')

    const { core: second } = setup()
    const expiring = await second.createAa({ ...groupReq(), expiresInHours: 1 })
    await second.expireAaGroups(DEMO_NOW + HOUR + 1)
    const expired = await captureRejection(() =>
      second.collectAa({ userId: USER, groupId: expiring.id, participant: 0 }),
    )
    expect(expired.code).toBe('aa-group-closed')

    expect((await core.balance(accounts[0]!.id)).balanceCents).toBe(before)
    expect((await core.getAa(USER, group.id))?.participants[2]?.status).toBe('declined')
  })

  it('close：剩余 pending 转 expired；有 paid → completed，无 paid → cancelled', async () => {
    const { core } = setup()
    const withPaid = await core.createAa(groupReq())
    await core.collectAa({ userId: USER, groupId: withPaid.id, participant: 0 })
    const closed = await core.closeAa({ userId: USER, groupId: withPaid.id })
    expect(closed.affected).toEqual([1, 2])
    expect(closed.group.status).toBe('completed')
    expect(closed.group.participants.map((participant) => participant.status)).toEqual([
      'paid',
      'expired',
      'expired',
    ])

    const noPaid = await core.createAa(groupReq())
    const cancelled = await core.closeAa({ userId: USER, groupId: noPaid.id })
    expect(cancelled.affected).toEqual([0, 1, 2])
    expect(cancelled.group.status).toBe('cancelled')

    const again = await captureRejection(() =>
      core.closeAa({ userId: USER, groupId: noPaid.id }),
    )
    expect(again.code).toBe('aa-group-closed')
  })

  it('到期：严格大于 expiresAt 才收口，且只收口一次；组织者入账 == Σ paid 份额', async () => {
    const { core } = setup()
    const group = await core.createAa({ ...groupReq(), expiresInHours: 1 })
    const accounts = await core.listAccounts(USER)
    const before = (await core.balance(accounts[0]!.id)).balanceCents
    await core.collectAa({ userId: USER, groupId: group.id, participant: 0 })

    // 恰好等于截止时刻不算过期（"< now" 的边界是事实，写进用例）
    const atBoundary = await core.expireAaGroups(DEMO_NOW + HOUR)
    expect(atBoundary).toEqual([])
    expect((await core.getAa(USER, group.id))?.status).toBe('collecting')

    const first = await core.expireAaGroups(DEMO_NOW + HOUR + 1)
    expect(first).toHaveLength(1)
    expect(first[0]?.affected).toEqual([1, 2])
    expect(first[0]?.group.status).toBe('completed')

    // 再扫一次：组已不是 collecting，零结果（幂等来自状态机）
    expect(await core.expireAaGroups(DEMO_NOW + HOUR + 1)).toEqual([])

    const after = (await core.balance(accounts[0]!.id)).balanceCents
    expect(after - before).toBe(3_334)
  })
})
