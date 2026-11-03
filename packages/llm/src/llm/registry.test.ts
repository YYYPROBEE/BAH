import { createContext } from '@bah/core'
import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { MockLlmAdapter } from '../mock/adapter.ts'
import { textStep } from '../mock/script.ts'
import { LLM_ADAPTERS, LlmAdapterRegistry, provideLlm } from './registry.ts'
import type { LlmAdapter } from './types.ts'

/** 造一个最小 adapter（只为注册表语义服务；不做流式）。 */
function stubAdapter(id: string): LlmAdapter {
  return {
    providerInfo: () => ({
      id,
      displayName: id,
      capabilities: { toolCall: true, image: false, reasoning: false },
    }),
    listModels: () => Promise.resolve([]),
    resolveModel: (modelId) => ({
      id: modelId,
      providerId: id,
      capabilities: { toolCall: true, image: false, reasoning: false },
    }),
    prepareCall: () => Promise.reject(new BahError('stub', 'not used in this test')),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new BahError('stub', 'not used in this test')
    },
  }
}

describe('LlmAdapterRegistry', () => {
  it('注册即可逆：register 返回幂等 disposer，注销后立即无法解析', () => {
    const registry = new LlmAdapterRegistry()
    const adapter = new MockLlmAdapter({ script: { steps: [textStep('hi')] } })

    const dispose = registry.register(adapter)
    expect(registry.has('mock')).toBe(true)
    expect(registry.ids()).toEqual(['mock'])
    expect(registry.list()).toEqual([adapter])

    dispose()
    dispose() // 幂等
    expect(registry.has('mock')).toBe(false)
    expect(() => registry.get('mock')).toThrowError(/provider mock 未注册/)
  })

  it('重名默认抛错；显式 replace 才覆盖（不静默覆盖）', () => {
    const registry = new LlmAdapterRegistry()
    registry.register(new MockLlmAdapter({ script: { steps: [] } }))

    expect(() => registry.register(new MockLlmAdapter({ script: { steps: [] } }))).toThrowError(
      /覆盖必须显式声明 \{ replace: true \}/,
    )

    const replacement = new MockLlmAdapter({ script: { steps: [] } })
    registry.register(replacement, { replace: true })
    expect(registry.get('mock')).toBe(replacement)
  })

  it('旧 disposer 不会误删后来 replace 上去的实例', () => {
    const registry = new LlmAdapterRegistry()
    const first = new MockLlmAdapter({ script: { steps: [] } })
    const disposeFirst = registry.register(first)
    const second = new MockLlmAdapter({ script: { steps: [] } })
    registry.register(second, { replace: true })

    disposeFirst()
    expect(registry.get('mock')).toBe(second)
  })

  it('空 provider id 属 misconfiguration，载入即抛', () => {
    const registry = new LlmAdapterRegistry()
    expect(() => registry.register(stubAdapter(''))).toThrowError(/provider id 不能为空/)
  })

  it('resolve 支持 provider:model 前缀与裸模型名两种写法', () => {
    const registry = new LlmAdapterRegistry()
    registry.register(new MockLlmAdapter({ script: { steps: [] } }))

    const prefixed = registry.resolve('mock:mock-chat')
    expect(prefixed.model.id).toBe('mock-chat')
    expect(prefixed.model.providerId).toBe('mock')

    const bare = registry.resolve('mock-chat')
    expect(bare.adapter.providerInfo().id).toBe('mock')
  })

  it('未知模型 / 未知 provider 分别给出可定位的理由码', () => {
    const registry = new LlmAdapterRegistry()
    registry.register(new MockLlmAdapter({ script: { steps: [] } }))

    expect(() => registry.resolve('nope-chat')).toThrowError(/没有 provider 认识 modelId nope-chat/)
    expect(() => registry.resolve('ghost:mock-chat')).toThrowError(/provider ghost 未注册/)

    try {
      registry.resolve('nope-chat')
    } catch (error) {
      expect(error).toBeInstanceOf(BahError)
      expect((error as BahError).code).toBe('llm-model-unresolved')
    }
  })

  it('裸模型名遍历注册顺序：前一个 provider 不认识就继续问下一个', () => {
    const registry = new LlmAdapterRegistry()
    // 只认 mock-chat 的 mock，与只认 other-chat 的另一个 provider
    registry.register(new MockLlmAdapter({ script: { steps: [] }, providerId: 'first' }))
    registry.register(
      new MockLlmAdapter({
        script: { steps: [] },
        providerId: 'second',
        models: [
          {
            id: 'other-chat',
            providerId: 'second',
            capabilities: { toolCall: false, image: false, reasoning: true },
          },
        ],
      }),
    )

    expect(registry.resolve('other-chat').model.providerId).toBe('second')
  })

  it('provideLlm 把注册表装进服务键（按键寻址）', async () => {
    const ctx = createContext()
    const registry = new LlmAdapterRegistry()
    provideLlm(ctx, registry)

    expect(ctx.get(LLM_ADAPTERS)).toBe(registry)
    await ctx.dispose('test-finished')
  })
})
