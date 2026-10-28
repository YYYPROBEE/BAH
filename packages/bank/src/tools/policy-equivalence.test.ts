/**
 * 穷举等价（策略外置 S2 / PE-26；04 §2）。
 *
 * **证明对象**：`policies/bank-tier/1.0.0`（外置规则）与 `tier.ts`（legacy 代码）
 * 在 04 §2.2 定义的输入域上**逐字段相等**。
 *
 * 三条纪律：
 * 1. **穷举不抽样**：960 组全部跑，不给"随机采样"留后门；
 * 2. **bundle 侧必须走真实路径**：`loadBundle` → `validateInput` → `evaluate`
 *    → 适配成 `escalation` → `decide(input, escalation)`，与生产完全同一条链；
 * 3. **失败要能定位**：断言消息里带完整输入与两侧结果，否则 960 组里看不出是哪一组。
 *
 * 未绑定身份不在 bundle 侧求值：`validateInput` 要求 `subject.userId` 非空，
 * 且治理平面在身份解析阶段就返回——bundle 根本没有机会参与。这里显式断言这条边界。
 */

import { describe, expect, it } from 'vitest'

import { loadBundle, type BankTierInput, type CompiledPolicy } from '@bah/policy'

import { BANK_TOOL_NAME_SET } from './specs.ts'
import { decide, type DecideVerdict, type TierConfig, type TierReason } from './tier.ts'

/** bundle 目录（相对仓库根；vitest 的 cwd 就是仓库根）。 */
const BUNDLE_DIR = 'policies/bank-tier/1.0.0'

/** 阈值（04 §2.2：`riskyCallThreshold = 3` 固定，用来测 0/2/3/4 的下/上/等于/超过）。 */
const RISKY_CALL_THRESHOLD = 3

/** preview 的 6 个等价类（`amount` / `dailyUsed` / `binding`）。 */
const PREVIEWS = [
  { id: 'P1', amountCents: 0, dailyUsedCents: 0, binding: 'whitelist' as const },
  { id: 'P2', amountCents: 80_000, dailyUsedCents: 0, binding: 'whitelist' as const },
  { id: 'P3', amountCents: 80_000, dailyUsedCents: 0, binding: 'new' as const },
  { id: 'P4', amountCents: 200_000, dailyUsedCents: 300_000, binding: 'whitelist' as const },
  { id: 'P5', amountCents: 200_001, dailyUsedCents: 300_000, binding: 'whitelist' as const },
  { id: 'P6', amountCents: 600_000, dailyUsedCents: 0, binding: 'new' as const },
] as const

/** core 账本限额（数据面；`min(core, config)` 的另一端）。 */
const CORE_DAILY_LIMIT_CENTS = 1_000_000

/** 无 preview 的四个工具（覆盖 risky/非 risky、转账之外的两条路径）。 */
const PLAIN_TOOLS = ['wealth_purchase', 'sub_cancel', 'card_report_lost', 'transfer_preview'] as const

const DECLARED_LEVELS = ['green', 'yellow', 'red'] as const
const CONFIG_LIMITS = [100_000, 500_000] as const
const RISKY_COUNTS = [0, 2, 3, 4] as const
const USER_IDS = ['u-1', undefined] as const

/** 编译一次（纯读 + 编译，几十毫秒；960 组共用）。 */
const compiled: CompiledPolicy = loadBundle({
  dir: BUNDLE_DIR,
  toolNames: [...BANK_TOOL_NAME_SET],
  verifyLock: true,
}).compiled

/** legacy 侧的配置（`riskyOps` 不参与 `decide()`，计数由调用方给）。 */
function legacyConfig(dailyTransferLimitCents: number): TierConfig {
  return { dailyTransferLimitCents, riskyOps: ['transfer_create', 'wealth_purchase'], riskyCallThreshold: RISKY_CALL_THRESHOLD }
}

/** 一次输入的完整描述（失败时整段打印）。 */
interface Case {
  readonly label: string
  readonly name: string
  readonly declared: (typeof DECLARED_LEVELS)[number]
  readonly userId: string | undefined
  readonly locked: boolean
  readonly risky: number
  readonly configLimit: number
  readonly previewId?: string
  readonly preview?: {
    readonly amountCents: number
    readonly dailyUsedCents: number
    readonly dailyLimitCents: number
    /** legacy 的 `TransferPreviewLike.payee` 是完整视图（姓名必填）；bundle 只取 `binding`。 */
    readonly payee: { readonly name: string; readonly binding: 'new' | 'whitelist' }
  }
}

