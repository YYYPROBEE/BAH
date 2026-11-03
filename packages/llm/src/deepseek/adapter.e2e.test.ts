/**
 * DeepSeek 兼容端点的真实流式 e2e。
 *
 * 无 `DEEPSEEK_API_KEY` 时 `vitest.e2e.config.ts` 连用例都不收集（缺密钥不红）。
 *
 * 端点与模型均由环境变量决定，因此同一个用例可以打官方端点，也可以打任何
 * OpenAI 兼容网关（如千问平台托管的 deepseek 模型）：
 * - `DEEPSEEK_BASE_URL`：缺省 `https://api.deepseek.com`
 * - `DEEPSEEK_MODEL`：缺省 `deepseek-chat`
 */

import { describe, expect, it } from 'vitest'

import { assembleStream } from '../llm/assemble.ts'
import type { ModelSpec } from '../llm/types.ts'
import { DEEPSEEK_MODELS, createDeepSeekAdapter } from './adapter.ts'

const hasApiKey = Boolean(process.env['DEEPSEEK_API_KEY'])

/**
 * 模型标识：缺省打官方 `deepseek-chat`，换兼容网关时用 `DEEPSEEK_MODEL` 覆盖。
 *
 * 不放进 `wire.ts`：wire 只负责映射，不关心"跑哪个模型"；模型由调用方传入。
 */
const modelId = process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat'

/**
 * 网关上的模型若不在默认规格表里，就地补一份最小规格。
 *
 * 适配器把模型表做成了**构造参数**（`DeepSeekAdapterOptions.models`），所以接第三方
 * 兼容网关不需要改生产代码；而覆盖模型表会连带丢掉"默认表认不认这个 id"的校验，
 * 故只在默认表查不到时才覆盖。
 */
const isKnownModel = DEEPSEEK_MODELS.some((model) => model.id === modelId)
const modelSpec: ModelSpec = {
  id: modelId,
  providerId: 'deepseek',
  displayName: modelId,
  // 按 chat 类模型给能力位；本用例只验流式文本，不依赖工具调用。
  capabilities: { toolCall: true, image: false, reasoning: false },
  contextWindow: 64_000,
}

describe.skipIf(!hasApiKey)(`DeepSeek 兼容端点真实流式（e2e · ${modelId}）`, () => {
  it('真实 API：出一段文本、结束原因 stop、usage 非零', async () => {
    const adapter = isKnownModel
      ? createDeepSeekAdapter()
      : createDeepSeekAdapter(undefined, { models: [modelSpec] })
    const prepared = await adapter.prepareCall({
      modelId,
      messages: [{ role: 'user', content: [{ kind: 'text', text: '只回答两个字：收到' }] }],
      params: { maxTokens: 32, temperature: 0 },
    })

    const assembled = await assembleStream(adapter.stream(prepared, new AbortController().signal))

    expect(assembled.content.length).toBeGreaterThan(0)
    expect(assembled.finishReason).toBe('stop')
    expect(assembled.usage.input).toBeGreaterThan(0)
    expect(assembled.usage.output).toBeGreaterThan(0)
  })
})
