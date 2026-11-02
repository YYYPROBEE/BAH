/**
 * llm-mock-server：provider 请求-响应录制与回放。
 *
 * 两半：
 * - **录制**：`createRecordingAdapter(inner, sink)` 包在真实适配器外面，把每次调用的
 *   分片序列原样记下来（`Exchange`）。录制不改行为——调用方拿到的分片一字不差。
 * - **回放**：`ReplayAdapter` 按次序吐回录制好的分片，**不发网络请求、不读密钥**。
 *
 * 为什么记分片而不是记"重排后的 assistant 消息"：分片是 wire 层的事实，回放它才能让
 * 装配器（`assembleStream`）走**同一条代码路径**——否则回放只验证了后半段。
 *
 * 确定性：`Exchange` 里没有任何时间戳与随机数；同一份文件回放多少次都逐字节相同。
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { BahError } from '@bah/util'

import type {
  LlmAdapter,
  LlmParams,
  LlmRequest,
  ModelInfo,
  ModelSpec,
  PreparedCall,
  ProviderInfo,
  StreamChunk,
} from '@bah/llm'

/** 一次 provider 调用：请求的可核对标识 + 响应分片序列。 */
export interface Exchange {
  /** 调用序号（本文件内自 0 递增，回放按它排序）。 */
  readonly index: number
  /** 命中的 provider id（如 `mock`）。 */
  readonly provider: string
  /** 命中的模型 id（如 `mock-chat`）。 */
  readonly model: string
  /** 本次调用的采样参数（快照里保留，便于 diff 出"参数被改了"）。 */
  readonly params: LlmParams
  /** 原样录下的分片序列。 */
  readonly chunks: readonly StreamChunk[]
}

/**
 * 把适配器包成"录制中"的适配器。
 *
 * @param inner 真实适配器（mock 或 deepseek）
 * @param sink 每完成一次调用收到一条 `Exchange`（按完成顺序）
 */
export function createRecordingAdapter(inner: LlmAdapter, sink: (exchange: Exchange) => void): LlmAdapter {
  let index = 0

  return {
    providerInfo: (): ProviderInfo => inner.providerInfo(),
    listModels: () => inner.listModels(),
    resolveModel: (modelId: string) => inner.resolveModel(modelId),
    prepareCall: (request: LlmRequest) => inner.prepareCall(request),

    async *stream(call: PreparedCall, signal: AbortSignal): AsyncIterable<StreamChunk> {
      const chunks: StreamChunk[] = []
      for await (const chunk of inner.stream(call, signal)) {
        chunks.push(chunk)
        yield chunk
      }
      // 只在流正常收尾后记账：半截流（抛错）不构成一条可回放的响应
      sink({
        index,
        provider: call.model.providerId,
        model: call.model.id,
        params: call.params,
        chunks,
      })
      index += 1
    },
  }
}

/** 回放适配器的构造选项。 */
export interface ReplayAdapterOptions {
  /** 录制好的调用序列（按 `index` 升序）。 */
  readonly exchanges: readonly Exchange[]
  /** 录制时的模型规格（能力位决定提示词装配，必须与录制一致）。 */
  readonly spec: ModelSpec
}

/**
 * 回放适配器：不发网络请求，按次序吐回录制的分片。
 *
 * 纪律：
 * - 分片序列用完还来要 → `replay-exhausted`（说明场景对模型的调用次数变了，必须重录）；
 * - 现场请求的模型与录制不一致 → `replay-model-mismatch`（说明路由改了）。
 */
export class ReplayAdapter implements LlmAdapter {
  private readonly exchanges: readonly Exchange[]
  private readonly spec: ModelSpec
  private cursor = 0
  private calls = 0

  constructor(options: ReplayAdapterOptions) {
    this.exchanges = options.exchanges
    this.spec = options.spec
  }

  providerInfo(): ProviderInfo {
    return {
      id: this.spec.providerId,
      displayName: 'llm-mock-server：录制响应回放（无密钥、无网络）',
      capabilities: this.spec.capabilities,
    }
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return Promise.resolve([this.spec])
  }

