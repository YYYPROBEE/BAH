/**
 * 适当性闸门（唯一规则实现）。
 *
 * 《金融机构产品适当性管理办法》的硬约束在代码里只有一处：**产品风险等级不得高于
 * 客户风险承受能力**。规则做成纯函数，两个强制点共用：
 *
 * - `tools/governance.ts`：签发票据**之前**拒绝（模型 / 渠道发起的调用）；
 * - `core/mock.ts`：核销**之前**再拒绝一次（绕过治理面的直接调用）。
 *
 * 不放进 prompt、不做成可调策略：这是法定红线，不是风控阈值。改它要过 code review。
 *
 * 客户等级来自 `User.riskGrade`（静态画像，演示环境不重评；没有评估时间与有效期）。
 */

import type { RiskGrade } from './model.ts'

/** R1–R5 的序（客户与产品共用一套词汇，见 `model.ts` 的 `RiskGrade`）。 */
const RANK: Readonly<Record<RiskGrade, number>> = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 }

/** 一次匹配的输入。 */
export interface SuitabilityInput {
  readonly customerRisk: RiskGrade
  readonly productRisk: RiskGrade
}

/** 匹配结论：允许，或以稳定理由码拒绝（理由给模型与用户看，不含内部编号）。 */
export type SuitabilityVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly code: 'suitability-mismatch'; readonly reason: string }

/** 产品风险 ≤ 客户承受能力才允许；**相等允许**（R3 客户可买 R3 产品）。 */
export function checkSuitability(input: SuitabilityInput): SuitabilityVerdict {
  if (RANK[input.productRisk] <= RANK[input.customerRisk]) return { allow: true }
  return {
    allow: false,
    code: 'suitability-mismatch',
    reason: `产品风险等级 ${input.productRisk} 超出您的风险承受能力 ${input.customerRisk}，不可购买`,
  }
}
