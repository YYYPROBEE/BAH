/**
 * 请求装配、冻结与提交（施工单 04 §2.2）。
 *
 * ```text
 * 装配（纯）  提示词装配 + 日志派生历史 + 认领消息 + 注入上下文 → LlmRequest
 * 派发        agent/request（可改写模型路由 / 参数）
 * 冻结        prepareCall（adapter 侧 Object.freeze）→ 此后不再派发 agent/request
 * 提交        request/header → system/message → request/context → user/message
 * ```
 *
 * **为什么"提交"要晚于 `prepareCall`**：施工单 04 §2.2 要求取消的两种异步阶段
 * （`agent/request` 与 `prepareCall`）**都不提交** system/user 消息——取消就是没发生。
 * 所以本次 attempt 的模型可见输入在内存里装配好、先只喂给这一轮请求，
 * 等 `prepareCall` 成功返回（= 请求真的发出去了）才落账。
 * 落账顺序与 `system-prompt/reconcile.ts` 的 `beginAttempt` 逐条一致
 * （`request.test.ts` 有一条对照用例钉住这个一致性）。
 *
 * 模型历史**只从日志派生**（`buildModelHistory`），本文件不维护任何影子历史。
 */

import { assertNever } from '@bah/util'

import type { ContentBlock as SessionBlock } from '@bah/core'
import type {
  ContentBlock as ModelBlock,
  LlmMessage,
  LlmParams,
  LlmRequest,
  ModelSpec,
  PreparedCall,
  ToolSpec,
} from '@bah/llm'

import type { DerivedMessage } from '../session/types.ts'
import type { SessionApi, SessionSink } from '../session/service.ts'
import { buildModelHistory } from '../system-prompt/reconcile.ts'
import type { RuntimeContextQueue } from '../system-prompt/reconcile.ts'
import type { PromptRegistry } from '../system-prompt/registry.ts'
import type { ChannelKind, ComposedPrompt, RuntimeContextView, ToolDescriptor } from '../system-prompt/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { InboxMessage } from './inbox.ts'

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 会话投影 → 模型消息（wire-agnostic 视图，施工单 03 R32）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 把派生历史映射成模型消息。
 *
 * 两处有意的丢弃：
 * - `system` 消息**跳过**：本次 attempt 的系统头由本次装配结果提供（旧装配结果已按
 *   reconcile 撤回，这里再兜一次，保证 system 永远只有一条、且是最新的）；
 * - `reasoning` 块不回放：provider 侧也不接受把推理过程塞回去（施工单 05 的 wire 映射同此）。
 */
export function toLlmMessages(messages: readonly DerivedMessage[]): LlmMessage[] {
  const output: LlmMessage[] = []

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        continue

      case 'user':
        output.push({ role: 'user', content: [{ kind: 'text', text: message.content }] })
        continue

      case 'assistant':
        output.push({
          role: 'assistant',
          content: [
            ...toModelBlocks(message.content),
            ...(message.toolCalls ?? []).map(
              (call): ModelBlock => ({
                kind: 'tool-call',
                id: call.callId,
                name: call.name,
                args: call.args,
              }),
            ),
          ],
        })
        continue

      case 'tool':
        output.push({
          role: 'tool',
          toolCallId: message.callId,
          name: message.name,
          content: toModelBlocks(message.content),
        })
        continue

      default:
        assertNever(message, 'derived-message-role')
    }
  }

  return output
}

/** 会话内容块 → 模型内容块（只有 text / image 两种能跨过投影）。 */
export function toModelBlocks(content: readonly SessionBlock[]): ModelBlock[] {
  return content.map((block): ModelBlock => {
    switch (block.type) {
      case 'text':
        return { kind: 'text', text: block.text }
      case 'image':
        return { kind: 'image', mimeType: block.mimeType, data: block.data }
      default:
        assertNever(block, 'session-content-block')
    }
  })
}

/**
 * 模型内容块 → 会话内容块（落 `assistant/message` 用）。
 *
 * 只留模型"说出口"的东西：文本与图片。理由块（推理过程）与工具集增量块不属于模型可见历史，
 * 工具调用由 `assistant/message.toolCalls` 字段承载（wire 侧再从那里还原 tool_calls）。
 */
