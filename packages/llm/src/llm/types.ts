/**
 * provider-neutral 模型词汇表（施工单 05 §1，**冻结面**）。
 *
 * 为什么单独冻一层：adapter 与主循环之间只认这套词汇，换 provider 不动主循环。
 * 判别标签（`kind` / `role`）一律小写 kebab-case，switch 一律以 `assertNever` 收尾（施工单 00 §9 第 6 条）。
 *
 * 与 `@bah/core` 的 `ContentBlock` 分工（同名不同域，跨包一律走包名，不会混）：
 * - core 的 = **工具结果内容块**（`type` 标签），属七段管线与卡片面；
 * - 本文件的 = **模型消息内容块**（`kind` 标签），属 wire 面。
 *
 * 块索引约定（adapter 实现方必须遵守，`StreamAssembler` 依赖它分组）：
 * 文本块 `0`、推理块 `1`、工具调用块从 `2` 起按 provider 给出的 `tool_calls[].index` 递增。
 */

import type { ToolSchema } from '@bah/core'

export type { ToolSchema }

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 内容块与流式分片（施工单 05 §1）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 模型消息内容块（五 kind + 两个工具集增量）。
 *
 * `tool-addition` / `tool-removal` 是 provider 在会话中途改工具集的机制
 * （等价于"把 schema 塞进对话"）；装配侧把它们并进下一轮请求的工具列表。
 */
export type ContentBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'image'; readonly mimeType: string; readonly data: string }
  | {
      readonly kind: 'file'
      readonly mimeType: string
      readonly name: string
      readonly data: string
    }
  | {
      readonly kind: 'tool-call'
      readonly id: string
      readonly name: string
      /** 已 parse 的参数对象（坏 JSON 时**不会**走到这里，见 `AssembledToolCall.parseError`）。 */
      readonly args: unknown
    }
  | { readonly kind: 'tool-addition'; readonly tools: readonly ToolSpec[] }
  | { readonly kind: 'tool-removal'; readonly names: readonly string[] }

/** 流式结束原因。`tool-calls` 驱动主循环的工具调度（施工单 04 §2.3）。 */
export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'aborted' | 'error'

/**
 * 流式分片。
 *
 * `tool-call-delta` 的参数是**文本增量**：按 `index` + `id` 累积，`block-end` 时整体 parse
 * （施工单 05 §2.1）——绝不在分片阶段尝试 parse（半截 JSON 必然失败）。
 */
export type StreamChunk =
  | { readonly kind: 'block-start'; readonly index: number }
  | { readonly kind: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly kind: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
      readonly kind: 'tool-call-delta'
      readonly index: number
      /** 首个分片带 `id`；后续分片可省略。 */
      readonly id?: string
      /** 首个分片带 `name`；后续分片可省略。 */
      readonly name?: string
      /** 参数 JSON 文本增量。 */
      readonly argsText?: string
    }
  | { readonly kind: 'block-end'; readonly index: number }
  | {
      readonly kind: 'usage'
      readonly input: number
      readonly output: number
      /** 缓存命中的输入 tokens（provider 未上报时缺省）。 */
      readonly cachedInput?: number
      /** 本片用量对应的费用（微元；计价表未配置时缺省）。 */
      readonly costMicroYuan?: number
    }
  | { readonly kind: 'finish'; readonly reason: FinishReason }

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 消息、工具与请求
 * ──────────────────────────────────────────────────────────────────────────── */

/** 消息角色（wire 面四角色）。 */
export type LlmRole = 'system' | 'user' | 'assistant' | 'tool'

/** 一条模型消息（角色 + 内容块 + 工具归属）。 */
export interface LlmMessage {
  readonly role: LlmRole
  readonly content: readonly ContentBlock[]
  /** `role === 'tool'` 时必填：归属的调用 ID。 */
  readonly toolCallId?: string
  /** 工具名（部分 provider 需要）。 */
  readonly name?: string
}

/** 面向模型的工具描述（由 `ToolDefinition` 收窄而来，不带执行体与卡片）。 */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly schema: ToolSchema
}

/** 能力位：决定提示词装配与工具选择（施工单 05 §3）。 */
export interface ModelCapabilities {
  readonly toolCall: boolean
  readonly image: boolean
  readonly reasoning: boolean
}

/** provider 自述（`id` 是注册表的键，`capabilities` 是本 provider 的能力上限）。 */
export interface ProviderInfo {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ModelCapabilities
}

/** 模型清单项（`listModels` 的返回单位）。 */
export interface ModelInfo {
  readonly id: string
  readonly displayName?: string
  readonly contextWindow?: number
  readonly capabilities?: Partial<ModelCapabilities>
}

