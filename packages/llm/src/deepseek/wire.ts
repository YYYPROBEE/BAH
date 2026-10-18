/**
 * DeepSeek 的 wire 映射（OpenAI 兼容形态，施工单 05 §2.1）。
 *
 * 本文件**只有纯函数**：内容块 ↔ wire 消息、工具 schema ↔ `tools` 字段、SSE 分片 ↔ `StreamChunk`。
 * 网络与重试在 `adapter.ts`——这样 wire 映射可以逐条单测，不需要任何密钥或桩服务器。
 *
 * 三条纪律：
 * 1. 不支持的块**显式抛错**，绝不静默丢（丢一张图等于篡改上下文）；
 * 2. `reasoning` 块**不回灌** wire：推理内容属于本轮的临时产物，重放会污染下一轮；
 * 3. 结束原因用白名单映射，未知值退化成 `stop`（不猜 `error`，否则会把正常结束判成失败）。
 */

import { BahError, assertNever } from '@bah/util'

import type {
  ContentBlock,
  FinishReason,
  LlmMessage,
  PreparedCall,
  StreamChunk,
  ToolSpec,
} from '../llm/types.ts'

/** 块索引约定（`types.ts` §块索引约定）：文本 0、推理 1、工具调用 2 起。 */
export const TEXT_INDEX = 0
export const REASONING_INDEX = 1
export const TOOL_INDEX_BASE = 2

/** 密钥与端点的环境变量名（施工单 05 §2.1「配置：环境变量，进 Config 校验，不硬编码」）。 */
export const API_KEY_ENV = 'DEEPSEEK_API_KEY'
export const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

/** 缺省端点（官方 OpenAI 兼容入口；**不是**密钥，硬编码安全）。 */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** 路径。 */
export const CHAT_COMPLETIONS_PATH = '/chat/completions'
export const MODELS_PATH = '/models'

/** wire 消息（OpenAI 兼容 chat 形态的最小子集）。 */
export interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | null
  readonly tool_call_id?: string
  readonly name?: string
  readonly tool_calls?: readonly WireToolCall[]
}

/** wire 工具调用。 */
export interface WireToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

/** wire 工具描述。 */
export interface WireTool {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: unknown
  }
}

/** 环境变量读取结果。 */
export interface DeepSeekEnv {
  readonly apiKey?: string
  readonly baseUrl: string
}

/**
 * 从环境变量读配置（缺省不报错——**没密钥时 adapter 可构造**，`prepareCall` 才 fail-loud，
 * 这样无密钥机器也能装配依赖图并跑单测）。
 */
export function readDeepSeekEnv(env: Record<string, string | undefined>): DeepSeekEnv {
  const apiKey = env[API_KEY_ENV]
  const baseUrl = env[BASE_URL_ENV]
  return {
    ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
    baseUrl: baseUrl === undefined || baseUrl === '' ? DEFAULT_BASE_URL : baseUrl,
  }
}

