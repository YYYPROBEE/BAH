/**
 * 上下文压缩的配置与计划（施工单 05 §5）。
 *
 * 三条设计约束（都写进了类型）：
 * 1. **阈值全部配置化**：`CompactionThresholds` 里没有一个是硬编码常量，装配期由
 *    `resolveCompactionConfig` fail-loud 校验（施工单 05 §5「无硬编码常量」）；
 * 2. **压缩不改写历史**：append-only 是不变量，所以"折叠"只发生在投影层
 *    （`collapseEvents` + `system-prompt/reconcile.buildModelHistory`）；
 * 3. **金融特例字段结构化保留**：`FinancialSummaryEntry` 是摘要载荷的一部分，
 *    不是拼进文本的一句话（否则审计链断裂）。
 */

import type { AnySessionEvent, CompactionSummaryData, FinancialSummaryEntry } from '../session/types.ts'

/** 压缩阈值（`keepRecentTurns` 必填：没有任何"保留原文"的压缩等于篡改上下文）。 */
export interface CompactionThresholds {
  /** token 水位：估算值达到即触发。 */
  readonly maxTokens?: number
  /** turn 数阈值：完整 turn 数超过即触发。 */
  readonly maxTurns?: number
  /** 最近多少个 turn 保留原文（≥ 1）。 */
  readonly keepRecentTurns: number
}

/** 折叠结果（投影层用）。 */
export interface CollapsedEvents {
  /** 折叠后的事件（历史摘要事件已从历史里剔除，改由 `summaries` 承载）。 */
  readonly kept: readonly AnySessionEvent[]
  /** 已生效的摘要（按落账顺序）。 */
  readonly summaries: readonly CompactionSummaryData[]
  /** 已被摘要覆盖的 turn（升序）。 */
  readonly collapsedTurns: readonly number[]
}

/** 一次压缩计划（`planned = true` 时 `data` 必须落账）。 */
export interface CompactionPlan {
  readonly needed: boolean
  /** 要落账的摘要载荷（`needed = true` 时必有）。 */
  readonly data?: CompactionSummaryData
  /** 将被折叠的事件 `seq`（投影时剔除）。 */
  readonly droppedSeqs: readonly number[]
  /** 将被折叠的 turn（升序）。 */
  readonly collapsedTurns: readonly number[]
}

/** `planCompaction` 的入参。 */
export interface PlanCompactionInput {
  readonly events: readonly AnySessionEvent[]
  readonly thresholds: CompactionThresholds
}

/** 摘要文本渲染的输入（拆开传，便于单测每一部分）。 */
export interface SummaryTextInput {
  readonly fromTurn: number
  readonly toTurn: number
  readonly turns: number
  readonly droppedMessages: number
  readonly toolCalls: readonly { readonly name: string; readonly count: number }[]
  readonly financial: readonly FinancialSummaryEntry[]
}
