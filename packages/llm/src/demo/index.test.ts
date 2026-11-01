/**
 * `demo/index.ts` · `createDemoRouter`（离线演示适配器工厂）。
 *
 * 与 mock 的唯一区别：`script` 不传，步骤由 `plan` **按请求现算**。
 * 这组用例守的是"它不会当着人面答非所问"：
 * - 出厂配置必须对齐 `ROUTER_MODEL`（providerId / models / usage）；
 * - 同一个适配器问余额、问转账要产出不同规划（不是磁带）；
 * - `chunkSize` / `toolOutcomes` 两个可选参数传与不传都各走各的路。
 */

import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { assembleStream } from '../llm/assemble.ts'
import type { LlmMessage, StreamChunk } from '../llm/types.ts'
import { MOCK_USAGE } from '../mock/adapter.ts'
import type { MockToolOutcome } from '../mock/script.ts'
import { ROUTER_MODEL, createDemoRouter } from './index.ts'

/** 把一条流收集成数组。 */
async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

/** 跑一步并把流装配完整（越界/缺结果时会 reject）。 */
async function runOnce(adapter: ReturnType<typeof createDemoRouter>, messages: readonly LlmMessage[]) {
  const prepared = await adapter.prepareCall({ modelId: ROUTER_MODEL.id, messages })
  return assembleStream(adapter.stream(prepared, new AbortController().signal))
}

/** 造一条真实用户消息 / assistant 消息。 */
const user = (text: string): LlmMessage => ({ role: 'user', content: [{ kind: 'text', text }] })
const assistant = (): LlmMessage => ({ role: 'assistant', content: [{ kind: 'text', text: '……' }] })

describe('createDemoRouter 出厂配置', () => {
  it('providerId / models / usage 与 ROUTER_MODEL、MOCK_USAGE 对齐（缺省即演示默认）', async () => {
    const adapter = createDemoRouter()
    expect(adapter.providerInfo().id).toBe('router')
    expect(adapter.providerInfo().id).toBe(ROUTER_MODEL.providerId)
    expect(await adapter.listModels()).toEqual([ROUTER_MODEL])
    expect(adapter.resolveModel('router-chat')).toEqual(ROUTER_MODEL)

    // 缺省 usage = MOCK_USAGE：流末尾的 usage 分片如实上报
    const chunks = await runChunks(adapter, [user('帮我查下余额')])
    expect(chunks.find((chunk) => chunk.kind === 'usage')).toEqual({ kind: 'usage', ...MOCK_USAGE })
  })

  it('显式传 usage 时覆盖缺省（成本账本用例可注入自定义用量）', async () => {
    const adapter = createDemoRouter({ usage: { input: 7, output: 3 } })
    const chunks = await runChunks(adapter, [user('帮我查下余额')])
    expect(chunks.find((chunk) => chunk.kind === 'usage')).toEqual({ kind: 'usage', input: 7, output: 3 })
  })
})

describe('createDemoRouter 按请求现算步骤（不当磁带）', () => {
  it('同一个适配器：先问余额、再问转账 → 首步是不同的工具', async () => {
    const adapter = createDemoRouter()

    const balance = await runOnce(adapter, [user('帮我查下余额')])
    expect(balance.toolCalls[0]?.name).toBe('account_balance')

    const transfer = await runOnce(adapter, [user('给王建国转 800 元')])
    expect(transfer.toolCalls[0]?.name).toBe('transfer_preview')
    expect(transfer.toolCalls[0]?.args).toMatchObject({ amount: 800, payee: { name: '王建国' } })
  })

  it('认不出的问题 → 追问纯文本，一步且不调工具', async () => {
    const adapter = createDemoRouter()
    const clarify = await runOnce(adapter, [user('帮我写一首关于春天的诗')])
    expect(clarify.toolCalls).toHaveLength(0)
    expect(clarify.content[0]).toMatchObject({
      kind: 'text',
      text: expect.stringContaining('查账户余额'),
    })
  })

  it('跨轮 tool callId 不重复（会话投影按 callId 配对，重复会吞掉本轮 assistant）', async () => {
    const adapter = createDemoRouter()
    const first = await runOnce(adapter, [user('转 500 给他')])
    const second = await runOnce(adapter, [user('转 500 给他')])
    expect(first.toolCalls[0]?.callId).not.toBe(second.toolCalls[0]?.callId)
  })
})

describe('createDemoRouter 的可选参数两条路径', () => {
  it('不传 toolOutcomes：读到复述步（第 2 步）时因缺结果抛 mock-reflect-absent', async () => {
    const adapter = createDemoRouter()
    // 第 1 条 assistant 让步号推进到复述步（查余额的第二步）
    const prepared = await adapter.prepareCall({
      modelId: ROUTER_MODEL.id,
      messages: [user('帮我查下余额'), assistant()],
    })
    await expect(
      (async () => collect(adapter.stream(prepared, new AbortController().signal)))(),
    ).rejects.toThrowError(BahError)
  })

  it('传 toolOutcomes：复述步把工具给的权威余额原样念出', async () => {
    const results: MockToolOutcome[] = [
      { name: 'account_balance', isError: false, text: '活期余额 1,234.56 元' },
    ]
    const adapter = createDemoRouter({ toolOutcomes: () => results })
    const reflected = await runOnce(adapter, [user('帮我查下余额'), assistant()])
    expect(reflected.content).toEqual([{ kind: 'text', text: '活期余额 1,234.56 元' }])
  })

  it('不传 chunkSize 用缺省 8（长文本被切成多片），传大 chunkSize 则单片', async () => {
    // 认不出的短句 → clarify 步是一整段长追问文案，正好用来观察切片粒度
    const byDefault = await runChunks(createDemoRouter(), [user('你好呀')])
    const byLarge = await runChunks(createDemoRouter({ chunkSize: 1000 }), [user('你好呀')])

    const deltas = (chunks: StreamChunk[]) => chunks.filter((chunk) => chunk.kind === 'text-delta')
    expect(deltas(byDefault).length).toBeGreaterThan(1)
    expect(deltas(byLarge)).toHaveLength(1)
  })
})

/** 跑一步并把全部分片收集出来（用于断言 usage / 分片形状）。 */
async function runChunks(adapter: ReturnType<typeof createDemoRouter>, messages: readonly LlmMessage[]) {
  const prepared = await adapter.prepareCall({ modelId: ROUTER_MODEL.id, messages })
  return collect(adapter.stream(prepared, new AbortController().signal))
}
