/**
 * llm-mock-server 自测：
 * 录制不改行为、回放逐字节还原、场景漂移（模型/次数变了）必须 fail-loud。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  LlmAdapter,
  LlmRequest,
  ModelSpec,
  PreparedCall,
  ProviderInfo,
  StreamChunk,
} from '@bah/llm'

import { captureRejection, captureThrown } from '../assertions/index.ts'

import {
  ReplayAdapter,
  createRecordingAdapter,
  readExchanges,
  writeExchanges,
  type Exchange,
} from './index.ts'

/** 录制时的模型规格。 */
const SPEC: ModelSpec = {
  id: 'mock-chat',
  providerId: 'mock',
  displayName: 'Mock Chat',
  capabilities: { toolCall: true, image: false, reasoning: true },
  contextWindow: 32_000,
}

/** 一次"响应"的分片序列（形状与真实 provider 一致：start → delta → end → usage → finish）。 */
const CHUNKS: readonly StreamChunk[] = [
  { kind: 'block-start', index: 0 },
  { kind: 'text-delta', index: 0, text: '你' },
  { kind: 'text-delta', index: 0, text: '好' },
  { kind: 'block-end', index: 0 },
  { kind: 'usage', input: 10, output: 2 },
  { kind: 'finish', reason: 'stop' },
]

/** 夹具适配器：按给定分片吐流（可指定抛错 / 模型 id 不符）。 */
class FixtureAdapter implements LlmAdapter {
  constructor(
    private readonly chunksList: readonly (readonly StreamChunk[])[],
    private readonly spec: ModelSpec = SPEC,
  ) {}

  providerInfo(): ProviderInfo {
    return { id: this.spec.providerId, displayName: 'fixture', capabilities: this.spec.capabilities }
  }

  listModels(): Promise<readonly ModelSpec[]> {
    return Promise.resolve([this.spec])
  }

  resolveModel(modelId: string): ModelSpec {
    if (modelId !== this.spec.id) throw new Error(`fixture: 不认识 ${modelId}`)
    return this.spec
  }

  prepareCall(request: LlmRequest): Promise<PreparedCall> {
    return Promise.resolve(
      Object.freeze({ id: `fixture-${request.modelId}`, request, model: this.spec, params: request.params ?? {} }),
    )
  }

  async *stream(): AsyncIterable<StreamChunk> {
    for (const chunks of this.chunksList) {
      yield* chunks
      return
    }
  }
}

/** 收集流式分片。 */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 造一次调用（`messages` 必填，测试里给空历史即可）。 */
async function prepare(
  adapter: LlmAdapter,
  request: Partial<LlmRequest> = {},
): Promise<PreparedCall> {
  return adapter.prepareCall({ messages: [], ...request, modelId: request.modelId ?? SPEC.id })
}

describe('录制：createRecordingAdapter', () => {
  it('分片原样透传，并把一次调用记成一条 Exchange', async () => {
    const recorded: Exchange[] = []
    const adapter = createRecordingAdapter(new FixtureAdapter([CHUNKS]), (exchange) =>
      recorded.push(exchange),
    )

    const call = await prepare(adapter, { modelId: SPEC.id, params: { temperature: 0 } })
    const streamed = await collect(adapter.stream(call, new AbortController().signal))

    expect(streamed).toEqual(CHUNKS)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ index: 0, provider: 'mock', model: 'mock-chat' })
    expect(recorded[0]?.chunks).toEqual(CHUNKS)
    expect(recorded[0]?.params).toEqual({ temperature: 0 })
  })

  it('代理 providerInfo / listModels / resolveModel / prepareCall（录制不改变行为）', async () => {
    const adapter = createRecordingAdapter(new FixtureAdapter([CHUNKS]), () => {})
    expect(adapter.providerInfo()).toEqual(new FixtureAdapter([CHUNKS]).providerInfo())
    await expect(adapter.listModels()).resolves.toHaveLength(1)
    expect(adapter.resolveModel(SPEC.id)).toBe(SPEC)
    await expect(prepare(adapter)).resolves.toMatchObject({ id: `fixture-${SPEC.id}` })
  })
})