/** 一次调用的模型规格（`resolveModel` 的返回；`capabilities` 必填）。 */
export interface ModelSpec extends ModelInfo {
  readonly providerId: string
  readonly capabilities: ModelCapabilities
  /**
   * 计价表（可选；未配置 = 不报价，成本账本记 0）。
   *
   * 单位是**微元 / 百万 tokens**（1 ¥ = 1e6 微元）：整数运算，不引入浮点误差。
   * 价格只从配置来，绝不在代码里硬编码厂商单价——改价不用改代码。
   */
  readonly pricing?: ModelPricing
}

/** 模型计价（每百万 tokens 的微元单价）。 */
export interface ModelPricing {
  /** 未命中缓存的输入。 */
  readonly inputPerMTok: number
  /** 命中缓存的输入（缺省时按未命中价计，即"不享受缓存折扣"）。 */
  readonly cachedInputPerMTok?: number
  /** 输出。 */
  readonly outputPerMTok: number
}

/** 采样参数（可调项一律走这里，不许硬编码在 adapter 内部）。 */
export interface LlmParams {
  readonly temperature?: number
  readonly maxTokens?: number
  readonly topP?: number
  readonly stop?: readonly string[]
}

/** 一次模型请求（装配前）。 */
export interface LlmRequest {
  readonly modelId: string
  readonly messages: readonly LlmMessage[]
  readonly tools?: readonly ToolSpec[]
  readonly params?: LlmParams
  /** 归属会话（adapter 记账/路由用；**不得**进 wire）。 */
  readonly sessionId?: string
}

/**
 * 已冻结的调用（`prepareCall` 的产出）。
 *
 * 「冻结」= 主循环拿到它之后不再允许 `agent/request` listener 改写（施工单 04 §2.2）；
 * adapter 侧用 `Object.freeze` 保证实现层面也改不动。
 */
export interface PreparedCall {
  /** 调用 ID（一次 `prepareCall` 一个，审计与日志对齐用）。 */
  readonly id: string
  readonly request: LlmRequest
  readonly model: ModelSpec
  readonly params: LlmParams
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Adapter seam（施工单 05 §2）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 模型适配器接缝。
 *
 * 五个方法各有分工，别合并：
 * - `providerInfo` / `listModels`：路由与展示；
 * - `resolveModel`：**能力位的唯一来源**——提示词装配靠它裁剪 section（施工单 05 §4）；
 * - `prepareCall`：绑定模型与参数（此后请求冻结）；
 * - `stream`：真正的 wire 交互，必须响应 `signal`（中断传播，施工单 04 §3）。
 */
export interface LlmAdapter {
  providerInfo(): ProviderInfo
  listModels(): Promise<readonly ModelInfo[]>
  resolveModel(modelId: string): ModelSpec
  prepareCall(request: LlmRequest): Promise<PreparedCall>
  stream(call: PreparedCall, signal: AbortSignal): AsyncIterable<StreamChunk>
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. 用量与成本账本（施工单 05 §3）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 一次调用的用量。 */
export interface CallUsage {
  readonly input: number
  readonly output: number
  /** 缓存命中的输入 tokens（provider 未上报时缺省，不要用 0 冒充"未命中"）。 */
  readonly cachedInput?: number
  /** 本次调用的费用（微元；1 ¥ = 1e6 微元）。未配计价或缺省时表示"不报价"。 */
  readonly costMicroYuan?: number
}

/**
 * 一个 turn 的用量汇总。
 *
 * **与 `usage/summary` 会话事件同形**（施工单 05 §3「按 turn 汇总 tokens 进入审计导出」）；
 * 两处形状的一致性由阶段 5 的集成测试钉住，此包不依赖 `@bah/runtime`。
 */
export interface TurnUsage extends CallUsage {
  readonly turn: number
  /** 本 turn 的模型调用次数。 */
  readonly calls: number
  /** 缓存命中的输入 tokens（本 turn 累计；缺省 0）。 */
  readonly cachedInput: number
  /** 本 turn 的费用（微元；缺省 0）。 */
  readonly costMicroYuan: number
}

/** 模型侧的流式产出（`stream` 结束后的完整结果）。 */
export interface AssistantMessage {
  readonly content: readonly ContentBlock[]
  readonly finishReason: FinishReason
  readonly usage?: CallUsage
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. 装配后的工具调用（`assemble.ts` 的产出，`repair.ts` 的输入）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 一次装配完成的工具调用。
 *
 * `args` 只在**参数可解析且为 object 根**时存在；坏 JSON 时 `parseError` 有值、`args` 缺省、
 * `argsText` 保留原文——三件事同时成立，修复路径才有东西可喂（施工单 05 §2.3）。
 */
export interface AssembledToolCall {
  readonly callId: string
  readonly name: string
  readonly argsText: string
  readonly args?: Readonly<Record<string, unknown>>
  readonly parseError?: string
}

/** 一条流装配完的完整结果。 */
export interface AssembledStream {
  readonly content: readonly ContentBlock[]
  readonly toolCalls: readonly AssembledToolCall[]
  readonly finishReason: FinishReason
  readonly usage: CallUsage
}
