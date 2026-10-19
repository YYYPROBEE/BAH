/**
 * 控制平面（施工单 10 §1 映射表第 2 行）：`tools/pre-execute`（waterfall）。
 *
 * **唯一阻断点**（铁律二）：危险规则 / 参数 blob / 预算 / 断路器 / 降级模式 → `deny`，
 * 其余一律把下游判决原样交还（`allow` / `ask` 都可能是 `bank:tools` 或审批服务的结论）。
 *
 * 判决顺序（施工单 03 §2.2 的 ③a–d）：
 * ```
 * a. 危险规则（13 条确定性正则 + 部署追加规则；命中即 deny 短路）
 * b. PII 参数检测（**仅审计**，不阻断）
 * c. 预算（total_calls / risky_calls / amount，先记账再比对）
 * d. 断路器冻结 / 降级只绿 / 同 turn 工具数超限
 * ```
 * 任何一步都只读注入的 Config / 观察状态，**没有概率成分**。
 */

import type { ToolTierLevel } from '@bah/core'

import { collectBlob, normalize, scanToolArgs, TokenizerVault } from '../kernel/index.ts'
import type { Budget, RuleFinding, TraceLog } from '../kernel/index.ts'

import type { SentryBreaker } from './breaker.ts'
import { CROSS_SCENARIO_RULES } from './config.ts'
import type { SentrySettings } from './config.ts'
import type { SentrySessionEventType } from './events.ts'
import { yuanToCents } from './numeric.ts'
import type { SentryState } from './state.ts'