/** 拼 URL（幂等地处理 baseUrl 尾部斜杠）。 */
export function joinUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${trimmed}${path}`
}

/**
 * 内容块 → wire 消息。
 *
 * @throws `BahError('llm-wire-unsupported-block')` 含本 provider 不支持的块（图片/文件/工具集增量）
 * @throws `BahError('llm-wire-invalid')` 工具消息缺少 `toolCallId`
 */
export function toWireMessages(messages: readonly LlmMessage[]): WireMessage[] {
  return messages.map(toWireMessage)
}

/** 单条消息的映射（判别标签穷尽，`assertNever` 收尾）。 */
function toWireMessage(message: LlmMessage): WireMessage {
  const text = textOf(message.content, message.role)
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: text }
    case 'assistant': {
      const toolCalls = toolCallsOf(message.content)
      return {
        role: 'assistant',
        content: text.length === 0 ? null : text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      }
    }
    case 'tool': {
      if (message.toolCallId === undefined) {
        throw new BahError(
          'llm-wire-invalid',
          'deepseek: role=tool 的消息必须带 toolCallId（否则 wire 上无法配对）',
        )
      }
      return {
        role: 'tool',
        content: text,
        tool_call_id: message.toolCallId,
        ...(message.name === undefined ? {} : { name: message.name }),
      }
    }
    default:
      assertNever(message.role, 'llm-wire-role')
  }
}

/** 拼接文本块（推理块不回灌，见文件头第 2 条）。 */
function textOf(content: readonly ContentBlock[], role: string): string {
  const texts: string[] = []
  for (const block of content) {
    switch (block.kind) {
      case 'text':
        texts.push(block.text)
        break
      case 'reasoning':
        break
      case 'tool-call':
        // 只有 assistant 能发起调用；其他角色带调用块说明装配错了，必须显式失败
        if (role !== 'assistant') {
          throw new BahError('llm-wire-invalid', `deepseek: ${role} 消息不允许携带工具调用`)
        }
        break
      default:
        throw new BahError(
          'llm-wire-unsupported-block',
          `deepseek: ${role} 消息含不支持的块 ${block.kind}（本 provider 只支持文本与工具调用）`,
          { kind: block.kind },
        )
    }
  }
  return texts.join('\n')
}

/** 提取工具调用块 → wire tool_calls（角色合法性已由 `textOf` 校验）。 */
function toolCallsOf(content: readonly ContentBlock[]): WireToolCall[] {
  const calls: WireToolCall[] = []
  for (const block of content) {
    if (block.kind !== 'tool-call') continue
    calls.push({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.args ?? {}) },
    })
  }
  return calls
}

/** 工具描述 → wire `tools` 字段（空数组返回 `undefined`，避免发一个空字段）。 */
export function toWireTools(tools: readonly ToolSpec[] | undefined): WireTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.schema },
  }))
}

/** 请求体（`stream` 恒为 `true`：本 adapter 只做流式）。 */
export function toWireBody(prepared: PreparedCall, stream: boolean): Record<string, unknown> {
  const tools = toWireTools(prepared.request.tools)
  const params = prepared.params
  return {
    model: prepared.model.id,
    messages: toWireMessages(prepared.request.messages),
    stream,
    // 让 provider 在最后一帧带 usage（成本账本依赖它）
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.maxTokens === undefined ? {} : { max_tokens: params.maxTokens }),
    ...(params.topP === undefined ? {} : { top_p: params.topP }),
    ...(params.stop === undefined ? {} : { stop: params.stop }),
  }
}

/** 结束原因白名单（未知值退化成 `stop`：不猜 `error`，否则正常结束会被判失败）。 */
const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  stop: 'stop',
  tool_calls: 'tool-calls',
  length: 'length',
  content_filter: 'error',
}

/** 一段 SSE 字节流 → 若干 `StreamChunk`（纯函数，便于单测坏分片）。 */
export function fromWireChunk(payload: unknown): StreamChunk[] {
  if (!isRecord(payload)) {
    throw new BahError('llm-wire-invalid', 'deepseek: 响应分片不是 JSON 对象')
  }

  const chunks: StreamChunk[] = []

  const usage = payload['usage']
  if (isRecord(usage)) {
    chunks.push({
      kind: 'usage',
      input: numberField(usage, 'prompt_tokens'),
      output: numberField(usage, 'completion_tokens'),
    })
  }

  const choices = payload['choices']
  const choice = Array.isArray(choices) ? choices[0] : undefined
  if (!isRecord(choice)) return chunks

  const delta = choice['delta']
  if (isRecord(delta)) {
    const content = delta['content']
    if (typeof content === 'string' && content.length > 0) {
      chunks.push({ kind: 'text-delta', index: TEXT_INDEX, text: content })
    }
    // DeepSeek 的推理内容字段名是 reasoning_content
    const reasoning = delta['reasoning_content']
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      chunks.push({ kind: 'reasoning-delta', index: REASONING_INDEX, text: reasoning })
    }
    const calls = delta['tool_calls']
    if (Array.isArray(calls)) {
      for (const call of calls) chunks.push(...toolCallDelta(call))
    }
  }

  const finish = choice['finish_reason']
  if (typeof finish === 'string') {
    chunks.push({ kind: 'finish', reason: FINISH_REASONS[finish] ?? 'stop' })
  }

  return chunks
}

/** 单个 wire tool_call 分片 → `tool-call-delta`。 */
function toolCallDelta(call: unknown): StreamChunk[] {
  if (!isRecord(call)) return []
  const fn = call['function']
  const index = numberField(call, 'index')
  const id = call['id']
  const name = isRecord(fn) ? fn['name'] : undefined
  const args = isRecord(fn) ? fn['arguments'] : undefined
  return [
    {
      kind: 'tool-call-delta',
      index: TOOL_INDEX_BASE + index,
      ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
      ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
      ...(typeof args === 'string' ? { argsText: args } : {}),
    },
  ]
}

/**
 * 切出完整 SSE 记录。
 *
 * SSE 记录以空行分隔；返回 `rest` 是不完整的尾巴，由调用方留到下一批字节再拼
 * （网络分片不会按记录边界切，这是最容易写错的一处）。
 */
export function parseSseRecords(buffer: string): { records: string[]; rest: string } {
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  return { records: parts, rest }
}

/**
 * 一条 SSE 记录 → `StreamChunk[]`（`[DONE]` 与心跳返回空）。
 *
 * @throws `BahError('llm-wire-invalid')` `data:` 不是合法 JSON
 */
export function chunksOfRecord(record: string): StreamChunk[] {
  const data = record
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('')

  if (data === '' || data === '[DONE]') return []

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new BahError('llm-wire-invalid', `deepseek: SSE data 不是合法 JSON（${reason}）`, {
      data: data.slice(0, 200),
    })
  }
  return fromWireChunk(payload)
}

/** 从 `GET /models` 的响应体取模型清单。 */
export function modelsFromWire(payload: unknown): { id: string }[] {
  if (!isRecord(payload)) {
    throw new BahError('llm-wire-invalid', 'deepseek: /models 响应不是 JSON 对象')
  }
  const data = payload['data']
  if (!Array.isArray(data)) return []
  const models: { id: string }[] = []
  for (const entry of data) {
    if (!isRecord(entry)) continue
    const id = entry['id']
    if (typeof id === 'string') models.push({ id })
  }
  return models
}

/** 非对象 → 取数字字段（缺省 0；`null` 也当 0）。 */
function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' ? value : 0
}

/** 对象判定（`null` 与数组都不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
