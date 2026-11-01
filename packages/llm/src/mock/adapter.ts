/**
 * llm-mock：确定性 provider。
 *
 * 三个用途，一个实现：
 * 1. **无密钥跑通完整 turn**（阶段 5 的主循环集成测试、阶段 6 的 headless 验收）；
 * 2. 离线演示（现场网络/密钥不可用的兜底）；
 * 3. 回放测试的基础。
 *
 * 确定性纪律：不读时钟、不读随机数、不发网络请求；同一个脚本 + 同一串输入 → 逐片相同。
 * 分片切法也是确定性的（按 `chunkSize` 等分），所以"增量拼接"路径每次都被真实走到。
 */

import { BahError } from '@bah/util'

import { assistantTurnsSinceUser } from '../llm/turns.ts'

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
import {
  resolveOutcome,
  resolveReflect,
  resolveStep,
  resolveStepContent,
  type MockScript,
  type MockStep,
  type MockToolOutcome,
} from './script.ts'

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
  /** 固定脚本（按调用次序出队）。与 `plan` 二选一。 */
  readonly script?: MockScript
  /**
   * 按请求现算脚本（**读 `request.messages`**，不看游标）。
   *
   * 这是"离线但不当磁带"的那条路：同一份适配器，用户问什么就规划什么，
   * 而不是不管问什么都吐同一段。演示兜底用它（见 `@bah/llm/demo`）。
   */
  readonly plan?: (request: LlmRequest) => readonly MockStep[]
  /** provider id（默认 `mock`；同进程要装多个 mock 时区分用）。 */
  readonly providerId?: string
  /** 可用模型（默认 `MOCK_MODEL`）。 */
  readonly models?: readonly ModelSpec[]
  /** 每步上报的用量（默认 `MOCK_USAGE`）。 */
  readonly usage?: CallUsage
  /** 文本/参数 JSON 的切片大小（默认 8 字符；调大即验证"单块"路径）。 */
  readonly chunkSize?: number
  /**
   * 本会话见过的工具结局（条件收尾步的唯一依据）。
   *
   * 由宿主注入（`core:model` 订阅 `session/event` 的 `tool/result`）；缺省为空——
   * 没有读口时脚本可以照跑固定步，但写 `outcome` 步会因 `mock-outcome-absent` 立刻暴露。
   */
  readonly toolOutcomes?: () => readonly MockToolOutcome[]
}

export class MockLlmAdapter implements LlmAdapter {
  private readonly script: MockScript | undefined
  private readonly plan: ((request: LlmRequest) => readonly MockStep[]) | undefined
  private readonly providerId: string
  private readonly models: readonly ModelSpec[]
  private readonly usage: CallUsage
  private readonly chunkSize: number
  private readonly toolOutcomes: () => readonly MockToolOutcome[]

  /** 脚本游标：每次 `stream` 消费一步（`plan` 模式不用它）。 */
  private cursor = 0

  /** 调用序号（`prepareCall` 的 id 用）。 */
  private calls = 0

  constructor(options: MockAdapterOptions) {
    if (options.script === undefined && options.plan === undefined) {
      throw new BahError(
        'mock-source-missing',
        'mock: 必须给 script（固定脚本）或 plan（按请求现算）之一',
        {},
      )
    }
    this.script = options.script
    this.plan = options.plan
    this.providerId = options.providerId ?? 'mock'
    this.models = options.models ?? [MOCK_MODEL]
    this.usage = options.usage ?? MOCK_USAGE
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
    this.toolOutcomes = options.toolOutcomes ?? (() => [])
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

    const step = this.stepFor(call.request)
    const resolved = resolveStepContent(step)
    const results = this.toolOutcomes()
    const content =
      step.outcome !== undefined
        ? resolveOutcome(step.outcome, results)
        : step.reflect !== undefined
          ? resolveReflect(step.reflect, results)
          : resolved.content

    let toolIndex = 0
    for (const block of content) {
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

    yield { kind: 'usage', ...(resolved.usage ?? this.usage) }
    yield { kind: 'finish', reason: resolved.finishReason }
  }

  /**
   * 取本次调用该出的那一步。
   *
   * 两条路：
   * - 固定脚本：按游标出队（回放与用例靠它保证逐字节确定性）；
   * - `plan`：**读 `request.messages`**，按"本轮已经产生了几条 assistant 消息"定位步骤。
   *   这是"不当磁带"的关键——出什么话由消息决定，而不是由第几次调用决定。
   *
   * `plan` 模式下越界取最后一**步**而不是抛错：一次 turn 里模型多被叫一次
   * （比如工具结果触发了额外推理）不该让演示崩掉；固定脚本仍然严格抛错，
   * 因为那里越界就说明用例写错了。
   */
  private stepFor(request: LlmRequest): MockStep {
    if (this.plan !== undefined) {
      const steps = this.plan(request)
      if (steps.length === 0) {
        throw new BahError('mock-plan-empty', 'mock: plan 没有规划出任何步骤', {})
      }
      const index = Math.min(assistantTurnsSinceUser(request.messages), steps.length - 1)
      return steps[index]!
    }
    const step = resolveStep(this.script!, this.cursor)
    this.cursor += 1
    return step
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

/**
 * 本轮已经产生了几条 assistant 消息（从最后一条**真实用户消息**往后数）。
 *
 * 实现在 `../llm/turns.ts`：它要跳过平台注入的 `runtimeContext`（那条也是 user），
 * 否则每个 step 都会把计数清零，模型永远停在第 1 步。
 */

