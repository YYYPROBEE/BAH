import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { assembleStream } from '../llm/assemble.ts'
import type { StreamChunk } from '../llm/types.ts'
import { DEEPSEEK_MODELS, DeepSeekAdapter, createDeepSeekAdapter, type FetchLike } from './adapter.ts'

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
