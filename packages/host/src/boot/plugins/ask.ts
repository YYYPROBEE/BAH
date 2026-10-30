/**
 * 非银行工具的人工审批包装（"自包 pre-execute ask" 的唯一实现）。
 *
 * 为什么需要它：`bank/src/tools/governance.ts` 对**非银行工具直接放行**
 * （`if (!BANK_TOOL_NAME_SET.has(name)) return downstream`）——也就是说，
 * 随手写一个 `tier:'yellow'` 的内置工具，它的黄级是装饰品：不过 tier 判决、
 * 不签票据、不计 riskyOps。所有"会动东西"的非银行工具必须自己在这里包一层 ask。
 *
 * 写法照抄 `plan_execute` 的包装：**先 `await next()` 再 ask**。
 * 反过来（ask 先于 next）会让下游的 deny 被外层审批盖住，是 I4 静态锚点明令禁止的。
 */

import { canonicalJson, sha256Hex } from '@bah/util'

import type { Context } from '@bah/core'
import type { PreExecuteInput } from '@bah/runtime'

/** 包装参数。 */
export interface AskPolicy {
  /** 需要人工审批的工具名（只写"会动东西"的那些）。 */
  readonly names: readonly string[]
  /** 审批票据 TTL（毫秒）。 */
  readonly ttlMs: number
}

/**
 * 给一批非银行工具挂黄级审批（幂等注册；dispose 由 `ctx.effect` 负责）。
 *
 * @returns 注销句柄（由 `ctx.effect` 接管）
 */
export function askForNonBankTools(ctx: Context, policy: AskPolicy): void {
  const names = new Set(policy.names)
  ctx.effect(
    ctx.events.on('tools/pre-execute', async (payload: PreExecuteInput, next) => {
      const downstream = await next(payload)
      if (!names.has(payload.call.name)) return downstream
      if (downstream.verdict.kind !== 'allow') return downstream
      return {
        ...downstream,
        verdict: {
          kind: 'ask' as const,
          ticket: {
            fingerprint: sha256Hex(canonicalJson(payload.call.args)),
            ttlMs: policy.ttlMs,
          },
        },
      }
    }),
  )
}
