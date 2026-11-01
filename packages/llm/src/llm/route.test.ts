import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { MockLlmAdapter } from '../mock/adapter.ts'
import { textStep } from '../mock/script.ts'
import { assembleStream } from './assemble.ts'
import { LlmAdapterRegistry } from './registry.ts'
import type { AttemptRecord } from './route.ts'
import { FallbackRunner } from './route.ts'
import type { LlmAdapter, ModelCapabilities, PreparedCall } from './types.ts'

const CAPS: ModelCapabilities = { toolCall: true, image: false, reasoning: false }

/** 会在指定阶段失败的 adapter（`prepare` = 还没出流就挂，`stream` = 出流第一步就挂）。 */
function brokenAdapter(id: string, where: 'prepare' | 'stream', error: Error): LlmAdapter {
  return {
    providerInfo: () => ({ id, displayName: id, capabilities: CAPS }),
    listModels: () => Promise.resolve([]),
    resolveModel: (modelId) => ({ id: modelId, providerId: id, capabilities: CAPS }),
    prepareCall:
      where === 'prepare'
        ? () => Promise.reject(error)
        : (request) =>
            Promise.resolve<PreparedCall>({
              id: `${id}-1`,
              request,
              model: { id: request.modelId, providerId: id, capabilities: CAPS },
              params: request.params ?? {},
            }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw error
    },
  }
}

/** 一个什么都不吐的 adapter（用于覆盖"首片为空"的分支）。 */
function emptyAdapter(id: string): LlmAdapter {
  return {
    ...brokenAdapter(id, 'stream', new Error('unused')),
    // eslint-disable-next-line require-yield
    async *stream() {
      return
    },
  }
}

