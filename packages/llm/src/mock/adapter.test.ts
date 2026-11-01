import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { assembleStream } from '../llm/assemble.ts'
import type { LlmMessage, StreamChunk } from '../llm/types.ts'
import { MOCK_MODEL, MOCK_USAGE, MockLlmAdapter } from './adapter.ts'
import {
  outcomeStep,
  reflectStep,
  resolveOutcome,
  resolveStep,
  resolveStepContent,
  textStep,
  toolCallStep,
  type MockToolOutcome,
} from './script.ts'

/** 把一条流收集成数组（断言"吐了什么、顺序如何"用）。 */
async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

describe('llm-mock', () => {
  it('按脚本出队：文本被切片、工具调用参数被分片，装配后与脚本一致', async () => {
    const adapter = new MockLlmAdapter({
      script: {
        steps: [
          textStep('你好，我是 BAH 银行智能体'),
          toolCallStep('call-1', 'transfer_money', { amount: 100, payee: '张三' }),
        ],
      },
      chunkSize: 4,
    })
    const signal = new AbortController().signal

    const first = await assembleStream(adapter.stream(await adapter.prepareCall({ modelId: MOCK_MODEL.id, messages: [] }), signal))
    expect(first.content).toEqual([{ kind: 'text', text: '你好，我是 BAH 银行智能体' }])
    expect(first.finishReason).toBe('stop')
    expect(first.usage).toEqual(MOCK_USAGE)

    const second = await assembleStream(adapter.stream(await adapter.prepareCall({ modelId: MOCK_MODEL.id, messages: [] }), signal))
    expect(second.finishReason).toBe('tool-calls')
    expect(second.toolCalls).toEqual([
      {
        callId: 'call-1',
        name: 'transfer_money',
        argsText: '{"amount":100,"payee":"张三"}',
        args: { amount: 100, payee: '张三' },
      },
    ])
  })

  it('分片大小可调（chunkSize 大于正文即单块），且每片都带块起始/结束标记', async () => {
    const adapter = new MockLlmAdapter({ script: { steps: [textStep('短')] }, chunkSize: 100 })
    const chunks = await collect(
      adapter.stream(await adapter.prepareCall({ modelId: 'mock-chat', messages: [] }), new AbortController().signal),
    )
    expect(chunks).toEqual([
      { kind: 'block-start', index: 0 },
      { kind: 'text-delta', index: 0, text: '短' },
      { kind: 'block-end', index: 0 },
      { kind: 'usage', ...MOCK_USAGE },
      { kind: 'finish', reason: 'stop' },
    ])
  })

  it('推理块按独立索引出片，装配后与文本分开（推理不进正文）', async () => {
    const adapter = new MockLlmAdapter({
      script: {
        steps: [{ content: [{ kind: 'reasoning', text: '先想清楚' }, { kind: 'text', text: '答' }] }],
      },
      chunkSize: 3,
    })
    const assembled = await assembleStream(
      adapter.stream(await adapter.prepareCall({ modelId: 'mock-chat', messages: [] }), new AbortController().signal),
    )
    expect(assembled.content).toEqual([
      { kind: 'text', text: '答' },
      { kind: 'reasoning', text: '先想清楚' },
    ])
  })

  it('脚本用完还来要 → 抛 mock-script-exhausted（不静默返回空回复）', async () => {
    const adapter = new MockLlmAdapter({ script: { steps: [textStep('只有一步')] } })
    const signal = new AbortController().signal
    await assembleStream(adapter.stream(await adapter.prepareCall({ modelId: 'mock-chat', messages: [] }), signal))

    await expect(
      (async () => {
        await assembleStream(adapter.stream(await adapter.prepareCall({ modelId: 'mock-chat', messages: [] }), signal))
      })(),
    ).rejects.toThrow(/脚本已用完/)
  })

  it('不支持的块显式抛错，不静默丢上下文', async () => {
    const adapter = new MockLlmAdapter({
      script: { steps: [{ content: [{ kind: 'image', mimeType: 'image/png', data: 'x' }] }] },
    })
    await expect(
      (async () => {
        await assembleStream(adapter.stream(await adapter.prepareCall({ modelId: 'mock-chat', messages: [] }), new AbortController().signal))
      })(),
    ).rejects.toThrow(/不支持脚本化 image 块/)
  })

  it('进入前已取消 → llm-aborted（不开始流式）', async () => {
    const adapter = new MockLlmAdapter({ script: { steps: [textStep('x')] } })
    const prepared = await adapter.prepareCall({ modelId: 'mock-chat', messages: [] })
    const controller = new AbortController()
    controller.abort()

    await expect(collect(adapter.stream(prepared, controller.signal))).rejects.toThrow(
      /调用已取消（未开始流式）/,
    )
  })

  it('块之间取消 → 吐 finish(aborted) 收尾（半截流也有结束原因）', async () => {
    const adapter = new MockLlmAdapter({
      script: {
        steps: [
          {
            content: [
              { kind: 'text', text: '先说一句' },
              { kind: 'tool-call', id: 'call-1', name: 'transfer_money', args: { amount: 1 } },
            ],
          },
        ],
      },
      chunkSize: 5,
    })
    const prepared = await adapter.prepareCall({ modelId: 'mock-chat', messages: [] })
    const controller = new AbortController()
    const iterator = adapter.stream(prepared, controller.signal)[Symbol.asyncIterator]()

    const head = await iterator.next()
    expect(head.value).toEqual({ kind: 'block-start', index: 0 })

    controller.abort()
    const rest: StreamChunk[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done === true) break
      rest.push(next.value)
    }

    expect(rest.at(-1)).toEqual({ kind: 'finish', reason: 'aborted' })
    // 取消后不再上报 usage（这笔调用没有正常完成）
    expect(rest.some((chunk) => chunk.kind === 'usage')).toBe(false)
  })

  it('providerInfo / listModels / resolveModel 与 providerId 选项一致', async () => {
    const adapter = new MockLlmAdapter({ script: { steps: [] }, providerId: 'mock-b' })
    expect(adapter.providerInfo()).toEqual({
      id: 'mock-b',
      displayName: 'llm-mock：脚本化确定性 provider（离线演示与回放共用）',
      capabilities: { toolCall: true, image: false, reasoning: true },
    })
    expect(await adapter.listModels()).toEqual([MOCK_MODEL])
    expect(adapter.resolveModel('mock-chat').providerId).toBe('mock-b')
    expect(() => adapter.resolveModel('nope')).toThrowError(BahError)
  })

  it('prepareCall 冻结请求（阶段 5 的"请求冻结"由此保证）', async () => {
    const adapter = new MockLlmAdapter({ script: { steps: [] } })
    const prepared = await adapter.prepareCall({ modelId: 'mock-chat', messages: [], params: { temperature: 0 } })

    expect(Object.isFrozen(prepared)).toBe(true)
    expect(prepared.id).toBe('mock-call-1')
    expect(prepared.params).toEqual({ temperature: 0 })
  })
})

