/**
 * 授权窗口（ADR-0006 的上游）：条件快照 + 到期判定 + 授权档。
 *
 * 纪律（门禁 I16 逐条扫本目录）：
 * - 不读真实时钟（`at` / `now` 都是入参）；
 * - 不读随机；
 * - 不写会话日志（本目录不认识 session）。
 *
 * 判定时刻与落账时刻是**两个时钟**（D-C）：`at` 只用于"到期了没有"，
 * 事件里的 `at` 永远取宿主注入的 `RunContext.now`。
 */

import type { Plan } from '../plan/types.ts'

/** 授权档：宽 / 标准 / 严格。档位只影响"无人值守时允许什么"，不改变审批记录本身。 */
export type AuthorizationTier = 'strict' | 'standard' | 'wide'

/** 一条条件：武装时拍照，唤醒时复验；任何一条失守都降级为人工确认。 */
export type WindowCondition =
  | { readonly kind: 'balance-at-least'; readonly cents: number }
  | { readonly kind: 'fact-unchanged'; readonly factId: string; readonly version: number }
  | { readonly kind: 'plan-not-cancelled'; readonly planId: string }
  | { readonly kind: 'amount-within'; readonly cents: number }
  | { readonly kind: 'address-unchanged'; readonly addressId: string; readonly version: number }

/** 周期规则（`occurrenceOf` 的唯一输入）。 */
export type Recurrence =
  | { readonly every: 'once'; readonly dueAt: number }
  | { readonly every: 'daily'; readonly at: string }
  | { readonly every: 'monthly'; readonly day: number; readonly at: string }
  | { readonly every: 'yearly'; readonly month: number; readonly day: number; readonly at: string }

/** 一张已武装的计划（窗口 + 计划身份 + 周期）。 */
export interface ArmedPlan {
  readonly planId: string
  /** 窗口 id：票据 `authorization.ref` 指向它，可反查本条目。 */
  readonly windowId: string
  /** 计划内容摘要（`planDigest`）；唤醒时与当前计划比对，防"武装的是 A，跑的是 B"。 */
  readonly planDigest: string
  readonly title: string
  readonly tier: AuthorizationTier
  readonly conditions: readonly WindowCondition[]
  readonly budgetCents: number
  /** 本次实例的到期时刻（epoch ms）。周期计划每次武装只覆盖一个实例。 */
  readonly dueAt: number
  /** 周期规则：`occurrenceOf` 据此算幂等键；一次性计划为 `{every:'once'}`。 */
  readonly recurrence: Recurrence
  /** 环境给出的过期时刻（缺省不过期）。 */
  readonly expiresAt?: number
  /** 被授权的计划本体（唤醒时原样交给 `PlanApi.run`）。 */
  readonly plan: Plan
  /** 武装时刻（判定"这个实例跑过没有"的下界）。 */
  readonly armedAt: number
  /** `armed` 才会被 `duePlans` 选中；`cancelled` 只能通过 `plan_disarm` 进入。 */
  readonly state: 'armed' | 'cancelled'
}

/** 复验时看到的世界（**必须由调用方快照**，本目录不去查任何服务）。 */
export interface WorldSnapshot {
  /** 真实当前时刻（宿主注入的 `RunContext.now`）。 */
  readonly now: number
  readonly balanceCents: number
  /** 事实版本表：`factId → version`。 */
  readonly factVersions: Readonly<Record<string, number>>
  /** 已取消的计划 id（含本计划自身：`plan_disarm` 之后必须能复验失败）。 */
  readonly cancelledPlans: readonly string[]
  /** 地址版本表：`addressId → version`。 */
  readonly addressVersions: Readonly<Record<string, number>>
}

/** 判决输入：**落账的就是它**，回放据此重算（门禁 I13）。 */
export interface WindowVerdictInputs {
  readonly balanceCents: number
  readonly factVersions: Readonly<Record<string, number>>
  readonly planState: 'armed' | 'cancelled'
  readonly at: number
  readonly budgetCents: number
}

/** 一条失守条件的证据（`expected` / `actual` 都是可读字符串，落审计）。 */
export interface WindowFailure {
  readonly kind: string
  readonly expected: string
  readonly actual: string
}

/** 窗口失守码（封闭联合）。 */
export type WindowFailureCode =
  | 'window-expired'
  | 'condition-failed'
  | 'plan-cancelled'
  | 'window-clock-ahead'

/** 复验结论：成功也带输入与摘要（"判决可重算"的前提）。 */
export type WindowVerdict =
  | {
      readonly ok: true
      readonly inputs: WindowVerdictInputs
      readonly digest: string
    }
  | {
      readonly ok: false
      readonly inputs: WindowVerdictInputs
      readonly digest: string
      readonly code: WindowFailureCode
      readonly failed: readonly WindowFailure[]
      /** 失守一律降级为人工确认，**不许自动放行**。 */
      readonly downgrade: 'ask'
    }

/** 到期扫描结论：时钟越界时 `ok:false`，此时**一条都不执行**。 */
export type DueScan =
  | { readonly ok: true; readonly due: readonly ArmedPlan[] }
  | { readonly ok: false; readonly code: 'window-clock-ahead'; readonly at: number; readonly now: number }

/** 判定时钟的允许漂移（缺省 5 分钟）：`at` 只能"现在"附近，不能是 2030 年。 */
export const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000

/**
 * 三个内置工具名。
 *
 * `plan_wake` **不对模型暴露**（`exposure:'internal'`）：模型若能调它，
 * 就能对任意未到期计划发起唤醒——"主动"就变成"模型想什么时候花就什么时候花"。
 */
export const PLAN_ARM_TOOL = 'plan_arm'
export const PLAN_DISARM_TOOL = 'plan_disarm'
export const PLAN_WAKE_TOOL = 'plan_wake'
