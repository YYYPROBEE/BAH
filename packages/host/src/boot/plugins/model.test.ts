/**
 * `core:model` 配置校验与 adapter 构造（超时 / mock-only 键）。
 */

import { createContext } from '@bah/core'
import { afterEach, describe, expect, it } from 'vitest'

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