describe('MockScript 脚本原语', () => {
  it('缺省值：内容为空、结束原因 stop、无 usage', () => {
    expect(resolveStepContent({})).toEqual({ content: [], finishReason: 'stop' })
    expect(resolveStepContent({ content: [], finishReason: 'length', usage: { input: 1, output: 1 } })).toEqual({
      content: [],
      finishReason: 'length',
      usage: { input: 1, output: 1 },
    })
  })

  it('游标越界即抛（脚本长度写进理由，便于定位用例）', () => {
    expect(() => resolveStep({ steps: [textStep('a')] }, 1)).toThrowError(/脚本共 1 步/)
  })
})

describe('条件收尾步（文案由本 turn 的工具结局决定）', () => {
  const closing = { ok: '已完成', failed: '未执行：{reason}' }

  it('成功出 ok；失败出 failed 并把 {reason} 换成工具给的理由', () => {
    expect(resolveOutcome(closing, [{ name: 'transfer_create', isError: false }])).toEqual([
      { kind: 'text', text: '已完成' },
    ])
    expect(
      resolveOutcome(closing, [
        { name: 'transfer_create', isError: true, reason: '审批未通过（cancelled）', code: 'approval-cancelled' },
      ]),
    ).toEqual([{ kind: 'text', text: '未执行：审批未通过（cancelled）' }])
  })

  it('无理由文本退到理由码，两者皆缺退到固定兜底（不许留空占位符）', () => {
    expect(resolveOutcome(closing, [{ name: 't', isError: true, code: 'tool-timeout' }])).toEqual([
      { kind: 'text', text: '未执行：tool-timeout' },
    ])
    expect(resolveOutcome(closing, [{ name: 't', isError: true }])).toEqual([
      { kind: 'text', text: '未执行：工具未执行' },
    ])
  })

  it('理由里的 `$` 不被 replace 的特殊序列吃掉', () => {
    expect(resolveOutcome(closing, [{ name: 't', isError: true, reason: '超出日限额 $1000' }])).toEqual([
      { kind: 'text', text: '未执行：超出日限额 $1000' },
    ])
  })

  it('未绑定 tool 取最后一条结局；绑定后只看该工具（别的工具失败不牵连）', () => {
    const results: MockToolOutcome[] = [
      { name: 'transfer_create', isError: false },
      { name: 'sms_send', isError: true, reason: '渠道不可用' },
    ]
    expect(resolveOutcome(closing, results)).toEqual([{ kind: 'text', text: '未执行：渠道不可用' }])
    expect(resolveOutcome({ ...closing, tool: 'transfer_create' }, results)).toEqual([
      { kind: 'text', text: '已完成' },
    ])
  })

  it('okFromResult：成功时原样引用工具正文（票据/地址不抄第二份）', () => {
    const withResult = { ...closing, okFromResult: true }
    expect(
      resolveOutcome(withResult, [
        { name: 'password_change', isError: false, text: '安全页 /secure/password?ticket=pwd%3Ac-1' },
      ]),
    ).toEqual([{ kind: 'text', text: '安全页 /secure/password?ticket=pwd%3Ac-1' }])

    // 结果没有正文时退回 ok：不能把空串当权威结论念给用户
    expect(resolveOutcome(withResult, [{ name: 'password_change', isError: false }])).toEqual([
      { kind: 'text', text: '已完成' },
    ])
    expect(
      resolveOutcome(withResult, [{ name: 'password_change', isError: false, text: '   ' }]),
    ).toEqual([{ kind: 'text', text: '已完成' }])

    // 失败仍然走 failed + 理由，不因为看结果正文就把失败说成成功
    expect(
      resolveOutcome(withResult, [
        { name: 'password_change', isError: true, reason: '缺少审批票据', text: 'x' },
      ]),
    ).toEqual([{ kind: 'text', text: '未执行：缺少审批票据' }])
  })

  it('没有可依据的结局即抛——宁可起不来，也不编一句「已完成」', () => {
    expect(() => resolveOutcome(closing, [])).toThrowError(/没有可依据的工具结局/)
    expect(() =>
      resolveOutcome({ ...closing, tool: 'transfer_create' }, [{ name: 'balance_query', isError: false }]),
    ).toThrowError(/工具 transfer_create 未执行过/)
  })

  it('adapter 走 outcome 步：注入的结局决定收尾文本，形状与固定步一致', async () => {
    const results: MockToolOutcome[] = [
      { name: 'transfer_create', isError: true, reason: '审批未通过（cancelled）', code: 'approval-cancelled' },
    ]
    const adapter = new MockLlmAdapter({
      script: {
        steps: [toolCallStep('call-1', 'transfer_create', { amount: 800 }), outcomeStep(closing)],
      },
      toolOutcomes: () => results,
      chunkSize: 100,
    })
    const signal = new AbortController().signal
    const request = { modelId: 'mock-chat', messages: [] }

    await collect(adapter.stream(await adapter.prepareCall(request), signal))
    const closingMessage = await assembleStream(
      adapter.stream(await adapter.prepareCall(request), signal),
    )
    expect(closingMessage.content).toEqual([{ kind: 'text', text: '未执行：审批未通过（cancelled）' }])
    expect(closingMessage.finishReason).toBe('stop')
  })

  it('没有注入读口时 outcome 步同样即抛（缺读口不等于缺结局可以糊过去）', async () => {
    const adapter = new MockLlmAdapter({ script: { steps: [outcomeStep(closing)] } })
    const prepared = await adapter.prepareCall({ modelId: 'mock-chat', messages: [] })
    await expect(
      collect(adapter.stream(prepared, new AbortController().signal)),
    ).rejects.toThrowError(BahError)
  })
})

