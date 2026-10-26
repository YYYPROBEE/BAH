/**
 * 默认策略实现（W04 · `PolicyEngine` 的银行侧）。
 *
 * **不复制规则**：`decide()` 直接从 `tier.ts` 调用。这里是适配器，不是第二真相源。
 * 任何想改判决的人只能改 `tier.ts`，或者注入另一个 `PolicyEngine`。
 */

import type { PolicyEngine } from '@bah/runtime'
import { assertNever } from '@bah/util'

import { decide, type TierConfig, type TransferPreviewLike } from './tier.ts'

/** 把 `tier.ts` 的判定矩阵包成策略引擎。 */
export function createTierPolicy(config: TierConfig): PolicyEngine {
  return {
    decide(subject, action, context) {
      const decision = decide({
        name: action.name,
        declared: action.declared,
        config,
        state: {
          ...(subject.userId === undefined ? {} : { userId: subject.userId }),
          riskyCallsInTurn: context.riskyCallsInTurn,
          verifyLocked: context.verifyLocked,
        },
        ...(context.preview === undefined
          ? {}
          : { preview: context.preview as TransferPreviewLike }),
      })

      switch (decision.kind) {
        case 'allow':
          return { verdict: 'allow', reason: decision.reason }
        case 'ask':
          return { verdict: 'ask', reason: decision.reason }
        case 'deny':
          return { verdict: 'deny', reason: decision.reason, code: decision.code }
        default:
          // 构造不可达：封闭联合已穷尽（纪律 6 要求收尾）
          /* v8 ignore next */
          return assertNever(decision, 'policy-decision')
      }
    },
  }
}