/** legacy 侧判决（不传 escalation = 旧行为）。 */
function legacyOf(input: Case): DecideVerdict {
  return decide({
    name: input.name,
    declared: input.declared,
    config: legacyConfig(input.configLimit),
    state: {
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      riskyCallsInTurn: input.risky,
      verifyLocked: input.locked,
    },
    ...(input.preview === undefined ? {} : { preview: input.preview }),
  })
}

/** bundle 侧判决（与生产同一条链：validate → evaluate → escalation → decide）。 */
function bundleOf(input: Case, userId: string): DecideVerdict {
  const data: BankTierInput = {
    subject: { userId, sessionId: 's-equivalence' },
    action: { name: input.name, declared: input.declared },
    ...(input.preview === undefined ? {} : { preview: input.preview }),
    state: { riskyCallsInTurn: input.risky, verifyLocked: input.locked },
    limits: {
      dailyLimitCents:
        input.preview === undefined
          ? input.configLimit
          : Math.min(input.preview.dailyLimitCents, input.configLimit),
    },
    params: { riskyCallThreshold: RISKY_CALL_THRESHOLD },
  }
  const result = compiled.evaluate(compiled.validateInput(data))
  return decide(
    {
      name: input.name,
      declared: input.declared,
      config: legacyConfig(input.configLimit),
      state: { userId, riskyCallsInTurn: input.risky, verifyLocked: input.locked },
      ...(input.preview === undefined ? {} : { preview: input.preview }),
    },
    { level: result.level, reason: result.reason as TierReason },
  )
}

