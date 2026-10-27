import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { assembleStream } from '../llm/assemble.ts'
import type { StreamChunk } from '../llm/types.ts'
import {
  DEEPSEEK_MODELS,
  DeepSeekAdapter,
  createDeepSeekAdapter,
  type FetchLike,
  type RetryInfo,
} from './adapter.ts'

/** 把若干字符串片段封成 SSE 响应体（模拟网络分片边界）。 */
function sseBody(parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}

/** 记录请求的假 fetch。 */
function recordingFetch(respond: () => Response): { fetch: FetchLike; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) })
    return Promise.resolve(respond())
  }
  return { fetch: fetchImpl, calls }
}

/** 永不返回分片的响应：abort 时让流报错，用于超时/取消路径。 */
function hangingFetch(): FetchLike {
  return (_url, init) =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
          },
        }),
        { status: 200 },
      ),
    )
}

/** 一条完整的成功流（文本 + 工具调用 + 结束原因 + usage）。 */
const HAPPY_PARTS = [
  'data: {"choices":[{"delta":{"content":"好的"}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"transfer_money","arguments":"{\\"amount\\":100}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"usage":{"prompt_tokens":30,"completion_tokens":12}}\n\n',
  'data: [DONE]\n\n',
]

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

describe('DeepSeekAdapter（施工单 05 §2.1，注入假 fetch）', () => {
  it('SSE 流式：文本与工具调用参数增量正确装配，usage 与结束原因到位', async () => {
    const { fetch, calls } = recordingFetch(
      () => new Response(sseBody(HAPPY_PARTS), { status: 200 }),
    )
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test', fetch })
    const prepared = await adapter.prepareCall({
      modelId: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ kind: 'text', text: '转账 100' }] }],
    })

    const assembled = await assembleStream(adapter.stream(prepared, new AbortController().signal))

    expect(assembled.content).toEqual([
      { kind: 'text', text: '好的' },
      { kind: 'tool-call', id: 'call-1', name: 'transfer_money', args: { amount: 100 } },
    ])
    expect(assembled.finishReason).toBe('tool-calls')
    expect(assembled.usage).toEqual({ input: 30, output: 12 })

    // 请求面：POST 到 /chat/completions，带 Bearer 密钥与 stream:true
    expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions')
    expect(calls[0]!.init?.method).toBe('POST')
    expect((calls[0]!.init?.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test')
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ model: 'deepseek-chat', stream: true })
  })

  it('尾部记录没有空行结尾也能被吃掉（网络最后一次分片不完整）', async () => {
    const { fetch } = recordingFetch(
      () => new Response(sseBody(['data: {"choices":[{"delta":{"content":"尾巴"}}]}']), { status: 200 }),
    )
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test', fetch })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const chunks = await collect(adapter.stream(prepared, new AbortController().signal))
    expect(chunks).toEqual([{ kind: 'text-delta', index: 0, text: '尾巴' }])
  })

  it('非 2xx 抛 llm-http-error：message 只带状态码，响应片段进 detail', async () => {
    const { fetch } = recordingFetch(() => new Response('invalid api key', { status: 401 }))
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-bad', fetch })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })

    const error = await collect(adapter.stream(prepared, new AbortController().signal)).catch(
      (thrown: unknown) => thrown,
    )
    expect(error).toMatchObject({
      code: 'llm-http-error',
      message: expect.stringMatching(/HTTP 401$/),
      detail: { status: 401, body: 'invalid api key' },
    })
  })

  it('响应没有 body → 明确报错（该端点不支持流式）', async () => {
    const { fetch } = recordingFetch(() => new Response(null, { status: 200 }))
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test', fetch })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })

    await expect(collect(adapter.stream(prepared, new AbortController().signal))).rejects.toThrow(
      /响应没有 body/,
    )
  })

  it('坏 SSE 分片 → llm-wire-invalid（不静默跳过）', async () => {
    const { fetch } = recordingFetch(
      () => new Response(sseBody(['data: {oops\n\n']), { status: 200 }),
    )
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test', fetch })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })

    await expect(collect(adapter.stream(prepared, new AbortController().signal))).rejects.toThrow(
      /SSE data 不是合法 JSON/,
    )
  })

  it('配了计价表 → usage 分片带 costMicroYuan；缓存部分按缓存单价计', async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response(
          sseBody([
            'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000000,"completion_tokens":0,"prompt_cache_hit_tokens":400000}}\n\n',
          ]),
          { status: 200 },
        ),
    )
    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test',
      fetch,
      models: [
        {
          id: 'deepseek-chat',
          providerId: 'deepseek',
          capabilities: { toolCall: true, image: false, reasoning: false },
          // 1 ¥/Mtok 输入、0.1 ¥/Mtok 缓存命中、2 ¥/Mtok 输出（单位：微分）
          pricing: { inputPerMTok: 1_000_000, cachedInputPerMTok: 100_000, outputPerMTok: 2_000_000 },
        },
      ],
    })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const chunks = await collect(adapter.stream(prepared, new AbortController().signal))

    const usage = chunks.find((chunk) => chunk.kind === 'usage')
    // 未命中 60 万 × 1 ¥ + 命中 40 万 × 0.1 ¥ = 0.64 ¥ = 640000 微分
    expect(usage).toEqual({
      kind: 'usage',
      input: 1_000_000,
      output: 0,
      cachedInput: 400_000,
      costMicroYuan: 640_000,
    })
  })

  it('未配计价表 → 不报价（costMicroYuan 缺省，不编 0 冒充"免费"）', async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response(
          sseBody([
            'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
          ]),
          { status: 200 },
        ),
    )
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test', fetch })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const chunks = await collect(adapter.stream(prepared, new AbortController().signal))

    expect(chunks.find((chunk) => chunk.kind === 'usage')).toEqual({
      kind: 'usage',
      input: 10,
      output: 2,
    })
  })

  it('进入前已取消 → llm-aborted，且不发请求', async () => {
    const { fetch, calls } = recordingFetch(() => new Response(sseBody([]), { status: 200 }))
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test', fetch })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const controller = new AbortController()
    controller.abort()

    await expect(collect(adapter.stream(prepared, controller.signal))).rejects.toThrow(
      /调用已取消（未发出请求）/,
    )
    expect(calls).toHaveLength(0)
  })

  it('整次请求超时 → llm-timeout（phase=request），不无限等待上游', async () => {
    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test',
      fetch: hangingFetch(),
      requestTimeoutMs: 10,
      idleTimeoutMs: 1_000,
    })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const error = await collect(adapter.stream(prepared, new AbortController().signal)).catch(
      (thrown: unknown) => thrown,
    )
    expect(error).toMatchObject({ code: 'llm-timeout', detail: { phase: 'request' } })
  })

  it('分片间静默超时 → llm-timeout（phase=idle）', async () => {
    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test',
      fetch: hangingFetch(),
      requestTimeoutMs: 1_000,
      idleTimeoutMs: 10,
    })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const error = await collect(adapter.stream(prepared, new AbortController().signal)).catch(
      (thrown: unknown) => thrown,
    )
    expect(error).toMatchObject({ code: 'llm-timeout', detail: { phase: 'idle' } })
  })

  it('用户取消传播到读流 → llm-aborted（不是超时）', async () => {
    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test',
      fetch: hangingFetch(),
      requestTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 5)
    const error = await collect(adapter.stream(prepared, controller.signal)).catch(
      (thrown: unknown) => thrown,
    )
    expect(error).toMatchObject({ code: 'llm-aborted' })
  })

  it('缺密钥：adapter 可构造，但 prepareCall 必须 fail-loud（不静默降级成 mock）', async () => {
    const adapter = new DeepSeekAdapter({})
    expect(adapter.providerInfo().id).toBe('deepseek')
    expect(() => adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })).toThrow(
      /缺少 DEEPSEEK_API_KEY/,
    )
  })

  it('listModels 走 GET /models 并取 data[].id；非 2xx 抛错', async () => {
    const ok = recordingFetch(
      () => new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 }),
    )
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test', fetch: ok.fetch })
    expect(await adapter.listModels()).toEqual([{ id: 'deepseek-chat' }])
    expect(ok.calls[0]!.url).toBe('https://api.deepseek.com/models')

    const bad = recordingFetch(() => new Response('', { status: 500 }))
    const failing = new DeepSeekAdapter({ apiKey: 'sk-test', fetch: bad.fetch })
    await expect(failing.listModels()).rejects.toThrow(/GET \/models 失败 HTTP 500/)
  })

  it('resolveModel 只认已知模型（能力位不猜）', () => {
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test' })
    expect(adapter.resolveModel('deepseek-reasoner').capabilities).toEqual({
      toolCall: false,
      image: false,
      reasoning: true,
    })
    expect(() => adapter.resolveModel('gpt-9')).toThrowError(BahError)
    expect(adapter.listModels).toBeTypeOf('function')
    expect(DEEPSEEK_MODELS).toHaveLength(2)
  })

  it('createDeepSeekAdapter 从环境变量取密钥与端点（密钥只从 env 来）', async () => {
    const { fetch, calls } = recordingFetch(
      () => new Response(sseBody(['data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n']), { status: 200 }),
    )
    const adapter = createDeepSeekAdapter(
      { DEEPSEEK_API_KEY: 'sk-env', DEEPSEEK_BASE_URL: 'https://proxy.example/v1' },
      { fetch },
    )
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    await assembleStream(adapter.stream(prepared, new AbortController().signal))

    expect(calls[0]!.url).toBe('https://proxy.example/v1/chat/completions')
    expect((calls[0]!.init?.headers as Record<string, string>)['authorization']).toBe('Bearer sk-env')
  })

  it('providerInfo 声明能力上限', () => {
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test' })
    expect(adapter.providerInfo()).toEqual({
      id: 'deepseek',
      displayName: 'DeepSeek（OpenAI 兼容）',
      capabilities: { toolCall: true, image: false, reasoning: true },
    })
  })
})

