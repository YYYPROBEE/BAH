import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { StreamAssembler, assembleStream, parseArgumentsText } from './assemble.ts'
import type { StreamChunk } from './types.ts'

/** 把分片数组转成 async iterable（模拟 provider 的流）。 */
async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

/** 一次标准工具调用流的完整分片（参数 JSON 被切成 3 段，模拟真实漂移）。 */
const TOOL_CALL_CHUNKS: readonly StreamChunk[] = [
  { kind: 'block-start', index: 2 },
  { kind: 'tool-call-delta', index: 2, id: 'call-1', name: 'transfer_money', argsText: '{"amo' },
  { kind: 'tool-call-delta', index: 2, argsText: 'unt":100,' },
  { kind: 'tool-call-delta', index: 2, argsText: '"payee":"张三"}' },
  { kind: 'block-end', index: 2 },
  { kind: 'usage', input: 120, output: 30 },
  { kind: 'finish', reason: 'tool-calls' },
]

describe('StreamAssembler（施工单 05 §1 / §2.1）', () => {
  it('T-LLM-002 tool-call-delta 拼接：分片 JSON 正确合成 args', async () => {
    const assembled = await assembleStream(streamOf(TOOL_CALL_CHUNKS))

    expect(assembled.finishReason).toBe('tool-calls')
    expect(assembled.usage).toEqual({ input: 120, output: 30 })
    expect(assembled.toolCalls).toHaveLength(1)

    const call = assembled.toolCalls[0]!
    // 三片拼起来才是一个合法 JSON 对象；任一片单独 parse 都会失败
    expect(call.callId).toBe('call-1')
    expect(call.name).toBe('transfer_money')
    expect(call.argsText).toBe('{"amount":100,"payee":"张三"}')
    expect(call.args).toEqual({ amount: 100, payee: '张三' })
    expect(call.parseError).toBeUndefined()

    // 内容块视图与工具调用视图同源
    expect(assembled.content).toEqual([
      { kind: 'tool-call', id: 'call-1', name: 'transfer_money', args: { amount: 100, payee: '张三' } },
    ])
  })

  it('文本与推理块按块索引分开累积（推理块不进工具调用）', async () => {
    const assembler = new StreamAssembler()
    assembler.push({ kind: 'block-start', index: 1 })
    assembler.push({ kind: 'reasoning-delta', index: 1, text: '先想' })
    assembler.push({ kind: 'reasoning-delta', index: 1, text: '一下' })
    assembler.push({ kind: 'block-end', index: 1 })
    assembler.push({ kind: 'block-start', index: 0 })
    assembler.push({ kind: 'text-delta', index: 0, text: '好的' })
    assembler.push({ kind: 'block-end', index: 0 })
    assembler.push({ kind: 'finish', reason: 'stop' })

    const assembled = assembler.finish()
    // 顺序按块索引升序（文本 0 在推理 1 之前），不是按到达顺序
    expect(assembled.content).toEqual([
      { kind: 'text', text: '好的' },
      { kind: 'reasoning', text: '先想一下' },
    ])
    expect(assembled.toolCalls).toEqual([])
    expect(assembled.usage).toEqual({ input: 0, output: 0 })
  })

  it('坏 JSON 不抛错：标注 parseError 并保留原文（交给 repair 路径）', async () => {
    const assembler = new StreamAssembler()
    assembler.push({ kind: 'tool-call-delta', index: 2, id: 'call-2', name: 'query_bill', argsText: '{"month":' })
    assembler.push({ kind: 'block-end', index: 2 })
    assembler.push({ kind: 'finish', reason: 'tool-calls' })

    const assembled = assembler.finish()
    const call = assembled.toolCalls[0]!
    expect(call.args).toBeUndefined()
    expect(call.parseError).toContain('参数不是合法 JSON')
    expect(call.argsText).toBe('{"month":')
    // 内容块保留参数原文，不静默当空对象
    expect(assembled.content[0]).toEqual({ kind: 'tool-call', id: 'call-2', name: 'query_bill', args: '{"month":' })
  })

  it('参数根不是 object 也算坏参数（数组 / null 都不行）', async () => {
    const assembler = new StreamAssembler()
    assembler.push({ kind: 'tool-call-delta', index: 2, id: 'call-3', name: 'x', argsText: '[1,2]' })
    assembler.push({ kind: 'finish', reason: 'tool-calls' })

    const assembled = assembler.finish()
    expect(assembled.toolCalls[0]!.parseError).toContain('object 为根')
  })

  it('缺 block-end 也能收尾（容忍 provider 漏发），缺 finish 则必须抛错', async () => {
    const tolerant = new StreamAssembler()
    tolerant.push({ kind: 'text-delta', index: 0, text: '半截' })
    tolerant.push({ kind: 'finish', reason: 'length' })
    expect(tolerant.finish().content).toEqual([{ kind: 'text', text: '半截' }])

    const broken = new StreamAssembler()
    broken.push({ kind: 'text-delta', index: 0, text: '没有结束' })
    expect(() => broken.finish()).toThrowError(BahError)
    expect(() => broken.finish()).toThrowError(/llm-stream-unfinished|流没有 finish/)
  })

  it('同一块索引混用两种类型 → 协议不一致直接抛错', () => {
    const assembler = new StreamAssembler()
    assembler.push({ kind: 'text-delta', index: 0, text: 'a' })
    expect(() => assembler.push({ kind: 'reasoning-delta', index: 0, text: 'b' })).toThrowError(
      /块 0 先按 text 累积/,
    )
  })

  it('usage 多次上报取各字段最大值（总量型与增量型都不会重复累加）', () => {
    const assembler = new StreamAssembler()
    assembler.push({ kind: 'usage', input: 10, output: 2 })
    assembler.push({ kind: 'usage', input: 40, output: 5 })
    assembler.push({ kind: 'finish', reason: 'stop' })
    expect(assembler.finish().usage).toEqual({ input: 40, output: 5 })
  })

  it('空参数文本视为无参（args 为 {}），不判成坏 JSON', () => {
    expect(parseArgumentsText('  ')).toEqual({ args: {} })
    const assembler = new StreamAssembler()
    assembler.push({ kind: 'tool-call-delta', index: 2, id: 'c', name: 'ping' })
    assembler.push({ kind: 'finish', reason: 'tool-calls' })
    expect(assembler.finish().toolCalls[0]!.args).toEqual({})
  })

  it('provider 漏报 id / name 时按块序号派生，不伪造语义', () => {
    const assembler = new StreamAssembler()
    assembler.push({ kind: 'tool-call-delta', index: 3, argsText: '{}' })
    assembler.push({ kind: 'finish', reason: 'tool-calls' })
    const call = assembler.finish().toolCalls[0]!
    expect(call.callId).toBe('call-3')
    expect(call.name).toBe('<unnamed>')
  })

  it('未收尾的空块被忽略；未知分片类型走 assertNever（负控）', () => {
    const assembler = new StreamAssembler()
    assembler.push({ kind: 'block-end', index: 9 })
    assembler.push({ kind: 'finish', reason: 'stop' })
    expect(assembler.finish().content).toEqual([])

    const ghost = new StreamAssembler()
    expect(() =>
      ghost.push({ kind: 'ghost-delta', index: 0 } as unknown as StreamChunk),
    ).toThrowError(/llm-stream-chunk/)
  })
})
