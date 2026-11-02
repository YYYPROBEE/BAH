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
  /**
   * 会话 ID（策略外置 S2）：灰度分桶与审计关联用。
   *
   * **不参与规则表达式**：`bank.tier.input/v1` 的字段表里 `subject.sessionId` 只读，
   * 但 schema 不把它暴露给 `when`（见 `@bah/policy` 的 `BANK_TIER_FIELDS` 说明）。
   */
  readonly sessionId?: string
  /** 预留的租户键：v1 不参与判决，也不参与分桶（避免声称多租户）。 */
  readonly tenant?: string
}

/** 被请求的动作（工具名 + 声明级别；声明级别是下限，不是最终级别）。 */
export interface PolicyAction {
  readonly name: string
  readonly declared: ToolTierLevel
  /** bundle 类型；缺省 `bank.tier`（策略外置 S2 的增量字段）。 */
  readonly kind?: string
  /** 调用 ID（影子差异事件用；`tier/decided` 已带同一 ID）。 */
  readonly callId?: string
}

/** 判定上下文（会话侧状态；领域预检由策略实现自己解释）。 */
export interface PolicyContext {
  /** 本 turn 已发生的风险调用次数。 */
  readonly riskyCallsInTurn: number
  /** 强验证是否处于锁定期。 */
  readonly verifyLocked: boolean
  /** 领域预检（转账/理财才有）；形状由策略实现定义，runtime 不解释。 */
  readonly preview?: unknown
  /**
   * 类型化输入（策略外置 S2）：由治理平面按 `bank.tier.input/v1` 构造并冻结。
   *
   * `@bah/policy` 的实现读它；legacy 实现忽略它（两条路径互不依赖）。
   */
  readonly input?: unknown
}

/**
 * 策略意。`code` 用于审计与结果码（deny 时必须有可机读的理由）。
 *
 * 四个 `level/tierReason/ruleIds/policyVersion` 是**可选增量**（策略外置 S2）：
 * - legacy 实现（`createTierPolicy`）**不填**，治理平面据此走旧 `decide()` 路径；
 * - bundle 实现填四项，治理平面把它们作为"升级结果"传给 `decide(input, escalation)`。
 *
 * 这样"策略提供升级"不需要新服务键，也不需要第二个端口——`runtime:policy` 仍是唯一注入点。
 */
export interface PolicyDecision {
  readonly verdict: PolicyVerdict
  readonly reason: string
  readonly code?: string
  /** bundle 给出的生效级别（`max(declared, raise)` 之后的结果）。 */
  readonly level?: ToolTierLevel
  /** bundle 给出的理由（受 `reason` 词表约束）；治理平面传给判定矩阵。 */
  readonly tierReason?: string
  /** 命中的规则 ID（含默认行），顺序 = 表顺序。 */
  readonly ruleIds?: readonly string[]
  /** bundle 身份（`name/version+sha256:<16>`）；legacy 不填。 */
  readonly policyVersion?: string
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

/**
 * 策略描述符（策略外置 S3）：**只读元数据**，不参与判决。
 *
 * 为什么单独一个服务键：`tier/decided` 的早拒路径（sentry 先拒 / 未绑定身份 / 预检失败）
 * 不跑策略，但仍要回答"当时生效的是哪版策略"；在 `apply()` 里捕获版本会漏掉热重载。
 * 描述符只用于启动日志、`/api/metrics` 的版本维度、`policy:explain` 的元数据。
 */
export interface PolicyDescriptor {
  /** bundle 类型（v1 只有 `bank.tier`）。 */
  readonly kind: string
  /** `name/version`：registry 键与 CLI 参数。 */
  readonly handle: string
  /** `name/version+sha256:<16>`：写进审计的 `policyVersion`。 */
  readonly version: string
  /** 语义摘要（64 hex）。 */
  readonly semanticDigest: string
  /** DSL 能力版本。 */
  readonly engineVersion: string
  /** 载入时刻（注入时钟）。 */
  readonly loadedAt: number
  /**
   * bundle 声明的参数边界（**只声明名字/类型/边界，不持有值**）。
   *
   * `bank:tools` 用它校验自己的部署参数：键集必须与求值参数完全一致，值必须落在
   * `[min, max]`（02 §3.1 的 `policy-param-mismatch`）。缺省 = 该 bundle 不声明参数。
   */
  readonly parameters?: Readonly<Record<string, { readonly min: number; readonly max: number }>>
  /** 金丝雀分配（没有则缺省）。 */
  readonly canary?: {
    readonly handle: string
    readonly version: string
    /** 万分比整数（500 = 5%）。 */
    readonly percent: number
    readonly epoch: number
  }
}

/** 服务键：`runtime:policy-meta`（宿主 / 测试可注入；只读）。 */
export const POLICY_DESCRIPTOR: ServiceKey<PolicyDescriptor> =
  defineService<PolicyDescriptor>('runtime:policy-meta')

/**
 * 参数绑定检查（策略外置 S3）：在**激活前**用部署参数校验新描述符。
 *
 * 为什么单独一个服务键：`policy:rules` 不知道 `bank:tools` 的配置值；而热重载
 * 换到一个"参数名/边界不同"的 bundle 时，启动期校验已经跑过了，不能假设新 bundle
 * 仍兼容。宿主在 `bank:tools` 里提供一个检查函数，`policy:rules` 在原子替换前调用；
 * 抛错 = 重载失败、旧版继续服务（I10）。
 */
export type PolicyParamCheck = (descriptor: PolicyDescriptor) => void

/** 服务键：`runtime:policy-param-check`。 */
export const POLICY_PARAM_CHECK: ServiceKey<PolicyParamCheck> =
  defineService<PolicyParamCheck>('runtime:policy-param-check')

/** 取参数检查函数；未装配时返回 `undefined`（纯策略插件 / 测试）。 */
export function findPolicyParamCheck(ctx: Context): PolicyParamCheck | undefined {
  try {
    return ctx.get(POLICY_PARAM_CHECK)
  } catch {
    return undefined
  }
}

/** 提供参数检查函数（宿主装配用）；返回注销句柄。 */
export function providePolicyParamCheck(
  ctx: Context,
  check: PolicyParamCheck,
): Disposer {
  return ctx.provide(POLICY_PARAM_CHECK, check)
}

/** 取策略描述符；未提供时返回 `undefined`（legacy 模式或未装策略插件）。 */
export function findPolicyDescriptor(ctx: Context): PolicyDescriptor | undefined {
  try {
    return ctx.get(POLICY_DESCRIPTOR)
  } catch {
    return undefined
  }
}

/** 提供策略描述符（宿主装配用）；返回注销句柄。 */
export function providePolicyDescriptor(
  ctx: Context,
  descriptor: PolicyDescriptor,
): Disposer {
  return ctx.provide(POLICY_DESCRIPTOR, descriptor)
}
