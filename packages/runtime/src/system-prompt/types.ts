/**
 * 系统提示词装配的运行期形状（施工单 05 §4）。
 *
 * 三个正交的概念，别混：
 * 1. `PromptSection`：一段提示词 + 一个**冻结的序**（`SECTION_ORDERS`）；
 * 2. `PromptContext`：本次装配的输入（能力位 / 工具 / 运行时视图 / 渠道）；
 * 3. `ComposedPrompt`：装配结果，**分成两半**——`header` 进 system 头，
 *    `context` 以 user 角色落历史（施工单 05 §4.1：运行时上下文**不拼进 system 头**）。
 *
 * 能力位（`PromptCapabilities`）来自 `LlmAdapter.resolveModel()`，是裁剪 section 的唯一依据：
 * 模型不支持 function calling，就不许把工具 schema 塞给它——塞了它只会照着编。
 */

import type { ToolSchema, ToolTier } from '@bah/core'

/** 模型能力位（`ModelCapabilities` 的镜像；runtime 不依赖 `@bah/llm`）。 */
export interface PromptCapabilities {
  readonly toolCall: boolean
  readonly image: boolean
  readonly reasoning: boolean
}

/** 面向提示词的工具描述（`ToolDefinition` 的收窄视图，不带执行体与卡片）。 */
export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly schema: ToolSchema
  readonly tier: ToolTier
}

/** 渠道（语气与长度适配，施工单 05 §4 的 `style` 段）。 */
export type ChannelKind = 'web' | 'mobile' | 'im' | 'desktop' | 'headless' | 'sdk'

/** 运行时上下文视图（`runtime.context` 段的输入；**不进 system 头**）。 */
export interface RuntimeContextView {
  readonly user?: {
    readonly name?: string
    readonly level?: string
  }
  readonly accounts?: readonly {
    readonly name: string
    readonly maskedNumber: string
    readonly balance: number
  }[]
  readonly recentTransactions?: readonly string[]
  readonly notes?: readonly string[]
}

/** 一次装配的输入。 */
export interface PromptContext {
  readonly capabilities: PromptCapabilities
  /** 可装配的工具（能力位为 `false` 时提示词段整体不装配）。 */
  readonly tools: readonly ToolDescriptor[]
  readonly runtime?: RuntimeContextView
  readonly channel?: ChannelKind
  readonly locale?: string
}

/**
 * 一段提示词。
 *
 * `target` 决定落点（缺省 `header`）：
 * - `header`：进 system 头，一次装配一次落账（`system/message`）；
 * - `context`：以 user 角色落历史并按 reconcile 回收（`runtime-context`）。
 */
export interface PromptSection {
  readonly id: string
  /** 装配序（`SECTION_ORDERS` 里的值，冻结不可改）。 */
  readonly order: number
  readonly target?: 'header' | 'context'
  /** 返回 `undefined` = 本段不装配（能力位裁剪的实现机制）。 */
  render(context: PromptContext): string | undefined
}

/**
 * 六段装配序（施工单 05 §4，**顺序冻结**）。
 *
 * 改这张表 = 破坏性变更（模型行为会整体漂移）：必须同步更新架构文档并跑全量快照。
 */
export const SECTION_ORDERS = {
  'identity.safety': 0,
  'bank.domain': 10,
  'bank.capabilities': 20,
  'runtime.context': 30,
  'policy.approval': 40,
  style: 50,
} as const

/** 内建 section 的 id 联合。 */
export type SectionId = keyof typeof SECTION_ORDERS

/** 装配出的一段（`parts` 的顺序 = 装配顺序）。 */
export interface ComposedPromptPart {
  readonly id: string
  readonly order: number
  readonly text: string
}

/** 装配结果：system 头与运行时上下文**分开**。 */
export interface ComposedPrompt {
  /** system 头文本（不含 `runtime.context`）。 */
  readonly header: string
  /** 运行时上下文文本（`undefined` = 本次没有任何运行时上下文）。 */
  readonly context: string | undefined
  /** 实际装配出的段（按 order 升序；一次装配只 render 一次）。 */
  readonly parts: readonly ComposedPromptPart[]
  /** 实际装配出的段 id（顺序同 `parts`）。 */
  readonly sectionIds: readonly string[]
}
