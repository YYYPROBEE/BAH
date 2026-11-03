/**
 * AA 组落账前的一致性守卫（`MockBankCore.createAa`）。
 *
 * 为什么单独钉：工具体（`tools/aa.ts`）已经先校验过一遍，所以这些分支在整链路里
 * **永远走不到**——台账上它们是黑的。但核心层才是账本的唯一属主：工具体哪天放宽
 * （比如把参与人上限改成 30、或允许自定义份额不等于总额），核心必须仍然拒绝，
 * 否则落进账本就是"份额之和 ≠ 总额"的坏账。这一组用例直接把核心当被测对象。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import { buildBankDataset, DEMO_NOW } from '../forge/index.ts'
import { MockBankCore } from './mock.ts'
import { bankIds } from './model.ts'

const USER = bankIds.user('u-1')

function setup(): MockBankCore {
  return new MockBankCore({ data: buildBankDataset({ seed: 1 }), now: () => DEMO_NOW })
}

/** 一份合法请求，用例只改自己那一处。 */
function req(
  overrides: Partial<{
    userId: ReturnType<typeof bankIds.user>
    title: string
    totalCents: number
    participants: readonly { name: string; phone?: string; shareCents: number }[]
  }> = {},
) {
  return {
    userId: USER,
    title: '周末聚餐',
    totalCents: 10_000,
    participants: [
      { name: '张三', shareCents: 5_000 },
      { name: '李四', shareCents: 5_000 },
    ],
    ...overrides,
  }
}

describe('MockBankCore.createAa 守卫', () => {
  it('未知用户 ⇒ user-unknown（不给没有主体的账本开户）', async () => {
    const core = setup()
    expect(
      (await captureRejection(() => core.createAa(req({ userId: bankIds.user('u-999') })))).code,
    ).toBe('user-unknown')
  })

  it('总额必须是正整数分：0 / 负数 / 小数 / 超过安全整数一律拒绝', async () => {
    const core = setup()
    for (const totalCents of [0, -1, 100.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const error = await captureRejection(() => core.createAa(req({ totalCents })))
      expect(error.code, `totalCents=${String(totalCents)}`).toBe('aa-invalid')
    }
  })

  it('参与人数是闭区间 2–20（核心自己数，不依赖工具层）', async () => {
    const core = setup()
    const people = (count: number, each: number) =>
      Array.from({ length: count }, (_value, index) => ({
        name: `人${String(index)}`,
        shareCents: each,
      }))

    expect((await captureRejection(() => core.createAa(req({ participants: people(1, 10_000) })))).code).toBe(
      'aa-invalid',
    )
    expect(
      (
        await captureRejection(() =>
          core.createAa(req({ totalCents: 21_000, participants: people(21, 1_000) })),
        )
      ).code,
    ).toBe('aa-invalid')
    // 边界取等号：恰好 2 人与恰好 20 人都合法
    await expect(core.createAa(req({ participants: people(2, 5_000) }))).resolves.toBeDefined()
    await expect(
      core.createAa(req({ totalCents: 20_000, participants: people(20, 1_000) })),
    ).resolves.toBeDefined()
  })

  it('份额必须是正整数分，姓名不得为空白', async () => {
    const core = setup()
    expect(
      (
        await captureRejection(() =>
          core.createAa(
            req({
              participants: [
                { name: '张三', shareCents: 0 },
                { name: '李四', shareCents: 10_000 },
              ],
            }),
          ),
        )
      ).detail,
    ).toMatchObject({ index: 0, shareCents: 0 })

    expect(
      (
        await captureRejection(() =>
          core.createAa(
            req({
              participants: [
                { name: '   ', shareCents: 5_000 },
                { name: '李四', shareCents: 5_000 },
              ],
            }),
          ),
        )
      ).detail,
    ).toMatchObject({ index: 0 })
  })

  it('份额之和必须等于总额：多一分少一分都拒绝（防"均分除不尽"被静默抹掉）', async () => {
    const core = setup()
    const short = await captureRejection(() =>
      core.createAa(
        req({
          participants: [
            { name: '张三', shareCents: 6_000 },
            { name: '李四', shareCents: 3_000 },
          ],
        }),
      ),
    )
    expect(short.code).toBe('aa-invalid')
    expect(short.detail).toMatchObject({ totalCents: 10_000, sumCents: 9_000 })

    // 恰好等号才放行
    await expect(
      core.createAa(
        req({
          participants: [
            { name: '张三', shareCents: 3_334 },
            { name: '李四', shareCents: 3_333 },
            { name: '王五', shareCents: 3_333 },
          ],
        }),
      ),
    ).resolves.toMatchObject({ totalCents: 10_000, status: 'collecting' })
  })

  it('落账初始态：全员 pending、组 collecting、createdAt 取注入时钟；姓名去空白', async () => {
    const core = setup()
    const group = await core.createAa(
      req({
        participants: [
          { name: '  张三  ', shareCents: 5_000, phone: '13800001111' },
          { name: '李四', shareCents: 5_000 },
        ],
      }),
    )
    expect(group).toMatchObject({
      title: '周末聚餐',
      status: 'collecting',
      createdAt: DEMO_NOW,
    })
    expect(group.participants[0]?.name).toBe('张三')
    expect(group.participants[0]?.phone).toBe('13800001111')
    expect(group.participants.every((participant) => participant.status === 'pending')).toBe(true)
  })

  it('getAa 只按 (组 ID, 用户) 双键命中；改返回值不污染账本', async () => {
    const core = setup()
    const group = await core.createAa(req())
    expect(await core.getAa(USER, group.id)).toEqual(group)

    const readable = await core.getAa(USER, group.id)
    const mutable = readable?.participants[0] as unknown as { name: string }
    if (mutable !== undefined) mutable.name = '被改名'
    expect((await core.getAa(USER, group.id))?.participants[0]?.name).toBe('张三')
  })
})
