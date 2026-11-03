/**
 * 窗口代签的放行规则（ADR-0010）。
 *
 * 这是本设计一里唯一"能被穷举"的地方：三档 × 三级 × 预授权 × 预算。
 * 它必须给出**确定答案**——没有"默认允许"的分支。
 */

import { describe, expect, it } from 'vitest'

import { WINDOW_AUTO_LEVEL, decideWindowSign, type WindowSignInput } from './sign.ts'
import type { AuthorizationTier } from './types.ts'

/** 一条判定输入（默认：标准档、黄级、100 元预算、没花过）。 */
function input(overrides: Partial<WindowSignInput> = {}): WindowSignInput {
  return {
    tier: 'standard',
    level: 'yellow',
    redVerified: false,
    spentCents: 0,
    amountCents: 10_000,
    budgetCents: 10_000,
    ...overrides,
  }
}

describe('WINDOW_AUTO_LEVEL：档位表就是产品决策', () => {
  it('strict 什么都不代签；standard 绿/黄；wide 才含红', () => {
    expect(WINDOW_AUTO_LEVEL.strict).toEqual([])
    expect(WINDOW_AUTO_LEVEL.standard).toEqual(['green', 'yellow'])
    expect(WINDOW_AUTO_LEVEL.wide).toEqual(['green', 'yellow', 'red'])
  })

  it('三层档 × 三级共 9 组，只有 5 组"档位允许"', () => {
    const tiers: AuthorizationTier[] = ['strict', 'standard', 'wide']
    const levels = ['green', 'yellow', 'red'] as const
    const allowed: string[] = []
    for (const tier of tiers) {
      for (const level of levels) {
        if (WINDOW_AUTO_LEVEL[tier].includes(level)) allowed.push(`${tier}:${level}`)
      }
    }
    expect(allowed).toEqual([
      'standard:green',
      'standard:yellow',
      'wide:green',
      'wide:yellow',
      'wide:red',
    ])
  })
})

describe('decideWindowSign：默认拒绝，逐条放行', () => {
  it('standard + 黄级 + 预算刚好够 → 放行', () => {
    expect(decideWindowSign(input())).toEqual({ ok: true })
  })

  it('strict：三级全部 tier-not-allowed', () => {
    for (const level of ['green', 'yellow', 'red'] as const) {
      const verdict = decideWindowSign(input({ tier: 'strict', level, redVerified: true }))
      expect(verdict).toMatchObject({ ok: false, code: 'tier-not-allowed' })
    }
  })

  it('standard + 红级：档位就不允许（跟有没有预授权无关）', () => {
    expect(decideWindowSign(input({ level: 'red', redVerified: true }))).toMatchObject({
      ok: false,
      code: 'tier-not-allowed',
    })
  })

  it('wide + 红级：没有预授权 → red-unverified；有 → 放行', () => {
    expect(decideWindowSign(input({ tier: 'wide', level: 'red' }))).toMatchObject({
      ok: false,
      code: 'red-unverified',
    })
    expect(
      decideWindowSign(input({ tier: 'wide', level: 'red', redVerified: true })),
    ).toEqual({ ok: true })
  })

  it('预算：累计 + 本笔 不得超过上限；正好等于仍放行', () => {
    expect(decideWindowSign(input({ spentCents: 1, amountCents: 10_000 }))).toMatchObject({
      ok: false,
      code: 'over-budget',
    })
    expect(decideWindowSign(input({ spentCents: 5_000, amountCents: 5_000 }))).toEqual({ ok: true })
    // 第二次同额就超了
    expect(decideWindowSign(input({ spentCents: 10_000, amountCents: 1 }))).toMatchObject({
      ok: false,
      code: 'over-budget',
    })
  })

  it('金额必须是整数分：小数 / NaN / 负数一律 amount-invalid', () => {
    expect(decideWindowSign(input({ amountCents: 1.5 }))).toMatchObject({
      ok: false,
      code: 'amount-invalid',
    })
    expect(decideWindowSign(input({ amountCents: Number.NaN }))).toMatchObject({
      ok: false,
      code: 'amount-invalid',
    })
    expect(decideWindowSign(input({ budgetCents: -1 }))).toMatchObject({
      ok: false,
      code: 'amount-invalid',
    })
    expect(decideWindowSign(input({ spentCents: -1 }))).toMatchObject({
      ok: false,
      code: 'amount-invalid',
    })
  })

  it('判定顺序：档位 → 红级 → 预算（理由码不会互相掩盖）', () => {
    // 三者同时不成立时，报的是最外层的那条（档位）
    const all = decideWindowSign(
      input({ tier: 'strict', level: 'red', spentCents: 10_000, amountCents: 1 }),
    )
    expect(all).toMatchObject({ ok: false, code: 'tier-not-allowed' })
    // 档位过了之后才是红级
    const redAndBudget = decideWindowSign(
      input({ tier: 'wide', level: 'red', spentCents: 10_000, amountCents: 1 }),
    )
    expect(redAndBudget).toMatchObject({ ok: false, code: 'red-unverified' })
  })
})
