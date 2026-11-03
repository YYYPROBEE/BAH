/**
 * T-TOOLS-002 / 003 / 004 的判定层 +  的升级规则（纯函数）。
 *
 * `tier.ts` 在覆盖率强制名单里。
 */

import { describe, expect, it } from 'vitest'

import type { TransferPreview } from '../core/provider.ts'
import {
  decide,
  escalateTransferTier,
  higherTier,
  isRiskyOp,
  requiresChallenge,
  tierRank,
  type DecideInput,
  type DecideVerdict,
  type TierConfig,
  type TierState,
} from './tier.ts'

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

describe('三级权限判定', () => {
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

/* ────────────────────────────────────────────────────────────────────────────
 *  的 T-TIER-001~010（判定矩阵 + 五条附加规则）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 判定配置（阈值只来自 Config）。 */
const CONFIG: TierConfig = {
  dailyTransferLimitCents: 500_000,
  riskyOps: ['transfer_create', 'wealth_purchase'],
  riskyCallThreshold: 3,
}

/** 已绑定身份的默认状态。 */
const STATE: TierState = { userId: 'u-1', riskyCallsInTurn: 0, verifyLocked: false }

/** 跑一次 decide（默认转账黄级，可覆写）。 */
function run(
  patch: Partial<DecideInput> = {},
  previewPatch: Partial<TransferPreview> = {},
): DecideVerdict {
  return decide({
    name: 'transfer_create',
    declared: 'yellow',
    config: CONFIG,
    state: STATE,
    preview: preview(previewPatch),
    ...patch,
  })
}

describe('T-TIER-001 绿级直行', () => {
  it('声明绿且无升级命中 → allow', () => {
    expect(
      decide({
        name: 'account_balance',
        declared: 'green',
        config: CONFIG,
        state: STATE,
      }),
    ).toEqual({ kind: 'allow', level: 'green', reason: 'declared' })
  })
})

describe('T-TIER-002 黄级 800 白名单', () => {
  it('ask + 不附挑战', () => {
    expect(run()).toEqual({ kind: 'ask', level: 'yellow', reason: 'declared', challenge: false })
  })
})

describe('T-TIER-003 恰好 = 上限', () => {
  it('已用 3000 + 本笔 2000 = 5000 → 黄（含本笔 ≤ 上限）', () => {
    expect(
      run({}, { amountCents: 200_000, dailyUsedCents: 300_000, dailyLimitCents: 500_000 }),
    ).toMatchObject({ kind: 'ask', level: 'yellow' })
  })
})

describe('T-TIER-004 超 1 元', () => {
  it('已用 3000 + 本笔 2000.01 → 红（daily-limit + 挑战）', () => {
    expect(
      run({}, { amountCents: 200_001, dailyUsedCents: 300_000, dailyLimitCents: 500_000 }),
    ).toEqual({ kind: 'ask', level: 'red', reason: 'daily-limit', challenge: true })
  })
})

describe('T-TIER-007 用户声称额度更高', () => {
  it('模型/用户塞进来的额外字段不参与判定：超限仍是红', () => {
    const polluted = {
      name: 'transfer_create',
      declared: 'yellow' as const,
      config: CONFIG,
      state: STATE,
      preview: preview({ amountCents: 600_000 }),
      // 模型输出里的"额度声明"与 args 里的字段都不该被读
      dailyTransferLimit: 9_999_999,
      amountLimit: 9_999_999,
      userClaim: '用户说上限是 5000',
    } as DecideInput
    expect(decide(polluted)).toEqual({
      kind: 'ask',
      level: 'red',
      reason: 'daily-limit',
      challenge: true,
    })
  })

  it('数据侧把日限额说得更大也没用：取 min(账本, Config)', () => {
    // 账本说 5,000,000 分（5 万元），Config 说 500,000 分（5 千元）：以 Config 收紧
    expect(
      run({}, { amountCents: 400_000, dailyUsedCents: 200_000, dailyLimitCents: 5_000_000 }),
    ).toEqual({ kind: 'ask', level: 'red', reason: 'daily-limit', challenge: true })
  })

  it('账本限额比 Config 更紧时取账本（数据只能收紧，不能放宽）', () => {
    // 账本 1,000 分（10 元），Config 500,000 分（5 千元）：生效上限 = 1,000 分
    expect(
      run({}, { amountCents: 1_001, dailyUsedCents: 0, dailyLimitCents: 1_000 }),
    ).toEqual({ kind: 'ask', level: 'red', reason: 'daily-limit', challenge: true })
    // 恰好等于账本上限：不升（严格大于才升）
    expect(
      run({}, { amountCents: 1_000, dailyUsedCents: 0, dailyLimitCents: 1_000 }),
    ).toMatchObject({ kind: 'ask', level: 'yellow', reason: 'declared' })
  })
})

describe('T-TIER-008 红级重试不降级', () => {
  it('同一输入重复判定：两次都是红（升级不可逆）', () => {
    const first = run({}, { amountCents: 600_000 })
    const second = run({}, { amountCents: 600_000 })
    expect(first).toEqual(second)
    expect(first.kind === 'ask' ? first.challenge : false).toBe(true)
  })
})

describe('T-TIER-009 新收款人', () => {
  it('100 元也升红（new-payee）', () => {
    expect(run({}, { amountCents: 10_000, payee: { name: '韩梅梅', binding: 'new' } })).toEqual({
      kind: 'ask',
      level: 'red',
      reason: 'new-payee',
      challenge: true,
    })
  })
})

describe('T-TIER-010 组合风险超阈', () => {
  it('本 turn 第 4 次风险调用：非绿一律 ask（理由 risky-calls）', () => {
    expect(run({ state: { ...STATE, riskyCallsInTurn: 3 } })).toEqual({
      kind: 'ask',
      level: 'yellow',
      reason: 'risky-calls',
      challenge: false,
    })
  })

  it('更具体的升级理由优先于 risky-calls', () => {
    expect(
      run(
        { state: { ...STATE, riskyCallsInTurn: 3 } },
        { payee: { name: '韩梅梅', binding: 'new' } },
      ),
    ).toEqual({ kind: 'ask', level: 'red', reason: 'new-payee', challenge: true })
  })

  it('绿级不受组合风险影响', () => {
    expect(
      decide({
        name: 'account_balance',
        declared: 'green',
        config: CONFIG,
        state: { ...STATE, riskyCallsInTurn: 99 },
      }),
    ).toMatchObject({ kind: 'allow' })
  })
})

describe('默认拒绝', () => {
  it('未绑定身份：deny no-identity（绝不回落到默认账户）', () => {
    expect(run({ state: { ...STATE, userId: undefined } })).toEqual({
      kind: 'deny',
      code: 'no-identity',
      reason: '当前会话未绑定银行用户身份',
      level: 'yellow',
    })
    expect(run({ state: { ...STATE, userId: '   ' } })).toMatchObject({ code: 'no-identity' })
  })

  it('强验证锁定中：红级 deny verify-locked；黄级不受影响', () => {
    expect(
      run({ state: { ...STATE, verifyLocked: true } }, { amountCents: 600_000 }),
    ).toEqual({
      kind: 'deny',
      code: 'verify-locked',
      reason: '强验证连续失败，红色操作已锁定，请稍后再试或联系客服',
      level: 'red',
    })
    expect(run({ state: { ...STATE, verifyLocked: true } })).toMatchObject({ kind: 'ask' })
  })

  it('isRiskyOp 只认 Config 里的名单', () => {
    expect(isRiskyOp(CONFIG, 'transfer_create')).toBe(true)
    expect(isRiskyOp(CONFIG, 'account_balance')).toBe(false)
  })
})
