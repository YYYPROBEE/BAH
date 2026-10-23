/**
 * sentry 四接缝装配（施工单 10 §1 的映射表；本文件只做接线，判决在 `control.ts`）。
 *
 * ```text
 * agent/pre-step      ingress.ts   归一化 + 检测 + 审计 + 会话风险分（永不阻断）
 * tools/pre-execute   control.ts   规则 / 预算 / 断路器 / 降级 → deny（唯一阻断点）
 * tools/result        ticketing.ts 按 bank-core 票据状态记账 consumed / blocked（不核销）
 * session/event       audit.ts     turn 边界 / 审批 / 判决 / 拒绝全量落 TraceLog
 * tools/post-execute  honesty.ts   数值对账 → block + 纠正文本（经 fail-closed.ts 包一层：
 *                                 判决件自身抛错 → block + `sentry/verifier-failed`）
 * agent/turn-stopping honesty.ts   行动断言对账（S-1）/ 无工具结果不陈述 / 全 turn 数值复核 / 工具数判停
 *                                  （外再包一层 fail-closed：核验崩溃 → 判停，不放行收尾）
 * ```
 *
 * 纪律（施工单 10 硬约束 4）：一切贡献走 `ctx.effect(...)` / `ctx.events.on(...)` 返回 disposer；
 * 本文件不 import 任何领域包（`@bah/bank` / `@bah/runtime` / `@bah/interaction`），
 * 外部世界只通过 `SentryPorts` 注入。
 */

import { defineService } from '@bah/core'
import type { Context, Disposer, ServiceKey, SessionId, ToolTierLevel } from '@bah/core'

import { BudgetLedger, TraceLog } from '../kernel/index.ts'
import type { TraceSink } from '../kernel/index.ts'

import { createAuditListener } from './audit.ts'
import { SentryBreaker } from './breaker.ts'
import type { SentrySettings } from './config.ts'
import type { SentrySessionEventType } from './events.ts'
import { createControlListener, type ToolTierLookup } from './control.ts'
import { createSentryPostExecuteListener, failClosedTurnStopping } from './fail-closed.ts'
import { createTurnStoppingListener } from './honesty.ts'
import { createIngressListener } from './ingress.ts'
import { SentryState } from './state.ts'
import { createTicketingListener } from './ticketing.ts'

export * from './audit.ts'
export * from './breaker.ts'
export * from './config.ts'
export * from './control.ts'
export * from './events.ts'
export * from './fail-closed.ts'
export * from './honesty.ts'
export * from './im.ts'
export * from './ingress.ts'
export * from './numeric.ts'
export * from './state.ts'
export * from './ticketing.ts'

/** 宿主注入的外部世界（sentry 不直接 import 任何领域包）。 */
export interface SentryPorts {
  readonly sessionId: SessionId
  /** 注入时钟（窗口 / 审计 / 纠正全部用它，禁止读真实时间）。 */
  readonly now: () => number
  /** durable 事件出口；宿主必须按 `ignorable: true` 落账（施工单 10 硬约束 6）。 */
  readonly record: (type: SentrySessionEventType, data: unknown) => void
  /** 工具 tier 查询（控制平面的降级/冻结只绿判定；缺省视为红）。 */
  readonly toolTier: ToolTierLookup
  /** bank-core 的票据状态读取口（`ticket:<callId>`）。 */
  readonly ticketStatus: (ticketId: string) => string | undefined
  /** 吊销全部在途票据（属主 bank-core；返回吊销条数）。 */
  readonly revokeTickets: (reason: string, at: number) => number
  /** 把纠正提示推回 inbox 的 `next-step` 车道。 */
  readonly nudge: (agentId: string, text: string) => void
  /** TraceLog 落盘出口（`trace.sink = 'memory'` 时缺省 = 只留内存环）。 */
  readonly traceSink?: TraceSink
}

/** 对外观察视图（审计面板 / 用例断言 / 人工接管前置检查）。 */
export interface SentryView {
  readonly sessionId: string
  readonly turn: number
  readonly toolsInTurn: number
  readonly riskScore: number
  readonly riskLevel: string
  readonly degraded: boolean
  readonly frozen: boolean
}

/** `safety:sentry` 服务面（人工解冻是唯一解除路径）。 */
export interface SentryHandle {
  readonly trace: TraceLog
  readonly breaker: SentryBreaker
  readonly state: SentryState
  /** 显式人工解冻断路器（返回是否真的解除）。 */
  unfreeze(by: string, reason?: string): boolean
  /** 解除"只绿模式"（显式人工恢复；返回是否真的恢复）。 */
  restore(by: string, reason?: string): boolean
  /** 当前观察视图。 */
  view(): SentryView
}

