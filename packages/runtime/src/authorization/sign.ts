/**
 * 窗口代签的**放行规则表**（ADR-0010）：纯函数，无时钟、无随机、无 IO。
 *
 * 为什么规则要独立成一张表而不是散在宿主里：
 * 1. "哪一档允许自动放行哪一级"是**产品决策**，必须能被穷举测试（三条档 × 三级）；
 * 2. 宿主那侧只负责取数（世界快照、预算累计、预授权凭据），判定不许再手写一遍；
 * 3. 表是 `Record<AuthorizationTier, …>`，将来加档位会编译失败，不会静默放行。
 *
 * ## 三条硬规则（顺序即优先级）
 *
 * 1. **档位**：`strict` 什么都不代签（一律人工）；`standard` 只签绿/黄；
 *    `wide` 才允许红——**且必须带着武装时刻的强验证凭据**（`redVerified`）；
 * 2. **红级**：`redVerified === false` 时红级一律不放行（"宽档"不是"免验证"）；
 * 3. **预算**：本次 run 已代签金额 + 本次金额不得越过窗口预算（分，整数）。
 *
 * 金额一律整数分：`Number.isInteger` 不成立按不放行处理（不四舍五入、不吞 NaN）。
 */

import type { ToolTierLevel } from '@bah/core'

import type { AuthorizationTier } from './types.ts'

/**
 * 档位 → 允许自动放行的工具级别。
 *
 * `strict: []` 是有意的：严格档等于"窗口只做提醒，不做代签"，
 * 这样"用户选了严格档"与"系统没有窗口能力"在行为上一致，答案只有一个人能给。
 */
export const WINDOW_AUTO_LEVEL: Readonly<Record<AuthorizationTier, readonly ToolTierLevel[]>> = {
  strict: [],
  standard: ['green', 'yellow'],
  wide: ['green', 'yellow', 'red'],
}

/** 不放行的结构化理由码（封闭联合；进审计与测试断言）。 */
export type WindowSignDenyCode =
  | 'tier-not-allowed'
  | 'red-unverified'
  | 'over-budget'
  | 'amount-invalid'

/** 判定输入（全部来自调用方；本函数不取任何数）。 */
export interface WindowSignInput {
  /** 窗口档位。 */
  readonly tier: AuthorizationTier
  /** 本次调用的生效级别（红级由"有挑战句柄"推出，见 interaction 的 `levelOf`）。 */
  readonly level: ToolTierLevel
  /** 武装时刻是否已完成强验证（`ArmedPlan.verifiedAt !== undefined` 且仍在窗口有效期内）。 */
  readonly redVerified: boolean
  /** 本次 run 已代签金额（分；不含本次）。 */
  readonly spentCents: number
  /** 本次金额（分）。 */
  readonly amountCents: number
  /** 窗口预算上限（分）。 */
  readonly budgetCents: number
}

/** 判定结论。 */
export type WindowSignVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: WindowSignDenyCode; readonly reason: string }

/**
 * 判定一次代签是否成立。
 *
 * 任何一项拿不到确定答案都不放行（`amount-invalid` / `tier-not-allowed`），
 * 不存在"默认允许"的分支。
 */
export function decideWindowSign(input: WindowSignInput): WindowSignVerdict {
  const { tier, level, redVerified, spentCents, amountCents, budgetCents } = input

  if (!Number.isInteger(spentCents) || !Number.isInteger(amountCents) || !Number.isInteger(budgetCents)) {
    return { ok: false, code: 'amount-invalid', reason: '代签金额必须是整数分' }
  }
  if (amountCents < 0 || budgetCents < 0 || spentCents < 0) {
    return { ok: false, code: 'amount-invalid', reason: '代签金额不能为负' }
  }

  const allowed = WINDOW_AUTO_LEVEL[tier]
  if (!allowed.includes(level)) {
    return {
      ok: false,
      code: 'tier-not-allowed',
      reason: `档位 ${tier} 不代签 ${level} 级调用`,
    }
  }
  if (level === 'red' && !redVerified) {
    return {
      ok: false,
      code: 'red-unverified',
      reason: '红级代签要求武装时刻已完成强验证，且仍在窗口有效期内',
    }
  }
  if (spentCents + amountCents > budgetCents) {
    return {
      ok: false,
      code: 'over-budget',
      reason: `本次 run 累计 ${String(spentCents + amountCents)} 分超过窗口预算 ${String(budgetCents)} 分`,
    }
  }
  return { ok: true }
}