/** 按序列返回响应（末项重复）；返回已调用次数。 */
function sequenceFetch(
  responses: readonly (() => Response)[],
): { fetch: FetchLike; calls: () => number } {
  let index = 0
  const fetchImpl: FetchLike = () => {
    const respond = responses[Math.min(index, responses.length - 1)]!
    index += 1
    return Promise.resolve(respond())
  }
  return { fetch: fetchImpl, calls: () => index }
}

describe('DeepSeekAdapter · 429 / 5xx 同模型退避（C04 判据二）', () => {
  const okBody = (): Response =>
    new Response(
      sseBody(['data: {"choices":[{"delta":{"content":"稳"},"finish_reason":"stop"}]}\n\n']),
      { status: 200 },
    )

  it('429 → 优先按 retry-after 退避后成功（只重试一次）', async () => {
    const delays: number[] = []
    const retries: RetryInfo[] = []
    const { fetch, calls } = sequenceFetch([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      okBody,
    ])
    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test',
      fetch,
      retryMax: 2,
      retryBaseMs: 10,
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
      onRetry: (info) => retries.push(info),
    })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const chunks = await collect(adapter.stream(prepared, new AbortController().signal))

    expect(chunks).toEqual([
      { kind: 'text-delta', index: 0, text: '稳' },
      { kind: 'finish', reason: 'stop' },
    ])
    expect(calls()).toBe(2)
    expect(delays).toEqual([1_000])
    expect(retries).toEqual([{ attempt: 1, status: 429, delayMs: 1_000 }])
  })

  it('5xx 指数退避并受单次上限约束；耗尽 retryMax 后抛 llm-http-error', async () => {
    const delays: number[] = []
    const { fetch, calls } = sequenceFetch([() => new Response('boom', { status: 503 })])
    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test',
      fetch,
      retryMax: 2,
      retryBaseMs: 10,
      retryMaxDelayMs: 15,
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
    })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const error = await collect(adapter.stream(prepared, new AbortController().signal)).catch(
      (thrown: unknown) => thrown,
    )

    expect(calls()).toBe(3)
    expect(delays).toEqual([10, 15])
    expect(error).toMatchObject({ code: 'llm-http-error', detail: { status: 503 } })
  })

  it('401 是确定性失败：一次就抛，不重试', async () => {
    const delays: number[] = []
    const { fetch, calls } = sequenceFetch([() => new Response('bad key', { status: 401 })])
    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-bad',
      fetch,
      retryMax: 2,
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
    })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const error = await collect(adapter.stream(prepared, new AbortController().signal)).catch(
      (thrown: unknown) => thrown,
    )

    expect(calls()).toBe(1)
    expect(delays).toEqual([])
    expect(error).toMatchObject({ code: 'llm-http-error', detail: { status: 401 } })
  })

  it('retryMax=0：显式关闭重试', async () => {
    const { fetch, calls } = sequenceFetch([() => new Response('busy', { status: 429 })])
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test', fetch, retryMax: 0 })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })

    await expect(collect(adapter.stream(prepared, new AbortController().signal))).rejects.toThrow(
      /HTTP 429/,
    )
    expect(calls()).toBe(1)
  })

  /**
   * 为什么补：取消有两个时点——进入 `stream()` 之前（已有用例）与**退避等待期间**。
   * 后者此前没有覆盖：用户在退避里按下取消，若循环顶部不复检信号，就会再发一次
   * 已经无人等待的请求（计费/审计上多一条，重试预算也被烧掉）。
   */
  it('退避期间被取消 → 不再发第二次请求，抛 llm-aborted', async () => {
    const controller = new AbortController()
    let calls = 0
    const fetchImpl: FetchLike = () => {
      calls += 1
      return Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }))
    }
    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test',
      fetch: fetchImpl,
      retryMax: 2,
      retryBaseMs: 10,
      sleep: () => Promise.resolve(),
      // 退避回调正是"第一次响应已到、第二次请求未发"的那一刻
      onRetry: () => controller.abort(),
    })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const error = await collect(adapter.stream(prepared, controller.signal)).catch(
      (thrown: unknown) => thrown,
    )

    expect(calls).toBe(1)
    expect(error).toMatchObject({ code: 'llm-aborted' })
  })

  /**
   * 为什么补：生产装配不注入 `sleep`，走的是 `setTimeout` 缺省实现；
   * 此前所有重试用例都替换了 `sleep`，这条**唯一在线上生效**的等待分支从未执行。
   * `retry-after: 0` 让它以零延迟跑完，不拖慢用例。
   */
  it('未注入 sleep 时走默认退避实现（retry-after=0 不挂进程）', async () => {
    const { fetch, calls } = sequenceFetch([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      okBody,
    ])
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test', fetch, retryMax: 2, retryBaseMs: 10 })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })
    const chunks = await collect(adapter.stream(prepared, new AbortController().signal))

    expect(calls()).toBe(2)
    expect(chunks.at(-1)).toEqual({ kind: 'finish', reason: 'stop' })
  })
})

describe('DeepSeekAdapter · 未注入 fetch 时的默认出口', () => {
  // 生产装配（`createDeepSeekAdapter(process.env)`）不传 fetch，走的是
  // `options.fetch ?? ((input, init) => fetch(input, init))` 这一支。
  // 单测此前一律注入假 fetch，导致这条**唯一在线上生效**的分支从未被执行。
  // 这里把 globalThis.fetch 换成假实现来驱动它，不产生真实网络请求。
  it('省略 fetch 选项时委托给全局 fetch', async () => {
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response(sseBody(HAPPY_PARTS), { status: 200 })
    }) as typeof globalThis.fetch

    try {
      const adapter = new DeepSeekAdapter({ apiKey: 'sk-default-fetch' })
      const prepared = await adapter.prepareCall({
        modelId: 'deepseek-chat',
        messages: [{ role: 'user', content: [{ kind: 'text', text: '转账 100' }] }],
      })
      const assembled = await assembleStream(adapter.stream(prepared, new AbortController().signal))

      expect(assembled.content[0]).toEqual({ kind: 'text', text: '好的' })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toBe('https://api.deepseek.com/chat/completions')
    } finally {
      globalThis.fetch = original
    }
  })
})
