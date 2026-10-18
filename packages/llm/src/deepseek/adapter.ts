/**
 * DeepSeek provider（施工单 05 §2.1）。
 *
 * 只做 wire 交互，策略一律外置：
 * - 密钥/端点只从环境变量读（施工单硬约束 2：仓库任何文件不得出现硬编码 key）；
 * - 降级/重试/限流属 `route.ts`（本 adapter 只负责"这一枪打得准不准"）；
 * - 参数修复属 `repair.ts`（本 adapter 只负责把 `tool-call-delta` 如实吐出来）。
 *
 * `fetch` 可注入：单测用假 Response 驱动 SSE 解析，不需要网络与密钥。
 */

import { BahError } from '@bah/util'

import type {
  LlmAdapter,
  LlmRequest,
  ModelInfo,
  ModelSpec,
  PreparedCall,
  ProviderInfo,
  StreamChunk,
} from '../llm/types.ts'
import {
  CHAT_COMPLETIONS_PATH,
  MODELS_PATH,
  chunksOfRecord,
  joinUrl,
  modelsFromWire,
  parseSseRecords,
  readDeepSeekEnv,
  toWireBody,
  type DeepSeekEnv,
} from './wire.ts'

/** `fetch` 的最小形状（可注入假实现）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** 已知模型的规格表（能力位是提示词装配的唯一来源，施工单 05 §4）。 */
export const DEEPSEEK_MODELS: readonly ModelSpec[] = [
  {
    id: 'deepseek-chat',
    providerId: 'deepseek',
    displayName: 'DeepSeek Chat',
    capabilities: { toolCall: true, image: false, reasoning: false },
    contextWindow: 64_000,
  },
  {
    id: 'deepseek-reasoner',
    providerId: 'deepseek',
    displayName: 'DeepSeek Reasoner',
    // 推理模型不支持 function calling：装配侧据 toolCall=false 裁掉工具段（T-LLM-006）
    capabilities: { toolCall: false, image: false, reasoning: true },
    contextWindow: 64_000,
  },
]

/** 构造选项。 */
export interface DeepSeekAdapterOptions {
  readonly apiKey?: string
  readonly baseUrl?: string
  /** 可注入的 fetch（默认全局 fetch）。 */
  readonly fetch?: FetchLike
  /** 模型表（默认 `DEEPSEEK_MODELS`）。 */
  readonly models?: readonly ModelSpec[]
}

export class DeepSeekAdapter implements LlmAdapter {
  private readonly apiKey: string | undefined
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly models: readonly ModelSpec[]

  /** 调用序号（`prepareCall` 的 id 用）。 */
  private calls = 0

  constructor(options: DeepSeekAdapterOptions = {}) {
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl ?? readDeepSeekEnv({}).baseUrl
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.models = options.models ?? DEEPSEEK_MODELS
  }

  providerInfo(): ProviderInfo {
    return {
      id: 'deepseek',
      displayName: 'DeepSeek（OpenAI 兼容）',
      capabilities: { toolCall: true, image: false, reasoning: true },
    }
  }

  /**
   * 列模型（`GET /models`）。
   *
   * @throws `BahError('llm-http-error')` 非 2xx
   */
  async listModels(): Promise<readonly ModelInfo[]> {
    const response = await this.fetchImpl(joinUrl(this.baseUrl, MODELS_PATH), {
      method: 'GET',
      headers: this.headers(),
    })
    if (!response.ok) {
      throw new BahError(
        'llm-http-error',
        `deepseek: GET /models 失败 HTTP ${response.status}`,
        { status: response.status },
      )
    }
    return modelsFromWire(await response.json())
  }

  /**
   * 模型规格（能力位的唯一来源）。
   *
   * @throws `BahError('llm-model-unknown')` 不在模型表里（不猜能力位）
   */
  resolveModel(modelId: string): ModelSpec {
    const model = this.models.find((candidate) => candidate.id === modelId)
    if (model === undefined) {
      throw new BahError(
        'llm-model-unknown',
        `deepseek: 不认识模型 ${modelId}（已知：${this.models.map((item) => item.id).join('、')}）`,
        { modelId },
      )
    }
    return model
  }

  /**
   * 绑定模型与参数（请求冻结）。
   *
   * @throws `BahError('llm-no-key')` 缺密钥（fail-loud：无密钥绝不静默降级成 mock）
   */
  prepareCall(request: LlmRequest): Promise<PreparedCall> {
    if (this.apiKey === undefined) {
      throw new BahError(
        'llm-no-key',
        'deepseek: 缺少 DEEPSEEK_API_KEY（密钥只从环境变量读取，不得写进仓库）',
      )
    }
    this.calls += 1
    const prepared: PreparedCall = Object.freeze({
      id: `deepseek-call-${this.calls}`,
      request,
      model: this.resolveModel(request.modelId),
      params: request.params ?? {},
    })
    return Promise.resolve(prepared)
  }

  /**
   * 流式请求（SSE）。
   *
   * 取消：`signal` 透传给 `fetch`；进入前已取消直接抛 `llm-aborted`。
   *
   * @throws `BahError('llm-aborted')` 调用已取消
   * @throws `BahError('llm-http-error')` 非 2xx 或响应没有 body
   * @throws `BahError('llm-wire-invalid')` SSE 分片不是合法 JSON
   */
  async *stream(call: PreparedCall, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    if (signal.aborted) {
      throw new BahError('llm-aborted', 'deepseek: 调用已取消（未发出请求）', {
        model: call.model.id,
      })
    }

    const response = await this.fetchImpl(joinUrl(this.baseUrl, CHAT_COMPLETIONS_PATH), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(toWireBody(call, true)),
      signal,
    })

    if (!response.ok) {
      const detail = await response.text()
      throw new BahError(
        'llm-http-error',
        `deepseek: POST /chat/completions 失败 HTTP ${response.status}${detail === '' ? '' : `：${truncate(detail)}`}`,
        { status: response.status },
      )
    }

    if (response.body === null) {
      throw new BahError('llm-http-error', 'deepseek: 响应没有 body（该端点不支持流式）')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done === true) break
      buffer += decoder.decode(value, { stream: true })

      const parsed = parseSseRecords(buffer)
      buffer = parsed.rest
      for (const record of parsed.records) {
        yield* chunksOfRecord(record)
      }
    }

    // 收尾：最后一条记录可能没有空行结尾（网络分片边界）
    if (buffer.trim() !== '') {
      yield* chunksOfRecord(buffer)
    }
  }

  /** 认证头（密钥只在这里出现，且不落日志）。 */
  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
    }
  }
}

/** 用环境变量构造（阶段 6 的 boot 走这条路径）。 */
export function createDeepSeekAdapter(
  env: Record<string, string | undefined> = process.env,
  options: Omit<DeepSeekAdapterOptions, 'apiKey' | 'baseUrl'> = {},
): DeepSeekAdapter {
  const config: DeepSeekEnv = readDeepSeekEnv(env)
  return new DeepSeekAdapter({ ...options, apiKey: config.apiKey, baseUrl: config.baseUrl })
}

/** 截断长文本（错误里塞整个响应体会把日志冲掉）。 */
function truncate(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}