describe('穷举等价：bank-tier/1.0.0 vs tier.ts（04 §2.2）', () => {
  it('有 preview：3 declared × 2 userId × 2 locked × 4 risky × 6 preview × 2 config = 576 组', () => {
    let compared = 0
    let unbound = 0
    for (const declared of DECLARED_LEVELS) {
      for (const userId of USER_IDS) {
        for (const locked of [false, true]) {
          for (const risky of RISKY_COUNTS) {
            for (const preview of PREVIEWS) {
              for (const configLimit of CONFIG_LIMITS) {
                const input: Case = {
                  label: `transfer_create/${declared}/${String(userId)}/locked=${String(locked)}/risky=${String(risky)}/${preview.id}/config=${String(configLimit)}`,
                  name: 'transfer_create',
                  declared,
                  userId,
                  locked,
                  risky,
                  configLimit,
                  previewId: preview.id,
                  preview: {
                    amountCents: preview.amountCents,
                    dailyUsedCents: preview.dailyUsedCents,
                    dailyLimitCents: CORE_DAILY_LIMIT_CENTS,
                    payee: { name: '收款人', binding: preview.binding },
                  },
                }
                const legacy = legacyOf(input)
                if (userId === undefined) {
                  // 未绑定：治理平面在身份阶段就返回，bundle 不参与；legacy 必须 deny。
                  expect(legacy, input.label).toEqual({
                    kind: 'deny',
                    code: 'no-identity',
                    reason: '当前会话未绑定银行用户身份',
                    level: declared,
                  })
                  unbound += 1
                  continue
                }
                expect(bundleOf(input, userId), input.label).toEqual(legacy)
                compared += 1
              }
            }
          }
        }
      }
    }
    // 576 = 288 组（已绑定）× ... 实际比较数：3×1×2×4×6×2 = 288；未绑定 288 组只验边界
    expect(compared).toBe(288)
    expect(unbound).toBe(288)
  })

  it('无 preview：3 declared × 4 工具 × 2 userId × 2 locked × 4 risky × 2 config = 384 组', () => {
    let compared = 0
    let unbound = 0
    for (const declared of DECLARED_LEVELS) {
      for (const name of PLAIN_TOOLS) {
        for (const userId of USER_IDS) {
          for (const locked of [false, true]) {
            for (const risky of RISKY_COUNTS) {
              for (const configLimit of CONFIG_LIMITS) {
                const input: Case = {
                  label: `${name}/${declared}/${String(userId)}/locked=${String(locked)}/risky=${String(risky)}/config=${String(configLimit)}`,
                  name,
                  declared,
                  userId,
                  locked,
                  risky,
                  configLimit,
                }
                const legacy = legacyOf(input)
                if (userId === undefined) {
                  expect(legacy.kind, input.label).toBe('deny')
                  unbound += 1
                  continue
                }
                expect(bundleOf(input, userId), input.label).toEqual(legacy)
                compared += 1
              }
            }
          }
        }
      }
    }
    expect(compared).toBe(192)
    expect(unbound).toBe(192)
  })

  it('边界逐条：sum==limit 不升、sum==limit+1 升、config<core 取 config', () => {
    const base = {
      name: 'transfer_create',
      declared: 'yellow' as const,
      userId: 'u-1',
      locked: false,
      risky: 0,
      configLimit: 500_000,
    }
    // P4：sum = 500_000 = min(1_000_000, 500_000) → 不升
    const atLimit = legacyOf({
      ...base,
      label: 'at-limit',
      preview: {
        amountCents: 200_000,
        dailyUsedCents: 300_000,
        dailyLimitCents: CORE_DAILY_LIMIT_CENTS,
        payee: { name: '收款人', binding: 'whitelist' },
      },
    })
    expect(atLimit).toEqual({ kind: 'ask', level: 'yellow', reason: 'declared', challenge: false })

    // P5：sum = 500_001 → 升红
    const overLimit = legacyOf({
      ...base,
      label: 'over-limit',
      preview: {
        amountCents: 200_001,
        dailyUsedCents: 300_000,
        dailyLimitCents: CORE_DAILY_LIMIT_CENTS,
        payee: { name: '收款人', binding: 'whitelist' },
      },
    })
    expect(overLimit).toEqual({ kind: 'ask', level: 'red', reason: 'daily-limit', challenge: true })

    // config 收紧到 100_000：同样的 P4 立刻超限（min 的方向不可交换）
    const tightened = legacyOf({
      ...base,
      configLimit: 100_000,
      label: 'config-tightened',
      preview: {
        amountCents: 200_000,
        dailyUsedCents: 300_000,
        dailyLimitCents: CORE_DAILY_LIMIT_CENTS,
        payee: { name: '收款人', binding: 'whitelist' },
      },
    })
    expect(tightened).toEqual({ kind: 'ask', level: 'red', reason: 'daily-limit', challenge: true })

    // core 收紧到 100_000、config 宽松：数据只能收紧，取 core
    const coreTightened = legacyOf({
      ...base,
      configLimit: 500_000,
      label: 'core-tightened',
      preview: {
        amountCents: 200_000,
        dailyUsedCents: 300_000,
        dailyLimitCents: 100_000,
        payee: { name: '收款人', binding: 'whitelist' },
      },
    })
    expect(coreTightened).toEqual({
      kind: 'ask',
      level: 'red',
      reason: 'daily-limit',
      challenge: true,
    })
  })

  it('已声明红 + 锁定 → deny verify-locked；策略改不动这一条（I4）', () => {
    const input: Case = {
      label: 'locked-red',
      name: 'transfer_create',
      declared: 'red',
      userId: 'u-1',
      locked: true,
      risky: 0,
      configLimit: 500_000,
      preview: {
        amountCents: 80_000,
        dailyUsedCents: 0,
        dailyLimitCents: CORE_DAILY_LIMIT_CENTS,
        payee: { name: '收款人', binding: 'whitelist' },
      },
    }
    const legacy = legacyOf(input)
    expect(legacy).toEqual({
      kind: 'deny',
      code: 'verify-locked',
      reason: '强验证连续失败，红色操作已锁定，请稍后再试或联系客服',
      level: 'red',
    })
    // bundle 给出 allow（1.0.0 没有 deny 规则），但锁定仍然 deny
    expect(bundleOf(input, 'u-1')).toEqual(legacy)
  })

  it('绿级工具不升级、理由保持 declared（策略不参与）', () => {
    const input: Case = {
      label: 'green',
      name: 'transfer_preview',
      declared: 'green',
      userId: 'u-1',
      locked: false,
      risky: 4,
      configLimit: 100_000,
    }
    expect(legacyOf(input)).toEqual({ kind: 'allow', level: 'green', reason: 'declared' })
    expect(bundleOf(input, 'u-1')).toEqual(legacyOf(input))
  })
})
