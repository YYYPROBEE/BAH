/**
 * llm-mock：确定性 provider（施工单 05 §2.2）。
 *
 * 三个用途，一个实现：
 * 1. **无密钥跑通完整 turn**（阶段 5 的主循环集成测试、阶段 6 的 headless 验收）；
 * 2. 离线演示（现场网络/密钥不可用的兜底）；
 * 3. 回放测试的基础（施工单 12）。
 *
 * 确定性纪律：不读时钟、不读随机数、不发网络请求；同一个脚本 + 同一串输入 → 逐片相同。
 * 分片切法也是确定性的（按 `chunkSize` 等分），所以"增量拼接"路径每次都被真实走到。
 */

import { BahError } from '@bah/util'

import type {
  CallUsage,
  ContentBlock,
  LlmAdapter,
  LlmRequest,
  ModelInfo,
  ModelSpec,
  PreparedCall,
  ProviderInfo,
  StreamChunk,
} from '../llm/types.ts'
import { resolveStep, resolveStepContent, type MockScript } from './script.ts'

/** mock 的默认模型（能力位齐全，除图片）。 */
export const MOCK_MODEL: ModelSpec = {
  id: 'mock-chat',
  providerId: 'mock',
  displayName: 'Mock Chat（确定性脚本）',
  capabilities: { toolCall: true, image: false, reasoning: true },
  contextWindow: 32_000,
}

/** mock 的默认用量（每步都报同一份，成本账本用例不依赖 provider 差异）。 */
export const MOCK_USAGE: CallUsage = { input: 100, output: 20 }

/** 分片大小缺省值（字符数）。 */
const DEFAULT_CHUNK_SIZE = 8

/** 构造选项。 */
export interface MockAdapterOptions {
  readonly script: MockScript
  /** provider id（默认 `mock`；同进程要装多个 mock 时区分用）。 */
  readonly providerId?: string
  /** 可用模型（默认 `MOCK_MODEL`）。 */
  readonly models?: readonly ModelSpec[]
  /** 每步上报的用量（默认 `MOCK_USAGE`）。 */
  readonly usage?: CallUsage
  /** 文本/参数 JSON 的切片大小（默认 8 字符；调大即验证"单块"路径）。 */
  readonly chunkSize?: number
}

export class MockLlmAdapter implements LlmAdapter {
  private readonly script: MockScript
  private readonly providerId: string
  private readonly models: readonly ModelSpec[]
  private readonly usage: CallUsage
  private readonly chunkSize: number

  /** 脚本游标：每次 `stream` 消费一步。 */
  private cursor = 0

  /** 调用序号（`prepareCall` 的 id 用）。 */
  private calls = 0

  constructor(options: MockAdapterOptions) {
    this.script = options.script
    this.providerId = options.providerId ?? 'mock'
    this.models = options.models ?? [MOCK_MODEL]
    this.usage = options.usage ?? MOCK_USAGE
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  }

  providerInfo(): ProviderInfo {
    return {
      id: this.providerId,
      displayName: 'llm-mock：脚本化确定性 provider（离线演示与回放共用）',
      capabilities: { toolCall: true, image: false, reasoning: true },
    }
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return Promise.resolve(this.models)
  }

  /**
   * 解析模型规格。
   *
   * @throws `BahError('llm-model-unknown')` 不在本 mock 的模型表里
   */
  resolveModel(modelId: string): ModelSpec {
    const model = this.models.find((candidate) => candidate.id === modelId)
    if (model === undefined) {
      throw new BahError('llm-model-unknown', `mock: 不认识模型 ${modelId}`, { modelId })
    }
    return { ...model, providerId: this.providerId }
  }

  /**
   * 绑定模型与参数（请求**冻结**）。
   *
   * mock 不做参数校验（真实 provider 的参数校验属 wire 层），只保证形状与不可变性。
   */
  prepareCall(request: LlmRequest): Promise<PreparedCall> {
    this.calls += 1
    const model = this.resolveModel(request.modelId)
    const prepared: PreparedCall = Object.freeze({
      id: `${this.providerId}-call-${this.calls}`,
      request,
      model,
      params: request.params ?? {},
    })
    return Promise.resolve(prepared)
  }

  /**
   * 按脚本吐分片。
   *
   * 分片顺序固定：`block-start` → 若干 delta → `block-end` → `usage` → `finish`。
   * 取消：进入前已取消直接抛 `llm-aborted`；块之间发现取消则吐 `finish(aborted)` 后收尾
   * （半截流也要有结束原因，否则装配器会判"流未收尾"）。
   */
  async *stream(call: PreparedCall, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    if (signal.aborted) {
      throw new BahError('llm-aborted', 'mock: 调用已取消（未开始流式）', { model: call.model.id })
    }

    const step = resolveStepContent(resolveStep(this.script, this.cursor))
    this.cursor += 1

    let toolIndex = 0
    for (const block of step.content) {
      if (signal.aborted) {
        yield { kind: 'finish', reason: 'aborted' }
        return
      }
      const index = this.indexOf(block, toolIndex)
      if (block.kind === 'tool-call') toolIndex += 1
      yield { kind: 'block-start', index }
      yield* this.blockChunks(index, block)
      yield { kind: 'block-end', index }
    }

    yield { kind: 'usage', ...(step.usage ?? this.usage) }
    yield { kind: 'finish', reason: step.finishReason }
  }

  /** 块索引：文本 0、推理 1、工具调用 2 起（与 `types.ts` 的约定一致）。 */
  private indexOf(block: ContentBlock, toolIndex: number): number {
    switch (block.kind) {
      case 'text':
        return 0
      case 'reasoning':
        return 1
      case 'tool-call':
        return 2 + toolIndex
      default:
        // mock 只脚本化这三类块；其余块（图片/文件/工具集增量）不参与流式断言
        return 0
    }
  }

  /** 单个块的分片序列。 */
  private *blockChunks(index: number, block: ContentBlock): Generator<StreamChunk> {
    switch (block.kind) {
      case 'text':
        for (const piece of slice(block.text, this.chunkSize)) {
          yield { kind: 'text-delta', index, text: piece }
        }
        return
      case 'reasoning':
        for (const piece of slice(block.text, this.chunkSize)) {
          yield { kind: 'reasoning-delta', index, text: piece }
        }
        return
      case 'tool-call': {
        const argsText = JSON.stringify(block.args ?? {})
        for (const [offset, piece] of slice(argsText, this.chunkSize).entries()) {
          yield {
            kind: 'tool-call-delta',
            index,
            // id / name 只在首个分片出现（与真实 provider 形态一致）
            ...(offset === 0 ? { id: block.id, name: block.name } : {}),
            argsText: piece,
          }
        }
        return
      }
      default:
        throw new BahError(
          'mock-unsupported-block',
          `mock: 不支持脚本化 ${block.kind} 块（只支持 text / reasoning / tool-call）`,
          { kind: block.kind },
        )
    }
  }
}

/** 按固定大小切片（最后一片可短；空串产出零片）。 */
function slice(text: string, size: number): string[] {
  const step = Math.max(1, size)
  const pieces: string[] = []
  for (let offset = 0; offset < text.length; offset += step) {
    pieces.push(text.slice(offset, offset + step))
  }
  return pieces
}
