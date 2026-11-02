/**
 * 系统提示词装配的运行期形状。
 *
 * 三个正交的概念，别混：
 * 1. `PromptSection`：一段提示词 + 一个**冻结的序**（`SECTION_ORDERS`）；
 * 2. `PromptContext`：本次装配的输入（能力位 / 工具 / 运行时视图 / 渠道）；
 * 3. `ComposedPrompt`：装配结果，**分成两半**——`header` 进 system 头，
 *    `context` 以 user 角色落历史（运行时上下文**不拼进 system 头**）。
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

/** 渠道（语气与长度适配， 的 `style` 段）。 */
export type ChannelKind = 'web' | 'mobile' | 'im' | 'desktop' | 'headless' | 'sdk'

/** 账户槽位（展示用；金额已由边界格式化，运行时不做任何金额运算）。 */
export interface RuntimeContextAccountView {
  /** 受控文案：活期 / 定期 / 锁定 */
  readonly name: string
  /** 脱敏尾号：只允许数字，最多 4 位 */
  readonly maskedNumber: string
  /** 必须由 `formatYuan(cents)` 产出（如 `¥12,345.67`）；禁止 toFixed/浮点 */
  readonly balanceText: string
  /** 同上 */
  readonly availableText: string
  /** 受控文案：正常 / 冻结 / 销户 */
  readonly statusText?: string
}

/** 运行时上下文视图（`runtime.context` 段的输入；**不进 system 头**）。 */
export interface RuntimeContextView {
  readonly user?: {
    readonly name?: string
    readonly level?: string
  }
  readonly accounts?: readonly RuntimeContextAccountView[]
  /** 受控模板生成的单行；**禁止**自由文本（收款人/商户名/备注） */
  readonly recentTransactions?: readonly string[]
  /** 即将扣款（单行；商户名已由数据边界净化） */
  readonly upcomingCharges?: readonly string[]
  readonly notes?: readonly string[]
  /**
   * 只有运行时 provider 才会写；静态 profile 不写（保证旧输出逐字不变）。
   */
  readonly meta?: {
    readonly source: 'bank'
    readonly status: 'ok' | 'unbound' | 'degraded'
    readonly code?: string
    /** 边界格式化好的 `YYYY-MM-DD HH:mm`（+8），运行时只排版 */
    readonly asOfText?: string
  }
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
 * 六段装配序。
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
