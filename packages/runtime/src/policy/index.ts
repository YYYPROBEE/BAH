/**
 * 策略引擎（W04 · G-2 抽象）。
 *
 * 目标只有一个：**判决矩阵可以被替换，但不可以被绕过**。
 * 银行侧的默认实现（`@bah/bank` 的 `createTierPolicy`）直接调用既有的 `tier.ts`，
 * 不复制规则；本文件只定义端口与服务键，不 import 任何宿主包（runtime 不认识 bank）。
 *
 * 判定语义（治理平面负责组合，不在本文件实现）：
 * - **取高不取低**：策略的 `deny` 可以加严，`allow` 不能把黄/红降成免审批；
 * - 绿级工具不进策略（读操作不受策略拒绝影响）——这是 TC-W04-06 的口径。
 */

import { defineService } from '@bah/core'

import type { Context, Disposer, ServiceKey, ToolTierLevel } from '@bah/core'

// W12：票据 lease 是策略面的短窗口原语（与 PolicyEngine 同目录，但不是同一个概念）
export * from './ticket.ts'

/** 策略结论（与三级权限同名的三值，但语义是"策略意见"而非最终判决）。 */
export type PolicyVerdict = 'allow' | 'deny' | 'ask'

/** 主体：当前是谁在请求。未绑定身份时 `userId` 缺省。 */
export interface PolicySubject {
  readonly userId?: string
}

/** 被请求的动作（工具名 + 声明级别；声明级别是下限，不是最终级别）。 */
export interface PolicyAction {
  readonly name: string
  readonly declared: ToolTierLevel
}

/** 判定上下文（会话侧状态；领域预检由策略实现自己解释）。 */
export interface PolicyContext {
  /** 本 turn 已发生的风险调用次数。 */
  readonly riskyCallsInTurn: number
  /** 强验证是否处于锁定期。 */
  readonly verifyLocked: boolean
  /** 领域预检（转账/理财才有）；形状由策略实现定义，runtime 不解释。 */
  readonly preview?: unknown
}

/** 策略意见。`code` 用于审计与结果码（deny 时必须有可机读的理由）。 */
export interface PolicyDecision {
  readonly verdict: PolicyVerdict
  readonly reason: string
  readonly code?: string
}

/** 策略引擎端口。同步纯函数：不读时钟、不写事件、不签票据。 */
export interface PolicyEngine {
  decide(subject: PolicySubject, action: PolicyAction, context: PolicyContext): PolicyDecision
}

/** 服务键：`runtime:policy`（宿主 / 测试可注入替换实现）。 */
export const POLICY_ENGINE: ServiceKey<PolicyEngine> =
  defineService<PolicyEngine>('runtime:policy')

/** 取策略引擎；未提供时返回 `undefined`（治理平面据此回落到默认实现）。 */
export function findPolicyEngine(ctx: Context): PolicyEngine | undefined {
  try {
    return ctx.get(POLICY_ENGINE)
  } catch {
    return undefined
  }
}

/** 提供策略引擎（宿主装配用）；返回注销句柄。 */
export function providePolicyEngine(ctx: Context, engine: PolicyEngine): Disposer {
  return ctx.provide(POLICY_ENGINE, engine)
}
