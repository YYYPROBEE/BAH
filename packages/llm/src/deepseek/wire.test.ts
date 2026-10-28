import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import type { LlmMessage, PreparedCall, ToolSpec } from '../llm/types.ts'
import {
  DEFAULT_BASE_URL,
  chunksOfRecord,
  fromWireChunk,
  joinUrl,
  modelsFromWire,
  parseSseRecords,
  readDeepSeekEnv,
  toWireBody,
  toWireMessages,
  toWireTools,
} from './wire.ts'

/** 一个最小 prepared call（wire 映射只关心 request/model/params）。 */
function prepared(overrides: Partial<PreparedCall> = {}): PreparedCall {
  return {
    id: 'deepseek-call-1',
    request: { modelId: 'deepseek-chat', messages: [{ role: 'user', content: [{ kind: 'text', text: '你好' }] }] },
    model: {
      id: 'deepseek-chat',
      providerId: 'deepseek',
      capabilities: { toolCall: true, image: false, reasoning: false },
    },
    params: {},
    ...overrides,
  }
}

const TRANSFER_TOOL: ToolSpec = {
  name: 'transfer_money',
  description: '转账',
  schema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
}

describe('wire 映射（施工单 05 §2.1）', () => {
  it('四种角色各自映射；assistant 带工具调用时 content 为 null', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: [{ kind: 'text', text: '身份' }] },
      { role: 'user', content: [{ kind: 'text', text: '转账 100' }] },
      {
        role: 'assistant',
        content: [{ kind: 'tool-call', id: 'call-1', name: 'transfer_money', args: { amount: 100 } }],
      },
      { role: 'tool', content: [{ kind: 'text', text: '{"ok":true}' }], toolCallId: 'call-1', name: 'transfer_money' },
    ]

    expect(toWireMessages(messages)).toEqual([
      { role: 'system', content: '身份' },
      { role: 'user', content: '转账 100' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'transfer_money', arguments: '{"amount":100}' } },
        ],
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1', name: 'transfer_money' },
    ])
  })

  it('推理块不回灌 wire（重放会污染下一轮）', () => {
    expect(
      toWireMessages([
        {
          role: 'assistant',
          content: [
            { kind: 'reasoning', text: '内部推理' },
            { kind: 'text', text: '结论' },
          ],
        },
      ]),
    ).toEqual([{ role: 'assistant', content: '结论' }])
  })

  it('不支持的块显式抛错（丢一张图等于篡改上下文）', () => {
    expect(() =>
      toWireMessages([{ role: 'user', content: [{ kind: 'image', mimeType: 'image/png', data: 'x' }] }]),
    ).toThrowError(/不支持的块 image/)
    expect(
      () =>
        toWireMessages([
          { role: 'user', content: [{ kind: 'file', mimeType: 'a/b', name: 'f', data: 'x' }] },
        ]),
    ).toThrowError(BahError)
  })

  it('工具消息缺 toolCallId / 非 assistant 带工具调用 → llm-wire-invalid', () => {
    expect(() => toWireMessages([{ role: 'tool', content: [{ kind: 'text', text: 'x' }] }])).toThrowError(
      /必须带 toolCallId/,
    )
    expect(() =>
      toWireMessages([
        { role: 'user', content: [{ kind: 'tool-call', id: 'c', name: 'n', args: {} }] },
      ]),
    ).toThrowError(/user 消息不允许携带工具调用/)
  })

  it('未知角色走 assertNever（负控）', () => {
    expect(() =>
      toWireMessages([{ role: 'ghost', content: [] } as unknown as LlmMessage]),
    ).toThrowError(/llm-wire-role/)
  })

  it('工具描述映射；空数组不产生 tools 字段', () => {
    expect(toWireTools(undefined)).toBeUndefined()
    expect(toWireTools([])).toBeUndefined()
    expect(toWireTools([TRANSFER_TOOL])).toEqual([
      {
        type: 'function',
        function: { name: 'transfer_money', description: '转账', parameters: TRANSFER_TOOL.schema },
      },
    ])
  })

  it('请求体：stream 恒 true 且带 include_usage；参数按需映射', () => {
    const body = toWireBody(
      prepared({
        request: {
          modelId: 'deepseek-chat',
          messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
          tools: [TRANSFER_TOOL],
        },
        params: { temperature: 0.2, maxTokens: 512, topP: 0.9, stop: ['\n'] },
      }),
      true,
    )

    expect(body).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 512,
      top_p: 0.9,
      stop: ['\n'],
    })
    expect(body['tools']).toHaveLength(1)
  })

  it('请求体：无参数、无工具时不留空字段；非流式不带 stream_options', () => {
    const body = toWireBody(prepared(), false)
    expect(body).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
    })
  })

  it('环境变量：缺省端点、空串当未设置', () => {
    expect(readDeepSeekEnv({})).toEqual({ baseUrl: DEFAULT_BASE_URL })
    expect(readDeepSeekEnv({ DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: '' })).toEqual({
      baseUrl: DEFAULT_BASE_URL,
    })
    expect(readDeepSeekEnv({ DEEPSEEK_API_KEY: 'sk-x', DEEPSEEK_BASE_URL: 'https://e' })).toEqual({
      apiKey: 'sk-x',
      baseUrl: 'https://e',
    })
  })

  it('joinUrl 处理尾部斜杠', () => {
    expect(joinUrl('https://e/', '/models')).toBe('https://e/models')
    expect(joinUrl('https://e', '/models')).toBe('https://e/models')
  })
})

