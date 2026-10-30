/**
 * 三级权限的**判定矩阵**（施工单 09 §1 / §1.1；入口留在本包，见施工台账 R89，台账已撤下）。
 *
 * 语义：**取高不取低**——`effectiveTier = max(声明级别, 升级规则结果)`。
 * 升级只上调、永不降级：重试、超时、渠道切换都不能把红变黄。
 *
 * 本文件是纯函数：不读 ctx、不写事件、不签发票据；装配在 `governance.ts`。
 * 输入里的 `preview` 由 bank-core 的账本导出（日累计的**权威口径**在 core），
 * `config` 只来自 Config（模型输出与用户口头声明不参与判定）。
 */

import { assertNever } from '@bah/util'

import type { ToolTierLevel } from '@bah/core'

import type { TransferPreview } from '../core/provider.ts'

/** 升级理由（审计与文案用）。 */
export type TierReason = 'declared' | 'new-payee' | 'daily-limit' | 'risky-calls'

/** 全部理由（封闭四值；策略外置 S2 的 `policy.tierReason` 按此校验，非法即引擎异常）。 */
export const TIER_REASONS: readonly TierReason[] = [
  'declared',
  'new-payee',
  'daily-limit',
  'risky-calls',
]

/** 判定结果。 */
export interface TierDecision {
  readonly level: ToolTierLevel
  readonly reason: TierReason
}

/** 判定用的阈值（**只来自 Config**）。 */
export interface TierConfig {
  /** 日累计上限（分；与票据 TTL 同源于 `bank:tools` 配置的 `dailyTransferLimit`）。 */
  readonly dailyTransferLimitCents: number
  /** 计入组合风险的工具名（下划线命名，与目录一致）。 */
  readonly riskyOps: readonly string[]
  /** 同一 turn 内允许的风险调用次数；超过后非绿调用一律 `ask`。 */
  readonly riskyCallThreshold: number
}

/** 判定用的会话状态（runtime 侧只是缓存；日累计的权威口径在 core 账本）。 */
export interface TierState {
  /** 当前会话绑定的银行用户；缺省 = 未绑定（业务工具一律 deny）。 */
  readonly userId?: string
  /** 本 turn 已发生的风险调用次数（turn 边界由装配层重置）。 */
  readonly riskyCallsInTurn: number
  /** 红色操作是否在强验证锁定期。 */
  readonly verifyLocked: boolean
}

/** 转账预检里判定需要的最小字段。 */
export type TransferPreviewLike = Pick<
  TransferPreview,
  'amountCents' | 'dailyUsedCents' | 'dailyLimitCents' | 'payee'
>

/** `decide()` 的输入。 */
export interface DecideInput {
  /** 工具名（用于组合风险计数对象匹配）。 */
  readonly name: string
  /** 工具定义处声明的级别（**下限**，不是判定结果）。 */
  readonly declared: ToolTierLevel
  readonly config: TierConfig
  readonly state: TierState
  /** 转账类的预检（非转账类缺省）。 */
  readonly preview?: TransferPreviewLike
}

/** `decide()` 的判决。 */
export type DecideVerdict =
  | { readonly kind: 'allow'; readonly level: 'green'; readonly reason: TierReason }
  | {
      readonly kind: 'ask'
      readonly level: 'yellow' | 'red'
      readonly reason: TierReason
      /** 是否必须附加强验证挑战（红级）。 */
      readonly challenge: boolean
    }
  | {
      readonly kind: 'deny'
      /** `no-identity`：未绑定会话；`verify-locked`：强验证锁定中。 */
      readonly code: 'no-identity' | 'verify-locked'
      readonly reason: string
      /** 审计用：拒绝时对应的生效级别（未绑定身份时为声明级别）。 */
      readonly level: ToolTierLevel
    }

/** 级别排序（green < yellow < red）。 */
export function tierRank(level: ToolTierLevel): number {
  switch (level) {
    case 'green':
      return 0
    case 'yellow':
      return 1
    case 'red':
      return 2
    default:
      // 构造不可达：封闭联合已穷尽（纪律 6 要求收尾）
      /* v8 ignore next */
      return assertNever(level, 'tool-tier-level')
  }
}

/** 取两者中更高的级别（同级别返回 `left`）。 */
export function higherTier(left: ToolTierLevel, right: ToolTierLevel): ToolTierLevel {
  return tierRank(right) > tierRank(left) ? right : left
}