export function toSessionBlocks(content: readonly ModelBlock[]): SessionBlock[] {
  const output: SessionBlock[] = []

  for (const block of content) {
    switch (block.kind) {
      case 'text':
        output.push({ type: 'text', text: block.text })
        continue
      case 'image':
        output.push({ type: 'image', mimeType: block.mimeType, data: block.data })
        continue
      case 'reasoning':
      case 'file':
      case 'tool-call':
      case 'tool-addition':
      case 'tool-removal':
        continue
      default:
        assertNever(block, 'model-content-block')
    }
  }

  return output
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 装配（纯函数：不落账、不改队列之外的状态）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 工具定义 → 提示词装配用的收窄视图。 */
export function toolDescriptorsOf(registry: ToolRegistry): ToolDescriptor[] {
  return registry.list().map((definition) => ({
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    tier: definition.tier,
  }))
}

/** 工具定义 → 模型侧 schema（不带执行体与卡片）。 */
function toolSpecsOf(registry: ToolRegistry): ToolSpec[] {
  return registry.list().map((definition) => ({
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
  }))
}

/** 装配入参。 */
export interface AssembleRequestInput {
  readonly session: SessionApi
  readonly composer: PromptRegistry
  readonly tools: ToolRegistry
  /** 本次尝试的首选模型（能力位决定提示词段裁剪与是否下发工具 schema）。 */
  readonly model: ModelSpec
  readonly queue: RuntimeContextQueue
  /** 本次认领到的消息（会被追加成 user 消息）。 */
  readonly claim: readonly InboxMessage[]
  readonly params?: LlmParams
  readonly channel?: ChannelKind
  readonly runtime?: RuntimeContextView
}

/** 装配结果（`request` 会被 `agent/request` 改写，`composed`/`contextTexts` 用于提交）。 */
export interface RequestAssembly {
  readonly request: LlmRequest
  readonly composed: ComposedPrompt
  /** 本次携带的运行时上下文文本（FIFO：渲染结果在前，注入文本在后）。 */
  readonly contextTexts: readonly string[]
  readonly claimed: readonly InboxMessage[]
}

/**
 * 装配一次请求。
 *
 * 提示词装配与模型能力位绑定：模型不支持 function calling 时**不下发**工具 schema
 * （下发了它只会照着编，施工单 05 §4）。
 */
export function assembleRequest(input: AssembleRequestInput): RequestAssembly {
  const composed = input.composer.compose({
    capabilities: input.model.capabilities,
    tools: toolDescriptorsOf(input.tools),
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  })

  // 注入的上下文与渲染结果一起进本次请求，并一起落账（模型可见即必须留痕）
  const injected = input.queue.drain()
  const contextTexts = composed.context === undefined ? injected : [composed.context, ...injected]

  const messages: LlmMessage[] = []
  if (composed.header.length > 0) {
    messages.push({ role: 'system', content: [{ kind: 'text', text: composed.header }] })
  }
  messages.push(...toLlmMessages(buildModelHistory(input.session.events())))
  if (contextTexts.length > 0) {
    messages.push({ role: 'user', content: [{ kind: 'text', text: contextTexts.join('\n\n') }] })
  }
  for (const message of input.claim) {
    messages.push({ role: 'user', content: [{ kind: 'text', text: message.text }] })
  }

  const tools = input.model.capabilities.toolCall ? toolSpecsOf(input.tools) : []

  return {
    request: {
      modelId: input.model.id,
      messages,
      ...(tools.length === 0 ? {} : { tools }),
      ...(input.params === undefined ? {} : { params: input.params }),
      sessionId: input.session.sessionId,
    },
    composed,
    contextTexts,
    claimed: input.claim,
  }
}

/**
 * 冻结请求（`agent/request` 之后、`prepareCall` 之前调用）。
 *
 * 浅冻结：请求对象本身不可改（防 adapter 侧顺手写字段），嵌套数组仍是只读视图的约定。
 * 真正的"冻结"由两条机制共同保证：此后不再派发 `agent/request`，且 `PreparedCall`
 * 由 adapter 用 `Object.freeze` 产出（阶段 4 的 mock / DeepSeek 都遵守）。
 */
export function freezeRequest(request: LlmRequest): LlmRequest {
  return Object.freeze(request)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. 提交（`prepareCall` 之后：取消就是没发生）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 提交入参。 */
export interface CommitAttemptInput {
  readonly session: SessionSink
  readonly turn: number
  readonly step: number
  /** 已冻结的调用（`model` / `params` 取它，而不是取装配结果——冻结后的才是真的）。 */
  readonly prepared: PreparedCall
  readonly composed: ComposedPrompt
  readonly contextTexts: readonly string[]
  /** 本次认领的消息（按原顺序落成 user 消息）。 */
  readonly messages: readonly InboxMessage[]
}

/**
 * 把本次 attempt 的模型可见输入落账（顺序固定）。
 *
 * 1. `request/header`：本次请求的路由与参数快照（冻结后不可改写，审计据此复盘"当时用的什么"）；
 * 2. `system/message`：装配出的系统头（每次 attempt 一条，投影只认最新一条）；
 * 3. `request/context`：**每次都落**，`texts` 为空表示"本次没有运行时上下文"——
 *    这是 reconcile 判定"哪些上下文已过期"的边界，缺了它旧上下文就撤不掉；
 * 4. `user/message`（`runtime-context`）：仅当确有文本时；
 * 5. 认领到的用户消息（按原顺序）。
 */
export function commitAttempt(input: CommitAttemptInput): void {
  input.session.append('request/header', {
    turn: input.turn,
    step: input.step,
    model: input.prepared.model.id,
    params: plainParams(input.prepared.params),
  })
  input.session.append('system/message', { content: input.composed.header })
  input.session.append('request/context', {
    turn: input.turn,
    step: input.step,
    texts: input.contextTexts,
  })
  if (input.contextTexts.length > 0) {
    input.session.append('user/message', {
      content: input.contextTexts.join('\n\n'),
      source: 'runtime-context',
    })
  }
  for (const message of input.messages) {
    input.session.append('user/message', { content: message.text, source: message.source })
  }
}

/** `LlmParams` → 会话事件的 `params` 快照（纯 JSON 对象，避免把类实例写进日志）。 */
export function plainParams(params: LlmParams): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(params))
}