describe('SSE 解析', () => {
  it('按空行切记录，尾巴留给下一批字节', () => {
    expect(parseSseRecords('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual({
      records: ['data: {"a":1}', 'data: {"b":2}'],
      rest: '',
    })
    expect(parseSseRecords('data: {"a":1}\n\ndata: {"b"')).toEqual({
      records: ['data: {"a":1}'],
      rest: 'data: {"b"',
    })
  })

  it('[DONE] 与心跳返回空；坏 JSON 抛 llm-wire-invalid', () => {
    expect(chunksOfRecord('data: [DONE]')).toEqual([])
    expect(chunksOfRecord(': keep-alive')).toEqual([])
    expect(() => chunksOfRecord('data: {oops')).toThrowError(/SSE data 不是合法 JSON/)
  })

  it('多行 data 拼接后解析（SSE 规范允许跨行）', () => {
    expect(chunksOfRecord('data: {"choices":\ndata: []}')).toEqual([])
  })

  it('一个分片映射出文本/推理/工具调用/usage/finish', () => {
    expect(
      fromWireChunk({
        choices: [
          {
            delta: {
              content: '好的',
              reasoning_content: '想',
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'transfer_money', arguments: '{"a":' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    ).toEqual([
      { kind: 'usage', input: 11, output: 7 },
      { kind: 'text-delta', index: 0, text: '好的' },
      { kind: 'reasoning-delta', index: 1, text: '想' },
      { kind: 'tool-call-delta', index: 2, id: 'call-1', name: 'transfer_money', argsText: '{"a":' },
      { kind: 'finish', reason: 'tool-calls' },
    ])
  })

  it('usage 里带 prompt_cache_hit_tokens 时映射成 cachedInput；不带就不编 0', () => {
    expect(
      fromWireChunk({
        choices: [],
        usage: { prompt_tokens: 1_000, completion_tokens: 50, prompt_cache_hit_tokens: 800 },
      }),
    ).toEqual([{ kind: 'usage', input: 1_000, output: 50, cachedInput: 800 }])

    // 老兼容端点不上报该字段：缺省 ≠ "命中 0"，计费层要能区分
    const bare = fromWireChunk({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    })
    expect(bare).toEqual([{ kind: 'usage', input: 10, output: 2 }])
  })

  it('未知结束原因退化成 stop（不猜 error）；content_filter 判 error', () => {
    const reasonOf = (finish: string): unknown =>
      fromWireChunk({ choices: [{ delta: {}, finish_reason: finish }] })[0];

    expect(reasonOf('weird')).toEqual({ kind: 'finish', reason: 'stop' })
    expect(reasonOf('content_filter')).toEqual({ kind: 'finish', reason: 'error' })
    expect(reasonOf('length')).toEqual({ kind: 'finish', reason: 'length' })
  })

  it('缺 choices / 空 delta 时只出该出的片；非对象 payload 抛错', () => {
    expect(fromWireChunk({})).toEqual([])
    expect(fromWireChunk({ choices: [] })).toEqual([])
    expect(fromWireChunk({ choices: [{ delta: { content: '' } }] })).toEqual([])
    expect(fromWireChunk({ choices: [{ delta: { tool_calls: [null, { index: 1 }] } }] })).toEqual([
      { kind: 'tool-call-delta', index: 3 },
    ])
    expect(() => fromWireChunk('nope')).toThrowError(/不是 JSON 对象/)
  })
})

describe('模型清单解析', () => {
  it('取 data[].id；非数组当空，条目非对象跳过', () => {
    expect(modelsFromWire({ data: [{ id: 'a' }, { id: 1 }, null, { id: 'b' }] })).toEqual([
      { id: 'a' },
      { id: 'b' },
    ])
    expect(modelsFromWire({})).toEqual([])
    expect(() => modelsFromWire(null)).toThrowError(/\/models 响应不是 JSON 对象/)
  })
})
