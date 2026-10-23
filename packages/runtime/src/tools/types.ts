/**
 * 工具契约的运行期视图（施工单 03 §2.1 / §2.2）。
 *
 * 静态契约（`ToolDefinition` / `tool tier` / 卡片 / 内容块）已由 `@bah/core` 的 `api.ts` 冻结，
 * 本文件**只补运行期需要的形状**：入参、冻结结果、一次执行的产出，以及依赖注入面。
 * 不在任何地方复制一份 `ToolDefinition`——契约只有一份（阶段 1 签审的那份）。
 */

import type { ContentBlock, TicketId, UiCard } from '@bah/core'

import type { ToolResultData } from '../session/types.ts'

export type {
  ContentBlock,
  PreExecuteVerdict,
  TicketDraft,
  TicketRef,
  ToolDefinition,
  ToolExecContext,
  ToolJsonSchema,
  ToolSchema,
  ToolTier,
  ToolTierLevel,
  UiCard,
} from '@bah/core'

/** 模型发起的工具调用（七段管线的入口形状）。 */
export interface ToolCallInput {
  /** 本次调用 ID（与 `tool/call` / `tool/result` 落账一致）。 */
  readonly callId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  /**
   * 本次调用对应的票据 ID（只有走过审批的调用才有）。
   *
   * 为什么挂在这里：`tools/execute` 是环绕式 waterfall，外层包裹函数（如 saga 桥接）
   * 拿到的就是这个 call。票据 ID 是随机 UUID，包裹层若不能从参数里读到它，
   * 就只能猜或去翻全局状态。挂在 call 上是最小且不撒谎的办法。
   */
  readonly ticketId?: TicketId
}

/** 一次执行的最终产出（结果已落账、卡片已生成）。 */
export interface ToolExecution {
  /** 冻结的权威结果（与 `tool/result` 落账内容一致）。 */
  readonly result: ToolResultData
  /** 待执行卡片（`presentCall` 的产物；无 presenter 时为 `undefined`）。 */
  readonly callCard?: UiCard
  /** 完成卡片（`presentResult` 的产物；出错或未执行时缺省）。 */
  readonly resultCard?: UiCard
  /** 追加给模型的上下文（FIFO，已按序落账为 `user/message`）。 */
  readonly additionalContexts: readonly string[]
}

/** 工具结果内容块的默认渲染（def 没有 `projectContent` 时用）。 */
export type ContentRenderer = (result: unknown) => readonly ContentBlock[]
