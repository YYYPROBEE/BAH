/**
 * `aa_create.collect` 的入参闭集（工具体那一层）。
 *
 * 为什么单独钉这两条：`collect` 是**扣参与人钱**的写分支。缺 `groupId` 时若悄悄
 * 落回 `create`，模型一句「收一下张三的」就会凭空新建一个组；缺 `participant` 时若
 * 落回「默认第一位」，用户没点名的人就被收了钱。两者都不能靠下游兜底——
 * 下游根本不知道"调用方没说"。拒绝必须发生在签票之前（`approval/asked` 不增加）。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import type { AaGroupResult } from './dto.ts'
import { createBankHarness } from './testing.ts'

describe('aa_create.collect 入参闭集', () => {
  it('缺 groupId ⇒ tool-args-invalid（不能退化成 create）', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() => h.call('aa_create', { action: 'collect' }))
    expect(error.code).toBe('tool-args-invalid')
    // 拒绝无副作用：既没建组，也没收钱
    expect(h.auditsOf('aa/created')).toHaveLength(0)
    expect(h.auditsOf('aa/collected')).toHaveLength(0)
  })

  it('有 groupId 但缺 participant ⇒ tool-args-invalid（不默认收第一位）', async () => {
    const h = createBankHarness()
    const created = (await h.call('aa_create', {
      totalYuan: 20,
      participants: [{ name: '张三' }, { name: '李四' }],
    })) as AaGroupResult

    const error = await captureRejection(() =>
      h.call('aa_create', { action: 'collect', groupId: created.groupId }),
    )
    expect(error.code).toBe('tool-args-invalid')
    // 组还在（create 发生过），但一分钱没入账
    expect(h.auditsOf('aa/created')).toHaveLength(1)
    expect(h.auditsOf('aa/collected')).toHaveLength(0)
  })
})
