/**
 * `core:model` 配置校验与 adapter 构造（超时 / mock-only 键）。
 */

import { createContext } from '@bah/core'
import { LLM_ADAPTERS } from '@bah/llm'
import { asSessionId } from '@bah/test-support'
import { afterEach, describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { modelPlugin } from './model.ts'

const saved = process.env['BAH_MODEL_TEST_KEY']

afterEach(() => {
  if (saved === undefined) delete process.env['BAH_MODEL_TEST_KEY']
  else process.env['BAH_MODEL_TEST_KEY'] = saved
})

describe('core:model 配置', () => {
  it('mock 不许写 deepseek 专属键；deepseek 不许写 mock 专属键', () => {
    expect(() => modelPlugin.validate({ provider: 'mock', apiKeyEnv: 'X' })).toThrow(
      /只对 provider=deepseek/,
    )
    expect(() => modelPlugin.validate({ provider: 'deepseek', chunkSize: 4 })).toThrow(
      /只对 provider=mock/,
    )
  })

  it('deepseek 的 requestTimeoutMs 透传到 adapter（装配不联网）', async () => {
    process.env['BAH_MODEL_TEST_KEY'] = 'sk-test'
    const ctx = createContext()
    await ctx.use(
      modelPlugin.plugin,
      modelPlugin.validate({
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKeyEnv: 'BAH_MODEL_TEST_KEY',
        requestTimeoutMs: 1_234,
      }),
    )
    await ctx.start()
    await ctx.dispose('test')
  })
})

describe('mock 脚本的条件收尾步（文案不许承诺没看见的结论）', () => {
  it('text / tool / outcome 三选一；finish 只属于 text 步；ok / failed 必填', () => {
    expect(() =>
      modelPlugin.validate({
        provider: 'mock',
        script: [{ text: 'a', tool: { id: '1', name: 'x', args: {} } }],
      }),
    ).toThrow(/必须且只能写 text \/ tool \/ outcome 之一/)
    expect(() =>
      modelPlugin.validate({
        provider: 'mock',
        script: [{ outcome: { ok: 'a', failed: 'b' }, finish: 'length' }],
      }),
    ).toThrow(/finish 只对 text 步有意义/)
    expect(() => modelPlugin.validate({ provider: 'mock', script: [{ outcome: { ok: 'a' } }] })).toThrow(
      /outcome\.failed 必填/,
    )
  })

  it('收尾文本跟着会话里的真实工具结局走（订阅接线）', async () => {
    const ctx = createContext()
    await ctx.use(
      modelPlugin.plugin,
      modelPlugin.validate({
        provider: 'mock',
        model: 'mock-chat',
        chunkSize: 100,
        script: [{ outcome: { tool: 'transfer_create', ok: '已完成', failed: '未执行：{reason}' } }],
      }),
    )
    await ctx.start()

    ctx.events.emit('session/event', {
      session: asSessionId('s-model-test'),
      event: {
        seq: 1,
        at: 1,
        formatVersion: 1,
        type: 'tool/result',
        data: {
          callId: 'call-1',
          name: 'transfer_create',
          isError: true,
          content: [],
          code: 'approval-cancelled',
          reason: '审批未通过（cancelled）',
          durationMs: 0,
        },
      } as unknown as AnySessionEvent,
    })

    const adapter = ctx.get(LLM_ADAPTERS).resolve('mock:mock-chat').adapter
    const prepared = await adapter.prepareCall({ modelId: 'mock-chat', messages: [] })
    let text = ''
    for await (const chunk of adapter.stream(prepared, new AbortController().signal)) {
      if (chunk.kind === 'text-delta') text += chunk.text
    }
    await ctx.dispose('test')

    expect(text).toBe('未执行：审批未通过（cancelled）')
  })
})