/** 工具调用（七段管线的入参形状；不 import `@bah/runtime`）。 */
interface CallLike {
  readonly callId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

/** 判决（只声明本文件会产出的两种；`ask` 由下游给出）。 */
type DenyVerdict = { readonly kind: 'deny'; readonly code: string; readonly reason: string }

/** pre-execute 信封（waterfall 同信封进出）。 */
interface PreExecuteLike {
  readonly call: CallLike
  readonly verdict:
    | { readonly kind: 'allow' }
    | DenyVerdict
    | { readonly kind: 'ask'; readonly ticket: unknown; readonly challenge?: unknown }
}

/** 工具 tier 查询端口（宿主从 `TOOLS_SERVICE` 取）。 */
export type ToolTierLookup = (
  name: string,
) => { readonly level: ToolTierLevel; readonly amountPath?: string } | undefined

/** 控制平面的装配参数。 */
export interface SentryControlOptions {
  readonly sessionId: string
  readonly settings: SentrySettings
  readonly state: SentryState
  readonly trace: TraceLog
  readonly breaker: SentryBreaker
  readonly budget: Budget
  readonly record: (type: SentrySessionEventType, data: unknown) => void
  readonly now: () => number
  readonly toolTier: ToolTierLookup
}

/** PII 检测器（只做审计；`detect()` 不产生随机段）。 */
const PII_VAULT = new TokenizerVault()

/**
 * 造控制监听器（waterfall）。
 *
 * 先 `await next()` 交还控制权（下游 = bank 治理 / 审批桥接），再叠加 sentry 的确定性拒绝：
 * 下游的 `ask` / `deny` 永远保留，sentry 只在允许路径上追加拒绝。
 */
export function createControlListener(
  options: SentryControlOptions,
): (payload: unknown, next: (value: unknown) => Promise<unknown>) => Promise<unknown> {
  const { sessionId, settings, state, trace, breaker, budget, record, now, toolTier } = options
  const extraRules = [
    ...(settings.rules.crossScenario ? CROSS_SCENARIO_RULES : []),
    ...settings.rules.extra,
  ]

  return async (payload, next) => {
    const input = payload as PreExecuteLike
    const downstream = (await next(payload)) as PreExecuteLike
    const at = now()

    const call = input.call
    const tier = toolTier(call.name) ?? { level: 'red' as const }
    const blob = collectBlob(call.args)
    const normalized = normalize(blob)

    // a. 危险规则（归一化后再扫：base64 / 全角 / 零宽载荷先被拆开）
    const findings = scanToolArgs(normalized.normalized, {
      disabledIds: settings.rules.disabled,
      demoWhitelist: settings.rules.demoWhitelist,
      extraRules,
    })

    // b. PII 只审计（不阻断：PII 不是攻击意图的确定性证据）
    const pii = PII_VAULT.detect(normalized.normalized)
    if (pii.length > 0) {
      trace.bump('pii', pii.length)
      trace.append({
        session: sessionId,
        kind: 'pii',
        callId: call.callId,
        name: call.name,
        types: pii.map((hit) => hit.type),
        at,
      })
    }

    if (findings.length > 0) {
      return deny(call, ruleDeny(findings), at)
    }

    // c. 预算（先记账再比对；超预算 = 确定性阻断信号）
    const total = budget.tryConsume('total_calls', 1)
    if (!total.ok) {
      return deny(
        call,
        {
          stage: 'budget',
          code: 'sentry-budget-exceeded',
          reason: `调用总数超预算（${total.spent}/${total.limit}）`,
        },
        at,
      )
    }
    if (tier.level !== 'green') {
      const risky = budget.tryConsume('risky_calls', 1)
      if (!risky.ok) {
        return deny(
          call,
          {
            stage: 'budget',
            code: 'sentry-budget-exceeded',
            reason: `风险调用数超预算（${risky.spent}/${risky.limit}）`,
          },
          at,
        )
      }
    }
    const amountCents = readAmount(call.args, tier.amountPath)
    if (amountCents !== undefined) {
      const amount = budget.tryConsume('amount', amountCents)
      if (!amount.ok) {
        return deny(
          call,
          {
            stage: 'budget',
            code: 'sentry-budget-exceeded',
            reason: `金额超预算（${amount.spent}/${amount.limit} 分）`,
          },
          at,
        )
      }
    }

    // d. 锁存冻结 / 降级只绿 / 同 turn 工具数（三者都只拦非绿：绿级只读永不因熔断被误伤）
    if (breaker.frozen && tier.level !== 'green') {
      return deny(
        call,
        {
          stage: 'breaker',
          code: 'sentry-breaker-frozen',
          reason: '会话已被断路器冻结：敏感操作一律拒绝，需人工解冻',
        },
        at,
      )
    }
    if (state.degraded && tier.level !== 'green') {
      return deny(
        call,
        {
          stage: 'degraded',
          code: 'sentry-degraded',
          reason: '会话已降级为只绿模式：非绿级工具一律拒绝',
        },
        at,
      )
    }
    if (state.toolsInTurn > settings.guard.maxToolsPerTurn) {
      if (state.markGuardNotified(state.turn)) {
        record('guard/repeat-tool', {
          turn: state.turn,
          tools: state.toolsInTurn,
          limit: settings.guard.maxToolsPerTurn,
          at,
        })
      }
      return deny(
        call,
        {
          stage: 'tool-limit',
          code: 'sentry-tool-limit',
          reason: `同 turn 工具调用数超限（${state.toolsInTurn}/${settings.guard.maxToolsPerTurn}），请换策略`,
        },
        at,
      )
    }

    /** 拒绝：TraceLog + durable 事件 + 断路器计数（三件事一次做完）。 */
    function deny(call: CallLike, decision: DenyDecision, at: number): PreExecuteLike {
      trace.bump('denies')
      trace.append({
        session: sessionId,
        kind: 'verdict',
        verdict: 'deny',
        stage: decision.stage,
        code: decision.code,
        reason: decision.reason,
        callId: call.callId,
        name: call.name,
        at,
      })
      record('sentry/tool-denied', {
        callId: call.callId,
        name: call.name,
        code: decision.code,
        reason: decision.reason,
        stage: decision.stage,
        at,
      })
      breaker.recordDeny(call.callId, at)
      return {
        ...downstream,
        verdict: { kind: 'deny', code: decision.code, reason: decision.reason },
      }
    }

    // 允许：落审计（每个决策点必落账）后把下游判决原样交还
    trace.bump('allows')
    trace.append({
      session: sessionId,
      kind: 'verdict',
      verdict: downstream.verdict.kind === 'allow' ? 'allow' : 'observed',
      observed: downstream.verdict.kind,
      callId: call.callId,
      name: call.name,
      at,
    })
    return downstream
  }
}

/** 一条确定性拒绝（阶段 + 理由码 + 可读理由）。 */
interface DenyDecision {
  readonly stage: 'rules' | 'budget' | 'breaker' | 'degraded' | 'tool-limit'
  readonly code: string
  readonly reason: string
}

/** 规则命中 → 拒绝内容（理由里带规则 ID 与命中片段，便于答辩复盘）。 */
function ruleDeny(findings: readonly RuleFinding[]): DenyDecision {
  const detail = findings.map((finding) => `${finding.id}(${finding.family}): ${finding.hit}`).join('；')
  return {
    stage: 'rules',
    code: 'sentry-rule-hit',
    reason: `命中危险规则：${detail}`,
  }
}

/** 读金额参数（元 → 分）；缺省 / 非法一律 `undefined`（金额校验归工具体）。 */
function readAmount(
  args: Readonly<Record<string, unknown>>,
  amountPath: string | undefined,
): number | undefined {
  if (amountPath === undefined) return undefined
  const cents = yuanToCents(args[amountPath])
  return cents === undefined || cents <= 0 ? undefined : cents
}
