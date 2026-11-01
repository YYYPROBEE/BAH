/**
 * 端点契约（`docs/llm-endpoints.md` §3 的离线回归）。
 *
 * 钉住四件事，任一条漂移都说明"换模型 = 换配置"这句话不再成立：
 * 1. 缺省值：不设环境变量时回落到官方端点，且**无密钥也能构造**（否则无密钥机器装配不了依赖图）；
 * 2. 覆盖：`DEEPSEEK_BASE_URL` 优先于缺省值，空串按"未设置"处理（CI 的注释依赖这条）；
 * 3. 尾斜杠幂等：`joinUrl` 不能拼出 `//chat/completions`（网关会 404，且现场极难查）；
 * 4. 非 JSON 错误体：网关返回 HTML 502 页时，错误必须是**带状态码的 `BahError`**，不是裸 `SyntaxError`。
 *
 * 全部用注入的 `fetch`，不发真实网络请求、不需要密钥。
 */

import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import type { StreamChunk } from '../llm/types.ts'
import { DeepSeekAdapter, type FetchLike } from './adapter.ts'
import { DEFAULT_BASE_URL, joinUrl, readDeepSeekEnv } from './wire.ts'

/** 取一次流式失败的抛出物（正常返回分片则判失败）。 */
async function failureOf(stream: AsyncIterable<StreamChunk>): Promise<unknown> {
  try {
    for await (const chunk of stream) {
      throw new Error(`预期 stream() 抛错，实际吐出了分片 ${chunk.kind}`)
    }
  } catch (error) {
    return error
  }
  throw new Error('预期 stream() 抛错，实际正常结束')
}

describe('DeepSeek 端点契约（换模型 = 换配置）', () => {
  it('缺省值：端点回落官方入口，无密钥可构造但调用 fail-loud', () => {
    const env = readDeepSeekEnv({})
    expect(DEFAULT_BASE_URL).toBe('https://api.deepseek.com')
    expect(env.baseUrl).toBe(DEFAULT_BASE_URL)
    expect(env.apiKey).toBeUndefined()

    const adapter = new DeepSeekAdapter({})
    expect(adapter.providerInfo().id).toBe('deepseek')
    // 构造不校验密钥（单测/装配要能跑），真正发请求才拦：两件事缺一都会出问题
    expect(() => adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })).toThrow(BahError)
    expect(() => adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })).toThrow(
      /DEEPSEEK_API_KEY/,
    )
  })

  it('环境变量覆盖：DEEPSEEK_BASE_URL 优先，空串按未设置处理', () => {
    const overridden = readDeepSeekEnv({ DEEPSEEK_BASE_URL: 'https://example.test/v1' })
    expect(overridden.baseUrl).toBe('https://example.test/v1')

    // 空串 ≠ 空端点：CI 里 `vars.X || '<缺省>'` 与本地 `X=` 都靠这条回落
    expect(readDeepSeekEnv({ DEEPSEEK_BASE_URL: '' }).baseUrl).toBe(DEFAULT_BASE_URL)

    const withKey = readDeepSeekEnv({
      DEEPSEEK_API_KEY: 'sk-test',
      DEEPSEEK_BASE_URL: 'https://example.test/v1',
    })
    expect(withKey.apiKey).toBe('sk-test')
    expect(withKey.baseUrl).toBe('https://example.test/v1')
  })

  it('尾斜杠幂等：两种写法拼出同一个 URL，且只有一个分隔斜杠', () => {
    const withSlash = joinUrl('https://example.test/v1/', '/chat/completions')
    const withoutSlash = joinUrl('https://example.test/v1', '/chat/completions')

    expect(withSlash).toBe(withoutSlash)
    expect(withSlash).toBe('https://example.test/v1/chat/completions')
    // 协议后的 `//` 是拼错的信号（网关侧表现为 404，不是明确报错）
    expect(withSlash.slice('https://'.length)).not.toContain('//')
    expect(joinUrl('https://example.test/v1/', '/models')).toBe('https://example.test/v1/models')
  })

  it('非 JSON 错误体（HTML 502 页）：归一成可读 BahError，状态码与响应体都留得下来', async () => {
    let calls = 0
    const fetch: FetchLike = () => {
      calls += 1
      return Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    }
    // retryMax=0：5xx 默认要退避重试，本用例只验错误形状，不验退避（也不真等）
    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test',
      baseUrl: 'https://example.test/v1',
      fetch,
      retryMax: 0,
    })
    const prepared = await adapter.prepareCall({ modelId: 'deepseek-chat', messages: [] })

    const error = await failureOf(adapter.stream(prepared, new AbortController().signal))

    expect(error instanceof SyntaxError).toBe(false)
    expect(error).toBeInstanceOf(BahError)
    expect(error).toMatchObject({
      code: 'llm-http-error',
      message: expect.stringMatching(/HTTP 502$/),
      detail: { status: 502, body: '<html>502 Bad Gateway</html>' },
    })
    // 诊断信息在 detail 里，且只打了一枪：重试策略属 adapter 外置参数，不是错误形状的一部分
    expect(calls).toBe(1)
  })
})
