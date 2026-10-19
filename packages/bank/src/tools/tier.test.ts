/**
 * T-TOOLS-002 / 003 / 004 的判定层 + 施工单 09 §1 的升级规则（纯函数）。
 *
 * `tier.ts` 在覆盖率强制名单里（施工单 09 要求判定函数 100% 行覆盖）。
 */

import { describe, expect, it } from 'vitest'

import type { TransferPreview } from '../core/provider.ts'
import { escalateTransferTier, higherTier, requiresChallenge, tierRank } from './tier.ts'

/** 造一个预检结果（只填判定用得到的字段）。 */
function preview(patch: Partial<TransferPreview> = {}): TransferPreview {
  return {
    amountCents: 80_000,
    feeCents: 0,
    payee: { name: '王建国', binding: 'whitelist' },
    dailyUsedCents: 0,
    dailyLimitCents: 500_000,
    remainingCents: 500_000,
    risks: [],
    verdict: 'allow',
    ...patch,
  }
}

describe('三级权限判定（施工单 09 §1）', () => {
  it('级别排序与取高不取低', () => {
    expect(tierRank('green')).toBe(0)
    expect(tierRank('yellow')).toBe(1)
    expect(tierRank('red')).toBe(2)
    expect(higherTier('green', 'yellow')).toBe('yellow')
    expect(higherTier('yellow', 'green')).toBe('yellow')
    expect(higherTier('red', 'red')).toBe('red')
    expect(higherTier('yellow', 'red')).toBe('red')
  })

  it('T-TOOLS-002 800 元白名单收款人：维持黄级', () => {
    const decision = escalateTransferTier('yellow', preview())
    expect(decision).toEqual({ level: 'yellow', reason: 'declared' })
  })

  it('T-TOOLS-003 当日累计含本笔 > 日限额：升红（理由 daily-limit）', () => {
    const decision = escalateTransferTier(
      'yellow',
      preview({ amountCents: 600_000, dailyUsedCents: 0, dailyLimitCents: 500_000 }),
    )
    expect(decision).toEqual({ level: 'red', reason: 'daily-limit' })
  })

  it('T-TOOLS-003 恰好等于上限仍是黄级（含本笔 ≤ 上限）', () => {
    const decision = escalateTransferTier(
      'yellow',
      preview({ amountCents: 200_000, dailyUsedCents: 300_000, dailyLimitCents: 500_000 }),
    )
    expect(decision.level).toBe('yellow')
  })

  it('T-TOOLS-004 新收款人：升红（理由 new-payee），100 元也一样', () => {
    const decision = escalateTransferTier(
      'yellow',
      preview({ amountCents: 10_000, payee: { name: '韩梅梅', binding: 'new' } }),
    )
    expect(decision).toEqual({ level: 'red', reason: 'new-payee' })
  })

  it('同时命中：理由取 daily-limit，级别仍是红', () => {
    const decision = escalateTransferTier(
      'yellow',
      preview({
        amountCents: 600_000,
        dailyLimitCents: 500_000,
        payee: { name: '韩梅梅', binding: 'new' },
      }),
    )
    expect(decision).toEqual({ level: 'red', reason: 'daily-limit' })
  })

  it('声明红级不会被升级规则降级', () => {
    expect(escalateTransferTier('red', preview())).toEqual({ level: 'red', reason: 'declared' })
  })

  it('预览工具本身按绿级声明时，升级规则照样能把它抬到红', () => {
    const decision = escalateTransferTier(
      'green',
      preview({ payee: { name: '韩梅梅', binding: 'new' } }),
    )
    expect(decision.level).toBe('red')
  })

  it('只有红级需要强验证挑战', () => {
    expect(requiresChallenge('green')).toBe(false)
    expect(requiresChallenge('yellow')).toBe(false)
    expect(requiresChallenge('red')).toBe(true)
  })
})
