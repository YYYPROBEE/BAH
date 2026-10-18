/**
 * DeepSeek 真实流式 e2e（施工单 05 §0 出口标准第 2 条「真实流式可用」）。
 *
 * 无 `DEEPSEEK_API_KEY` 时 `vitest.e2e.config.ts` 连用例都不收集（施工单硬约束 2：缺密钥不红）。
 */

import { describe, expect, it } from 'vitest'

import { assembleStream } from '../llm/assemble.ts'
import { createDeepSeekAdapter } from './adapter.ts'

const hasApiKey = Boolean(process.env['DEEPSEEK_API_KEY'])

describe.skipIf(!hasApiKey)('DeepSeek 真实流式（e2e）', () => {
  it('真实 API：出一段文本、结束原因 stop、usage 非零', async () => {
    const adapter = createDeepSeekAdapter()
    const prepared = await adapter.prepareCall({
      modelId: 'deepseek-chat',
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