describe('FallbackRunner', () => {
  it('T-LLM-005 降级链：备用模型接管，assistant/attempt 落账（failed + retried 两条）', async () => {
    const registry = new LlmAdapterRegistry()
    registry.register(brokenAdapter('primary', 'prepare', new BahError('llm-http-error', 'HTTP 429 限流')))
    registry.register(new MockLlmAdapter({ script: { steps: [textStep('备用模型接管')] } }))

    const records: AttemptRecord[] = []
    const runner = new FallbackRunner({
      registry,
      chain: ['primary:m1', 'mock:mock-chat'],
      sink: { attempt: (record) => records.push(record) },
    })

    const run = await runner.run({ modelId: 'm1', messages: [] }, new AbortController().signal)
    const assembled = await assembleStream(run.chunks)

    expect(run.model.id).toBe('mock-chat')
    expect(assembled.content).toEqual([{ kind: 'text', text: '备用模型接管' }])

    // 降级不可静默：必须能还原"为什么换了模型"
    expect(records.map((record) => record.status)).toEqual(['failed', 'retried'])
    expect(records[0]!.reason).toContain('HTTP 429 限流')
    expect(records[1]!.reason).toBe('primary:m1 → mock:mock-chat')
  })

  it('出流第一步才失败的 provider 也能降级（401/限流常在读流时才暴露）', async () => {
    const registry = new LlmAdapterRegistry()
    registry.register(brokenAdapter('primary', 'stream', new BahError('llm-http-error', 'HTTP 401')))
    registry.register(new MockLlmAdapter({ script: { steps: [textStep('ok')] } }))

    const records: AttemptRecord[] = []
    const runner = new FallbackRunner({
      registry,
      chain: ['primary:m1', 'mock:mock-chat'],
      sink: { attempt: (record) => records.push(record) },
    })
    const run = await runner.run({ modelId: 'm1', messages: [] }, new AbortController().signal)

    expect((await assembleStream(run.chunks)).content).toEqual([{ kind: 'text', text: 'ok' }])
    expect(records.map((record) => record.status)).toEqual(['failed', 'retried'])
  })

  it('链上全挂 → llm-all-models-failed，理由里带每个模型的原因', async () => {
    const registry = new LlmAdapterRegistry()
    registry.register(brokenAdapter('a', 'prepare', new BahError('llm-http-error', 'a 挂了')))
    registry.register(brokenAdapter('b', 'prepare', new BahError('llm-http-error', 'b 也挂了')))

    const records: AttemptRecord[] = []
    const runner = new FallbackRunner({
      registry,
      chain: ['a:m', 'b:m'],
      sink: { attempt: (record) => records.push(record) },
    })

    await expect(runner.run({ modelId: 'm', messages: [] }, new AbortController().signal)).rejects.toThrow(
      /a:m: .*a 挂了.* \| b:m: .*b 也挂了/,
    )
    expect(records.map((record) => record.status)).toEqual(['failed', 'retried', 'failed'])
  })

  it('空链属 misconfiguration：载入后第一次调用即失败', async () => {
    const runner = new FallbackRunner({ registry: new LlmAdapterRegistry(), chain: [] })
    await expect(runner.run({ modelId: 'm', messages: [] }, new AbortController().signal)).rejects.toThrow(
      /降级链为空/,
    )
  })

  it('自定义判定说"不值得换模型"时立刻失败，不再试备用', async () => {
    const registry = new LlmAdapterRegistry()
    registry.register(brokenAdapter('a', 'prepare', new BahError('llm-http-error', '参数错误，重试无用')))
    registry.register(new MockLlmAdapter({ script: { steps: [textStep('不该到这里')] } }))

    const records: AttemptRecord[] = []
    const runner = new FallbackRunner({
      registry,
      chain: ['a:m', 'mock:mock-chat'],
      sink: { attempt: (record) => records.push(record) },
      isRetryable: () => false,
    })

    await expect(runner.run({ modelId: 'm', messages: [] }, new AbortController().signal)).rejects.toThrow(
      /没有可用模型/,
    )
    expect(records.map((record) => record.status)).toEqual(['failed'])
  })

  it('取消不重试：cancelled 落账 + llm-aborted', async () => {
    const registry = new LlmAdapterRegistry()
    registry.register(new MockLlmAdapter({ script: { steps: [textStep('不该到这里')] } }))

    const controller = new AbortController()
    controller.abort()

    const records: AttemptRecord[] = []
    const runner = new FallbackRunner({
      registry,
      chain: ['mock:mock-chat'],
      sink: { attempt: (record) => records.push(record) },
    })

    await expect(runner.run({ modelId: 'mock-chat', messages: [] }, controller.signal)).rejects.toThrow(
      /调用已取消（取消不重试）/,
    )
    expect(records).toEqual([{ status: 'cancelled', reason: 'mock:mock-chat: 调用已取消' }])
  })

  it('流中途取消（provider 抛 AbortError）也判 cancelled 而不是降级', async () => {
    const registry = new LlmAdapterRegistry()
    const abortError = new Error('aborted by user')
    abortError.name = 'AbortError'
    registry.register(brokenAdapter('a', 'stream', abortError))

    const records: AttemptRecord[] = []
    const runner = new FallbackRunner({
      registry,
      chain: ['a:m'],
      sink: { attempt: (record) => records.push(record) },
    })

    await expect(runner.run({ modelId: 'm', messages: [] }, new AbortController().signal)).rejects.toThrow(
      /没有可用模型/,
    )
    expect(records.map((record) => record.status)).toEqual(['failed', 'cancelled'])
  })

  it('provider 一个字都不吐时 run 也照样返回（空流由装配器判"未收尾"）', async () => {
    const registry = new LlmAdapterRegistry()
    registry.register(emptyAdapter('silent'))
    const runner = new FallbackRunner({ registry, chain: ['silent:m'] })

    const run = await runner.run({ modelId: 'm', messages: [] }, new AbortController().signal)
    const chunks: unknown[] = []
    for await (const chunk of run.chunks) chunks.push(chunk)
    expect(chunks).toEqual([])
  })

  it('sink 可省略（仅单测场景）；非 Error 抛出物也能留文本', async () => {
    const registry = new LlmAdapterRegistry()
    const weird: LlmAdapter = {
      ...brokenAdapter('weird', 'prepare', new Error('placeholder')),
      prepareCall: () => Promise.reject('字符串异常'),
    }
    registry.register(weird)

    const runner = new FallbackRunner({ registry, chain: ['weird:m'] })
    await expect(runner.run({ modelId: 'm', messages: [] }, new AbortController().signal)).rejects.toThrow(
      /字符串异常/,
    )
  })
})