/**
 * 转账类的升级规则（施工单 08 §3.8 / 施工单 09 §1.1 第 1、4 条）。
 *
 * - 当日累计**含本笔** > 生效上限 → 红（`daily-limit`）；
 * - 收款人未登记 / `binding = 'new'` → 红（`new-payee`，防"小额试探 + 大额收割"）；
 * - 否则保留声明级别。
 *
 * 生效上限 = `min(core 账本的卡/账户日限额, Config 的 dailyTransferLimitCents)`：
 * 数据只能把上限收紧、不能放宽 Config（阈值不可由模型/数据说服）。
 * 同时命中时理由取 `daily-limit`（金额是更强的解释），但级别都是红。
 */
export function escalateTransferTier(
  declared: ToolTierLevel,
  preview: Pick<TransferPreviewLike, 'amountCents' | 'dailyUsedCents' | 'dailyLimitCents' | 'payee'>,
  dailyLimitCents?: number,
): TierDecision {
  const limit =
    dailyLimitCents === undefined
      ? preview.dailyLimitCents
      : Math.min(preview.dailyLimitCents, dailyLimitCents)
  const overLimit = preview.dailyUsedCents + preview.amountCents > limit
  if (overLimit) {
    return { level: higherTier(declared, 'red'), reason: 'daily-limit' }
  }
  if (preview.payee.binding === 'new') {
    return { level: higherTier(declared, 'red'), reason: 'new-payee' }
  }
  return { level: declared, reason: 'declared' }
}

/** 是否必须走强验证挑战（红级）。 */
export function requiresChallenge(level: ToolTierLevel): boolean {
  return level === 'red'
}

/** 该工具是否计入组合风险（`riskyOps` 只来自 Config）。 */
export function isRiskyOp(config: Pick<TierConfig, 'riskyOps'>, name: string): boolean {
  return config.riskyOps.includes(name)
}

/**
 * 判定矩阵（施工单 09 §1 的三行表 + §1.1 的五条附加规则）。
 *
 * 判定顺序（顺序即安全边界，不可重排）：
 * 1. **未绑定身份 → deny**（绝不用"默认账户"兜底）；
 * 2. **升级**（日累计含本笔 / 新收款人）→ `effectiveTier = max(声明, 升级)`；
 * 3. **锁定中且红 → deny**（强验证三连败后红色操作全 deny）；
 * 4. **组合风险超阈 → 非绿一律 ask**；
 * 5. 绿 allow / 黄 ask / 红 ask+challenge。
 *
 * @param input 判定输入
 * @param escalation **外部升级**（策略外置 S2）：bundle 给出的级别/理由。
 *   不传 = 旧行为逐字不变（内部走 `escalateTransferTier`）。
 *   传了 = 用 `max(declared, escalation.level)`，且**跳过**内部的 `risky-calls` 理由改写
 *   （bundle 的 `RC-001` 已带 `level != "green"` 守卫处理过，双重改写会掩盖 bundle 的判据）。
 *   注意：`verify-locked` 与 `no-identity` 两条硬规则**不受** `escalation` 影响——
 *   策略永远不能把"锁定中"或"未绑定"变成放行（I4）。
 *
 * @returns 判决；**任何未知输入都不会得到 allow**（未知级别在类型上不可达）
 */
export function decide(input: DecideInput, escalation?: TierDecision): DecideVerdict {
  const { config, state } = input

  if (state.userId === undefined || state.userId.trim().length === 0) {
    return {
      kind: 'deny',
      code: 'no-identity',
      reason: '当前会话未绑定银行用户身份',
      level: input.declared,
    }
  }

  const applied: TierDecision =
    escalation !== undefined
      ? escalation
      : input.preview === undefined
        ? { level: input.declared, reason: 'declared' }
        : escalateTransferTier(input.declared, input.preview, config.dailyTransferLimitCents)
  const level = higherTier(input.declared, applied.level)
  let reason = applied.reason

  if (level === 'red' && state.verifyLocked) {
    return {
      kind: 'deny',
      code: 'verify-locked',
      reason: '强验证连续失败，红色操作已锁定，请稍后再试或联系客服',
      level,
    }
  }

  if (level === 'green') return { kind: 'allow', level, reason }

  // 组合风险：超过阈值的"后续调用"一律 ask；更具体的升级理由优先（金额/收款人更能解释风险）
  // bundle 模式下这条改写由 `RC-001` 承担（见上），这里只服务 legacy。
  const riskyOver = state.riskyCallsInTurn >= config.riskyCallThreshold
  if (escalation === undefined && riskyOver && reason === 'declared') reason = 'risky-calls'

  return { kind: 'ask', level, reason, challenge: requiresChallenge(level) }
}