  /**
   * 解析模型（只认录制时的那一个）。
   *
   * @throws `BahError('llm-model-unknown')` 现场请求的模型不在快照里
   */
  resolveModel(modelId: string): ModelSpec {
    if (modelId !== this.spec.id) {
      throw new BahError(
        'llm-model-unknown',
        `llm-mock-server: 快照只录了模型 ${this.spec.id}（现场请求 ${modelId}）；场景变了必须重录`,
        { recorded: this.spec.id, requested: modelId },
      )
    }
    return this.spec
  }

  prepareCall(request: LlmRequest): Promise<PreparedCall> {
    this.calls += 1
    return Promise.resolve(
      Object.freeze({
        id: `replay-call-${this.calls}`,
        request,
        model: this.spec,
        params: request.params ?? {},
      }),
    )
  }

  async *stream(call: PreparedCall, signal: AbortSignal): AsyncIterable<StreamChunk> {
    if (signal.aborted) {
      throw new BahError('llm-aborted', 'llm-mock-server: 调用已取消（回放未开始）', {
        model: call.model.id,
      })
    }

    const exchange = this.exchanges[this.cursor]
    if (exchange === undefined) {
      throw new BahError(
        'replay-exhausted',
        `llm-mock-server: 录制只有 ${this.exchanges.length} 次调用，第 ${this.cursor + 1} 次没有响应可放（场景变了必须重录）`,
        { recorded: this.exchanges.length, requested: this.cursor + 1 },
      )
    }
    if (exchange.model !== call.model.id) {
      throw new BahError(
        'replay-model-mismatch',
        `llm-mock-server: 第 ${this.cursor + 1} 次调用录的是 ${exchange.model}，现场要的是 ${call.model.id}`,
        { recorded: exchange.model, requested: call.model.id, index: this.cursor },
      )
    }
    this.cursor += 1

    for (const chunk of exchange.chunks) {
      if (signal.aborted) {
        // 与 mock provider 同形：半截流也要有结束原因，否则装配器判"流未收尾"
        yield { kind: 'finish', reason: 'aborted' }
        return
      }
      yield chunk
    }
  }

  /** 还剩几次没放（用例据此断言"录制的响应被消费完"）。 */
  remaining(): number {
    return this.exchanges.length - this.cursor
  }

  /** 已放了几次。 */
  consumed(): number {
    return this.cursor
  }
}

/**
 * 读 exchange 文件（JSONL，一行一条）。
 *
 * @throws `BahError('snapshot-invalid')` 某行不是合法 JSON / 形状不对
 */
export function readExchanges(path: string): readonly Exchange[] {
  const text = readFileSync(path, 'utf8')
  const exchanges: Exchange[] = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      throw new BahError('snapshot-invalid', `llm-mock-server: ${path} 第 ${index + 1} 行不是合法 JSON`, {
        path,
        line: index + 1,
      })
    }
    if (!isExchange(parsed)) {
      throw new BahError(
        'snapshot-invalid',
        `llm-mock-server: ${path} 第 ${index + 1} 行不是 Exchange（缺 chunks / model / index）`,
        { path, line: index + 1 },
      )
    }
    exchanges.push(parsed)
  }
  return exchanges.sort((left, right) => left.index - right.index)
}

/**
 * 写 exchange 文件（JSONL；一行一条，便于 `git diff` 看出"哪次调用变了"）。
 *
 * @throws `BahError('snapshot-invalid')` 序列不是按 `index` 递增（防止写出一份读不回来的文件）
 */
export function writeExchanges(path: string, exchanges: readonly Exchange[]): void {
  for (const [position, exchange] of exchanges.entries()) {
    if (exchange.index !== position) {
      throw new BahError(
        'snapshot-invalid',
        `llm-mock-server: 写盘要求 index 从 0 连续递增（第 ${position + 1} 条的 index=${exchange.index}）`,
        { path, position, index: exchange.index },
      )
    }
  }
  const lines = exchanges.map((exchange) => JSON.stringify(exchange))
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

/** 一行 JSON 是否像一条 `Exchange`。 */
function isExchange(value: unknown): value is Exchange {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['index'] === 'number' &&
    typeof record['provider'] === 'string' &&
    typeof record['model'] === 'string' &&
    Array.isArray(record['chunks'])
  )
}