/** 服务键：`safety:sentry`（宿主 / 审计面板 / 坐席控制台按它取用）。 */
export const SENTRY_SERVICE: ServiceKey<SentryHandle> = defineService<SentryHandle>('safety:sentry')

/**
 * 装配 sentry 的四接缝监听器。
 *
 * @param ctx 内核上下文（监听器随 ctx dispose 自动撤销）
 * @param settings 已校验的 Config
 * @param ports 外部世界（时钟 / 落账 / 票据 / 纠正）
 * @returns 服务面（宿主用 `ctx.provide(SENTRY_SERVICE, handle)` 暴露）
 */
export function provideSentry(
  ctx: Context,
  settings: SentrySettings,
  ports: SentryPorts,
): SentryHandle {
  const sessionId = ports.sessionId as string
  const trace = new TraceLog({
    ...(ports.traceSink === undefined ? {} : { sink: ports.traceSink }),
    ringSize: settings.trace.ringSize,
    flushThreshold: settings.trace.flushThreshold,
    now: ports.now,
  })
  const state = new SentryState()
  const budget = new BudgetLedger({
    total_calls: settings.budget.totalCalls,
    risky_calls: settings.budget.riskyCalls,
    amount: settings.budget.amountYuan * 100,
  }).get(sessionId)
  const breaker = new SentryBreaker({
    sessionId,
    settings: settings.breaker,
    state,
    now: ports.now,
    trace,
    record: ports.record,
    revokeTickets: ports.revokeTickets,
  })

  const shared = {
    sessionId,
    settings,
    state,
    trace,
    record: ports.record,
    now: ports.now,
  }

  ctx.effect(ctx.events.on('agent/pre-step', createIngressListener(shared)))
  ctx.effect(
    ctx.events.on(
      'tools/pre-execute',
      createControlListener({ ...shared, breaker, budget, toolTier: ports.toolTier }),
    ),
  )
  ctx.effect(
    ctx.events.on(
      'tools/result',
      createTicketingListener({ ...shared, ticketStatus: ports.ticketStatus }),
    ),
  )
  ctx.effect(ctx.events.on('session/event', createAuditListener({ ...shared, breaker })))
  // fail-closed：判决件自己抛错时降级为 block，而不是让 runtime 的通用 catch
  // 把**未经核验**的结果按 accept 交给模型（HP-0 §0.1）
  ctx.effect(
    ctx.events.on(
      'tools/post-execute',
      createSentryPostExecuteListener({ ...shared, nudge: ports.nudge }),
    ),
  )
  // 收尾钩子也包 fail-closed：行动断言守卫自己崩了，不许把带成功断言的消息放行收尾
  ctx.effect(
    ctx.events.on(
      'agent/turn-stopping',
      failClosedTurnStopping(createTurnStoppingListener({ ...shared, nudge: ports.nudge }), {
        sessionId,
        trace,
        record: ports.record,
        now: ports.now,
      }),
    ),
  )

  return {
    trace,
    breaker,
    state,
    unfreeze(by, reason = 'operator-unfreeze') {
      return breaker.unfreeze(by, reason, ports.now())
    },
    restore(by, reason = 'operator-restore') {
      if (!state.degraded) return false
      state.degraded = false
      state.invalidArgsStreak = 0
      trace.append({ session: sessionId, kind: 'policy-restored', by, reason, at: ports.now() })
      return true
    },
    view() {
      return {
        sessionId,
        turn: state.turn,
        toolsInTurn: state.toolsInTurn,
        riskScore: state.riskScore,
        riskLevel: state.riskLevel,
        degraded: state.degraded,
        frozen: breaker.frozen,
      }
    },
  }
}

/** 装配并注册 `safety:sentry` 服务（`provideSentry` + `ctx.provide`）。 */
export function installSentry(
  ctx: Context,
  settings: SentrySettings,
  ports: SentryPorts,
): Disposer {
  return ctx.provide(SENTRY_SERVICE, provideSentry(ctx, settings, ports))
}

/** 工具 tier 的显式类型（宿主接线用；避免各插件各写一份结构）。 */
export type SentryToolTier = { readonly level: ToolTierLevel; readonly amountPath?: string }