describe('回放：ReplayAdapter', () => {
  const exchange: Exchange = { index: 0, provider: 'mock', model: 'mock-chat', params: {}, chunks: CHUNKS }

  it('按序吐回分片，remaining / consumed 可观察', async () => {
    const adapter = new ReplayAdapter({ exchanges: [exchange], spec: SPEC })
    expect(adapter.consumed()).toBe(0)
    expect(adapter.remaining()).toBe(1)

    const call = await prepare(adapter)
    expect(await collect(adapter.stream(call, new AbortController().signal))).toEqual(CHUNKS)
    expect(adapter.consumed()).toBe(1)
    expect(adapter.remaining()).toBe(0)
  })

  it('providerInfo / listModels / resolveModel 都来自录制的模型规格', async () => {
    const adapter = new ReplayAdapter({ exchanges: [exchange], spec: SPEC })
    expect(adapter.providerInfo()).toMatchObject({ id: 'mock', capabilities: SPEC.capabilities })
    await expect(adapter.listModels()).resolves.toEqual([SPEC])
    expect(adapter.resolveModel(SPEC.id)).toBe(SPEC)

    const error = captureThrown(() => adapter.resolveModel('deepseek-chat'))
    expect(error.code).toBe('llm-model-unknown')
    expect(error.message).toContain('mock-chat')
  })

  it('响应不够放 → replay-exhausted（场景变了必须重录）', async () => {
    const adapter = new ReplayAdapter({ exchanges: [], spec: SPEC })
    const call = await prepare(adapter)

    const error = await captureRejection(() => collect(adapter.stream(call, new AbortController().signal)))
    expect(error.code).toBe('replay-exhausted')
    expect(error.message).toContain('必须重录')
  })

  it('现场请求的模型与录制不一致 → replay-model-mismatch', async () => {
    // 录制里是 mock-chat，现场却用 other-model 起适配器 → 第 1 次调用就对不上
    const other: ModelSpec = { ...SPEC, id: 'other-model' }
    const adapter = new ReplayAdapter({ exchanges: [exchange], spec: other })
    const call = await prepare(adapter)

    const error = await captureRejection(() => collect(adapter.stream(call, new AbortController().signal)))
    expect(error.code).toBe('replay-model-mismatch')
  })

  it('开始前已取消 → llm-aborted；流中途取消 → finish(aborted) 收尾', async () => {
    const adapter = new ReplayAdapter({ exchanges: [exchange], spec: SPEC })
    const call = await prepare(adapter)

    const aborted = new AbortController()
    aborted.abort()
    const error = await captureRejection(() => collect(adapter.stream(call, aborted.signal)))
    expect(error.code).toBe('llm-aborted')

    const midStream = new AbortController()
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(call, midStream.signal)) {
      chunks.push(chunk)
      if (chunks.length === 2) midStream.abort()
    }
    expect(chunks.at(-1)).toEqual({ kind: 'finish', reason: 'aborted' })
  })
})

describe('exchange 文件读写', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bah-exchange-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('JSONL roundtrip（按 index 排序）', () => {
    const path = join(dir, 'llm.jsonl')
    const exchanges: Exchange[] = [
      { index: 0, provider: 'mock', model: 'mock-chat', params: {}, chunks: CHUNKS },
      { index: 1, provider: 'mock', model: 'mock-chat', params: { maxTokens: 8 }, chunks: CHUNKS },
    ]

    writeExchanges(path, exchanges)

    expect(readExchanges(path)).toEqual(exchanges)
  })

  it('坏 JSON / 形状不对 → snapshot-invalid', () => {
    const path = join(dir, 'bad.jsonl')
    writeFileSync(path, '{ not json\n', 'utf8')
    expect(captureThrown(() => readExchanges(path)).code).toBe('snapshot-invalid')

    writeFileSync(path, '{"index":0}\n', 'utf8')
    expect(captureThrown(() => readExchanges(path)).code).toBe('snapshot-invalid')
  })

  it('写盘要求 index 从 0 连续递增（否则读不回来）', () => {
    const path = join(dir, 'gap.jsonl')
    const error = captureThrown(() =>
      writeExchanges(path, [{ index: 3, provider: 'mock', model: 'mock-chat', params: {}, chunks: [] }]),
    )
    expect(error.code).toBe('snapshot-invalid')
  })
})
