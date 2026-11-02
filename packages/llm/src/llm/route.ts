/**
 * 路由与降级链。
 *
 * 三条硬规则：
 * 1. **只在"还没吐出任何分片"时降级**——已经流给用户的半句话没法撤回，
 *    那种情况如实报错，让主循环落 `assistant/attempt(failed)`；
 * 2. 每次失败都 `sink.attempt(...)`（落账 `assistant/attempt`），一次成功降级 = 两条留痕
 *    （`failed` 说明原因、`retried` 说明改用了谁），审计能还原"为什么换了模型"；
 * 3. 取消**不重试**：用户按了停，换模型继续跑是违背意图。
 */

import { BahError, reasonOf } from '@bah/util'

import type { LlmAdapterRegistry } from './registry.ts'
import type { LlmRequest, ModelSpec, PreparedCall, StreamChunk } from './types.ts'

/** 一次尝试的结局（与 `assistant/attempt` 会话事件的 `status` 同形）。 */
export type AttemptStatus = 'failed' | 'retried' | 'cancelled'

/** 尝试记录（落账单位）。 */
export interface AttemptRecord {
  readonly status: AttemptStatus
  /** 可读理由（失败原因 / 降级去向 / 取消）。 */
  readonly reason?: string
}

/** 落账面：主循环把它接成 `session.append('assistant/attempt', ...)`。 */
export interface AttemptSink {
  attempt(record: AttemptRecord): void
}

/** 降级器配置。 */
export interface FallbackRunnerOptions {
  readonly registry: LlmAdapterRegistry
  /** 有序模型链（主 → 备）；长度 ≥ 1，空链即 misconfiguration。 */
  readonly chain: readonly string[]
  /** 落账面（缺省 = 不留痕，仅供单测；生产必须给）。 */
  readonly sink?: AttemptSink
  /** 自定义"是否值得换模型"的判定（缺省：除取消外都值得）。 */
  readonly isRetryable?: (error: unknown) => boolean
}

/** 一次可用的流式调用。 */
export interface FallbackRun {
  readonly prepared: PreparedCall
  readonly model: ModelSpec
  /** 已含首个分片的流（首个分片在 `run` 内已取到，用于判定是否真能出流）。 */
  readonly chunks: AsyncIterable<StreamChunk>
}

export class FallbackRunner {
  private readonly registry: LlmAdapterRegistry
  private readonly chain: readonly string[]
  private readonly sink: AttemptSink | undefined
  private readonly isRetryable: (error: unknown) => boolean

  constructor(options: FallbackRunnerOptions) {
    this.registry = options.registry
    this.chain = options.chain
    this.sink = options.sink
    this.isRetryable = options.isRetryable ?? ((error) => !isAborted(error))
  }

  /**
   * 按链取一条可用流（成功即返回，失败按规则降级）。
   *
   * @throws `BahError('llm-aborted')` 调用前/中途被取消（取消不重试）
   * @throws `BahError('llm-all-models-failed')` 链上所有模型都失败，或首个失败不可重试
   * @throws `BahError('llm-chain-empty')` 链为空（misconfiguration）
   */
  async run(request: LlmRequest, signal: AbortSignal): Promise<FallbackRun> {
    const failures: string[] = []

    for (const [index, target] of this.chain.entries()) {
      if (signal.aborted) {
        this.sink?.attempt({ status: 'cancelled', reason: `${target}: 调用已取消` })
        throw new BahError('llm-aborted', 'llm: 调用已取消（取消不重试）', { model: target })
      }

      try {
        const { adapter, model } = this.registry.resolve(target)
        const prepared = await adapter.prepareCall({ ...request, modelId: model.id })
        const iterator = adapter.stream(prepared, signal)[Symbol.asyncIterator]()
        // 先取首个分片：provider 的 401/限流往往要到"真开始读流"才暴露
        const first = await iterator.next()
        return { prepared, model, chunks: drain(first, iterator) }
      } catch (error) {
        const message = reasonOf(error)
        failures.push(`${target}: ${message}`)
        this.sink?.attempt({ status: 'failed', reason: `${target}: ${message}` })

        const fatal = new BahError(
          'llm-all-models-failed',
          `llm: 没有可用模型（${failures.join(' | ')}）`,
          { failures, model: target },
        )

        // 取消：绝不换模型继续跑（违背用户意图）
        if (isAborted(error)) {
          this.sink?.attempt({ status: 'cancelled', reason: `${target}: 调用已取消` })
          throw fatal
        }
        if (!this.isRetryable(error)) throw fatal

        const nextTarget = this.chain[index + 1]
        if (nextTarget === undefined) throw fatal

        this.sink?.attempt({ status: 'retried', reason: `${target} → ${nextTarget}` })
      }
    }

    // 非空链的所有失败路径都在循环内抛出，只有"链为空"会走到这里
    throw new BahError('llm-chain-empty', 'llm: 降级链为空（至少需要一个模型）')
  }
}

/** 已取到首个分片的流：先吐它，再接着吐剩余部分。 */
async function* drain(
  first: IteratorResult<StreamChunk>,
  rest: AsyncIterator<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  if (first.done === true) return
  yield first.value
  while (true) {
    const next = await rest.next()
    if (next.done === true) return
    yield next.value
  }
}

/** 是否取消（`BahError('llm-aborted')` 或平台 `AbortError`）。 */
function isAborted(error: unknown): boolean {
  if (error instanceof BahError) return error.code === 'llm-aborted'
  return error instanceof Error && error.name === 'AbortError'
}

