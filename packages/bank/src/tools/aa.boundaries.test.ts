/**
 * `aa_create` 的入参闭集边界与**出参投影**（工具体自己那一层）。
 *
 * 与 `mock.aa-guards.test.ts` 的分工：那边钉核心的账本不变量，这里钉
 * "模型写出来的参数在落到核心之前是怎么被拦下的"，以及用户在对话里真正看到的
 * 那段文字（`projectContent`）——它是工具结果 → 消息块的唯一投影点，台账里
 * 整段没有被执行过。份额算错一分，用户在审批卡与聊天里读到的就是两个数。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import { bankIds } from '../core/index.ts'
import type { AaGroupResult } from './dto.ts'
import { createBankHarness } from './testing.ts'

/** 取出参与人文本行（投影是单条 text 块）。 */
function projectedText(result: AaGroupResult): string {
  const h = createBankHarness()
  const tool = h.tools.get('aa_create')
  if (tool === undefined) throw new Error('aa_create 未注册')
  const blocks = tool.projectContent?.(result) ?? []
  expect(blocks).toHaveLength(1)
  const block = blocks[0]
  if (block === undefined || block.type !== 'text') throw new Error('投影必须是一条文本块')
  return block.text
}

describe('aa_create 入参边界', () => {
  it('status 动作缺 groupId ⇒ tool-args-invalid（不能悄悄退化成 create）', async () => {
    const h = createBankHarness()
    expect((await captureRejection(() => h.call('aa_create', { action: 'status' }))).code).toBe(
      'tool-args-invalid',
    )
    // 拒绝必须无副作用：没有凭空多出一个 AA 组
    expect(h.auditsOf('aa/created')).toHaveLength(0)
  })

  it('总额必须大于 0；负数先被金额单位守卫拦下（两道闸的次序是事实，写进用例）', async () => {
    const h = createBankHarness()
    // 0 元：过得了单位校验（有限数字），必须被 AA 语义拒绝
    expect(
      (
        await captureRejection(() =>
          h.call('aa_create', { totalYuan: 0, participants: [{ name: '张三' }, { name: '李四' }] }),
        )
      ).code,
    ).toBe('aa-invalid')
    // 负数：`yuanToCents` 在换算处就炸，不进入 AA 分支
    expect(
      (
        await captureRejection(() =>
          h.call('aa_create', { totalYuan: -50, participants: [{ name: '张三' }, { name: '李四' }] }),
        )
      ).code,
    ).toBe('money-invalid')
  })

  it('参与人上限 20：21 人在工具体就拒，且报告真实人数', async () => {
    const h = createBankHarness()
    const crowd = Array.from({ length: 21 }, (_value, index) => ({ name: `人${String(index)}` }))
    const error = await captureRejection(() => h.call('aa_create', { totalYuan: 210, participants: crowd }))
    expect(error.code).toBe('aa-invalid')
    expect(error.detail).toMatchObject({ count: 21 })
  })

  it('参与人必须是对象：字符串与数组都按位置拒绝', async () => {
    const h = createBankHarness()
    expect(
      (
        await captureRejection(() =>
          h.call('aa_create', { totalYuan: 20, participants: ['张三', { name: '李四' }] }),
        )
      ).detail,
    ).toMatchObject({ index: 0 })
    expect(
      (
        await captureRejection(() =>
          h.call('aa_create', { totalYuan: 20, participants: [['张三'], { name: '李四' }] }),
        )
      ).code,
    ).toBe('aa-invalid')
  })

  it('姓名空白 ⇒ 按位置拒绝（不能落一个空名进账本）', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() =>
      h.call('aa_create', { totalYuan: 20, participants: [{ name: '  ' }, { name: '李四' }] }),
    )
    expect(error.code).toBe('aa-invalid')
    expect(error.detail).toMatchObject({ index: 0 })
  })

  it('custom 分摊缺份额或份额为 0 ⇒ 按位置拒绝，不落"一半自定义一半均分"的混账', async () => {
    const h = createBankHarness()
    expect(
      (
        await captureRejection(() =>
          h.call('aa_create', {
            totalYuan: 100,
            split: 'custom',
            participants: [{ name: '张三' }, { name: '李四', shareYuan: 40 }],
          })
        )
      ).detail,
    ).toMatchObject({ index: 0 })
    expect(
      (
        await captureRejection(() =>
          h.call('aa_create', {
            totalYuan: 100,
            split: 'custom',
            participants: [
              { name: '张三', shareYuan: 0 },
              { name: '李四', shareYuan: 100 },
            ],
          })
        )
      ).code,
    ).toBe('aa-invalid')
    // 份额为负同样先在单位换算处炸掉（与总额同一道闸）
    expect(
      (
        await captureRejection(() =>
          h.call('aa_create', {
            totalYuan: 100,
            split: 'custom',
            participants: [
              { name: '张三', shareYuan: -10 },
              { name: '李四', shareYuan: 110 },
            ],
          })
        )
      ).code,
    ).toBe('money-invalid')
  })

  it('标题缺省为「AA 收款」；手机号空白等同没给', async () => {
    const h = createBankHarness()
    const result = (await h.call('aa_create', {
      totalYuan: 20,
      participants: [
        { name: '张三', phone: '   ' },
        { name: '李四' },
      ],
    })) as AaGroupResult
    expect(result.title).toBe('AA 收款')
    expect(JSON.stringify(h.auditsOf('aa/created'))).not.toContain('phone')
  })
})

describe('aa_create 出参投影', () => {
  it('逐人一行：金额、已收/待收状态各自如实，标题与总额成对出现', () => {
    const text = projectedText({
      groupId: bankIds.aa('aa-1'),
      title: '周末聚餐',
      totalCents: 10_001,
      collectedCents: 3_333,
      pendingCents: 6_668,
      status: 'collecting',
      participants: [
        { name: '张三', shareCents: 3_335, status: 'pending' },
        { name: '李四', shareCents: 3_333, status: 'paid', paidAt: 1_700_000_000_000 },
        { name: '王五', shareCents: 3_333, status: 'pending' },
      ],
      createdAt: 1_699_990_000_000,
    })

    expect(text.split('\n')).toEqual([
      'AA 收款「周末聚餐」：总额 ¥100.01，已收 ¥33.33，待收 ¥66.68。',
      '- 张三：¥33.35（待收）',
      '- 李四：¥33.33（已收）',
      '- 王五：¥33.33（待收）',
    ])
  })

  it('除不尽的那一分写在首位：投影与工具真正写进账本的份额同一套算法', async () => {
    const h = createBankHarness()
    const created = (await h.call('aa_create', {
      title: '打车',
      totalYuan: 0.1,
      participants: [{ name: '张三' }, { name: '李四' }, { name: '王五' }],
    })) as AaGroupResult

    // 10 分 ÷ 3 人：3+3+4？不——余数一律给首位（4+3+3），逐分可复算
    expect(created.participants.map((participant) => participant.shareCents)).toEqual([4, 3, 3])
    const text = projectedText(created)
    expect(text).toContain('- 张三：¥0.04（待收）')
    expect(text).toContain('- 王五：¥0.03（待收）')
    expect(text.split('\n')[0]).toContain('待收 ¥0.10')
  })
})
