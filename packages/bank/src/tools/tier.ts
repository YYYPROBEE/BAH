/**
 * 三级权限的**判定函数**（施工单 09 §1；08 先把「工具声明 + 金额/收款人升级」这段落地）。
 *
 * 语义（施工单 09 §1）：**取高不取低**——`effectiveTier = max(声明级别, 升级规则结果)`。
 * 升级只上调、永不降级：重试、超时、渠道切换都不能把红变黄。
 *
 * 本文件只做纯函数判定，不读 ctx、不写事件、不签发票据；装配在 `governance.ts`。
 * 09 的 `risky_calls` / 身份绑定 / 强验证挑战链在同一入口继续扩展，不改变本函数的输入输出。
 */

import type { ToolTierLevel } from '@bah/core'

import type { TransferPreview } from '../core/provider.ts'

/** 升级理由（审计与文案用）。 */
export type TierReason = 'declared' | 'new-payee' | 'daily-limit'

/** 判定结果。 */
export interface TierDecision {
  readonly level: ToolTierLevel
  readonly reason: TierReason
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
  }
}

/** 取两者中更高的级别（同级别返回 `left`）。 */
export function higherTier(left: ToolTierLevel, right: ToolTierLevel): ToolTierLevel {
  return tierRank(right) > tierRank(left) ? right : left
}

/**
 * 转账类的升级规则（施工单 08 §3.8 / 施工单 09 §1.1 第 1、4 条）。
 *
 * - 当日累计**含本笔** > 日限额 → 红（`daily-limit`，权威口径来自 bank-core）；
 * - 收款人未登记 / `binding = 'new'` → 红（`new-payee`，防“小额试探 + 大额收割”）；
 * - 否则保留声明级别。
 *
 * 同时命中时理由取 `daily-limit`（金额是更强的解释），但级别都是红。
 */
export function escalateTransferTier(
  declared: ToolTierLevel,
  preview: Pick<
    TransferPreview,
    'amountCents' | 'dailyUsedCents' | 'dailyLimitCents' | 'payee'
  >,
): TierDecision {
  const overLimit = preview.dailyUsedCents + preview.amountCents > preview.dailyLimitCents
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
