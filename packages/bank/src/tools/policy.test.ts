/**
 * W04 · `PolicyEngine` 抽象（TC-W04-06 / 07）。
 *
 * 两条断言缺一不可：
 * 1. **默认实现与 tier.ts 判决逐条全等**——抽象不能偷偷变成第二套规则；
 * 2. **注入的引擎能真的拒掉写工具，且读工具不受影响**——否则"可替换"只是空接口。
 */

import { createTestContext } from '@bah/test-support'
import { POLICY_ENGINE, findPolicyEngine, providePolicyEngine } from '@bah/runtime'
import type { PolicyEngine } from '@bah/runtime'
import { describe, expect, it } from 'vitest'

import { bankIds, yuanToCents } from '../core/index.ts'
import { createTierPolicy } from './policy.ts'
import { decide, type DecideInput, type DecideVerdict, type TierConfig } from './tier.ts'
import { createPipelineHarness, TEST_CONFIG } from './testing.ts'

/** 与治理平面同源的 TierConfig（阈值只能来自 Config）。 */
const TIER_CONFIG: TierConfig = {
  dailyTransferLimitCents: yuanToCents(TEST_CONFIG.dailyTransferLimit),
  riskyOps: TEST_CONFIG.riskyOps,
  riskyCallThreshold: TEST_CONFIG.riskyCallThreshold,
}

/** `tier.ts` 的判决 → 策略意见（用于逐条对照）。 */
function asPolicyVerdict(decision: DecideVerdict): { verdict: string; code?: string } {
  switch (decision.kind) {
    case 'allow':
      return { verdict: 'allow' }
    case 'ask':
      return { verdict: 'ask' }
    case 'deny':
      return { verdict: 'deny', code: decision.code }
  }
}

/** 全 deny：只对非绿工具生效，用来证明策略真的接在治理平面上。 */
const DENY_ALL: PolicyEngine = {
  decide: () => ({ verdict: 'deny', reason: '策略拒绝（测试）', code: 'policy-denied' }),
}

describe('TC-W04-07 默认策略与 tier.ts 逐条一致', () => {
  const CASES: readonly (readonly [string, DecideInput])[] = [
    [
      '未绑定身份 → deny no-identity',
      {
        name: 'account_balance',
        declared: 'green',
        config: TIER_CONFIG,
        state: { riskyCallsInTurn: 0, verifyLocked: false },
      },
    ],
    [
      '绿级无预检 → allow',
      {
        name: 'account_balance',
        declared: 'green',
        config: TIER_CONFIG,
        state: { userId: 'u-1', riskyCallsInTurn: 0, verifyLocked: false },
      },
    ],
    [
      '黄级 → ask',
      {
        name: 'transfer_create',
        declared: 'yellow',
        config: TIER_CONFIG,
        state: { userId: 'u-1', riskyCallsInTurn: 0, verifyLocked: false },
      },
    ],
    [
      '红级 → ask',
      {
        name: 'wealth_purchase',
        declared: 'red',
        config: TIER_CONFIG,
        state: { userId: 'u-1', riskyCallsInTurn: 0, verifyLocked: false },
      },
    ],
    [
      '红级 + 锁定 → deny verify-locked',
      {
        name: 'wealth_purchase',
        declared: 'red',
        config: TIER_CONFIG,
        state: { userId: 'u-1', riskyCallsInTurn: 0, verifyLocked: true },
      },
    ],
    [
      '组合风险超阈 → ask risky-calls',
      {
        name: 'transfer_create',
        declared: 'yellow',
        config: TIER_CONFIG,
        state: { userId: 'u-1', riskyCallsInTurn: 3, verifyLocked: false },
      },
    ],
    [
      '新收款人升红 → ask',
      {
        name: 'transfer_create',
        declared: 'yellow',
        config: TIER_CONFIG,
        state: { userId: 'u-1', riskyCallsInTurn: 0, verifyLocked: false },
        preview: {
          amountCents: 10_000,
          dailyUsedCents: 0,
          dailyLimitCents: 500_000,
          payee: { name: '韩梅梅', binding: 'new' },
        },
      },
    ],
  ]

  it('同一批输入下，两实现结论（含 code）全等', () => {
    const policy = createTierPolicy(TIER_CONFIG)
    for (const [name, input] of CASES) {
      const expected = asPolicyVerdict(decide(input))
      const actual = policy.decide(
        { ...(input.state.userId === undefined ? {} : { userId: input.state.userId }) },
        { name: input.name, declared: input.declared },
        {
          riskyCallsInTurn: input.state.riskyCallsInTurn,
          verifyLocked: input.state.verifyLocked,
          ...(input.preview === undefined ? {} : { preview: input.preview }),
        },
      )
      expect(actual.verdict, name).toBe(expected.verdict)
      if (expected.code !== undefined) expect(actual.code, name).toBe(expected.code)
    }
  })
})

describe('TC-W04-06 注入全 deny 策略', () => {
  it('写工具被拒（policy-denied），读工具不受影响', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once', policy: DENY_ALL })
    try {
      const read = await h.run('account_balance')
      expect(read.result.isError).toBe(false)

      const write = await h.run('transfer_create', {
        amount: 800,
        payee: { name: '王建国', phone: '13900002222' },
      })
      expect(write.result.isError).toBe(true)
      expect(write.result.code).toBe('policy-denied')

      // 被策略拒掉就不该走到审批：没有票据、没有审批请求
      expect(h.events().filter((event) => event.type === 'approval/asked')).toHaveLength(0)
      expect(h.events().filter((event) => String(event.type) === 'ticket/issued')).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('黄档资产处置（sub_cancel）同样被拒', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once', policy: DENY_ALL })
    try {
      const write = await h.run('sub_cancel', { subscriptionId: bankIds.subscription('s-1') })
      expect(write.result.isError).toBe(true)
      expect(write.result.code).toBe('policy-denied')
    } finally {
      await h.dispose()
    }
  })
})

describe('POLICY_ENGINE 服务（注入点）', () => {
  it('未提供时 findPolicyEngine 返回 undefined（不抛）', () => {
    const test = createTestContext()
    expect(findPolicyEngine(test.ctx)).toBeUndefined()
    void test.dispose()
  })

  it('provide 后可取回同一实例，注销后恢复 undefined', () => {
    const test = createTestContext()
    const off = providePolicyEngine(test.ctx, DENY_ALL)
    expect(test.ctx.get(POLICY_ENGINE)).toBe(DENY_ALL)
    off()
    expect(findPolicyEngine(test.ctx)).toBeUndefined()
    void test.dispose()
  })
})