/** 复述步（`reflect`）：把工具结果正文原样引用，adapter 与 outcome 共用同一注入读口。 */
describe('复述步走 resolveReflect（adapter.stream）', () => {
  it('第 0 步即复述：把注入的工具结果正文一字不改地吐出来', async () => {
    const results: MockToolOutcome[] = [
      { name: 'account_balance', isError: false, text: '活期余额 1,234.56 元' },
    ]
    const adapter = new MockLlmAdapter({
      script: { steps: [reflectStep({ tool: 'account_balance', fallback: '没查到' })] },
      toolOutcomes: () => results,
      chunkSize: 100,
    })
    const assembled = await assembleStream(
      adapter.stream(await adapter.prepareCall({ modelId: 'mock-chat', messages: [] }), new AbortController().signal),
    )
    expect(assembled.content).toEqual([{ kind: 'text', text: '活期余额 1,234.56 元' }])
  })
})

/** 构造缺省项校验：既不写死脚本来源，也不允许 plan 悄悄退化成"没规划"。 */
describe('构造与 plan 模式的两条错误/步进路径', () => {
  const user = (text: string): LlmMessage => ({ role: 'user', content: [{ kind: 'text', text }] })
  const assistant = (): LlmMessage => ({ role: 'assistant', content: [{ kind: 'text', text: '……' }] })

  async function firstText(adapter: MockLlmAdapter, messages: readonly LlmMessage[]): Promise<string> {
    const assembled = await assembleStream(
      adapter.stream(await adapter.prepareCall({ modelId: 'mock-chat', messages }), new AbortController().signal),
    )
    const block = assembled.content[0]
    return block?.kind === 'text' ? block.text : ''
  }

  it('既不给 script 也不给 plan → 抛 mock-source-missing（构造期即拒，不留半残适配器）', () => {
    let caught: unknown
    try {
      new MockLlmAdapter({})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BahError)
    expect((caught as BahError).code).toBe('mock-source-missing')
  })

  it('plan 没规划出任何步骤 → 抛 mock-plan-empty（空步骤不是"沉默的合法回复"）', async () => {
    const adapter = new MockLlmAdapter({ plan: () => [] })
    const prepared = await adapter.prepareCall({ modelId: 'mock-chat', messages: [user('随便')] })
    let caught: unknown
    try {
      await collect(adapter.stream(prepared, new AbortController().signal))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BahError)
    expect((caught as BahError).code).toBe('mock-plan-empty')
  })

  it('plan 步号按 assistantTurnsSinceUser 推进：本轮第几条 assistant 就出第几步', async () => {
    const adapter = new MockLlmAdapter({
      plan: () => [textStep('第一步'), textStep('第二步')],
      chunkSize: 100,
    })
    // 真实用户消息之后 0 条 assistant → 第 0 步
    expect(await firstText(adapter, [user('查下余额')])).toBe('第一步')
    // 已产生 1 条 assistant → 第 1 步
    expect(await firstText(adapter, [user('查下余额'), assistant()])).toBe('第二步')
  })

  it('plan 越界夹在末步：一次 turn 多被叫一次不该让演示崩掉', async () => {
    const adapter = new MockLlmAdapter({
      plan: () => [textStep('唯一一步')],
      chunkSize: 100,
    })
    // 3 条 assistant 远超步数，仍取最后一步而不是抛错（plan 模式有意比固定脚本宽容）
    expect(await firstText(adapter, [user('查下余额'), assistant(), assistant(), assistant()])).toBe('唯一一步')
  })
})
