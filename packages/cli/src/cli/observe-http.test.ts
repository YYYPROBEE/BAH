/**
 * 观测 CLI 共用的 HTTP 小件（`observe-http.ts`）。
 *
 * 这些路径在真宿主上很难复现（连接中断、网关回非 JSON 错误体），但一旦处理错，
 * 排障命令会以未捕获异常或被静默当成成功的姿态收场。用例只钉三件事：
 * 1. token 归一：空白等同于未配置，`--token` 优先于环境变量；
 * 2. 失败理由码：坏 JSON / 缺 `error.code` 时仍给 `http-<status>`，不把 token 带进输出；
 * 3. 读响应体失败不抛；`--url` 只收 http(s) 且去尾斜杠。
 */

import { describe, expect, it } from 'vitest'

import { getText, normalizeUrl, positiveInt, tokenOf, type ObserveFetch } from './observe-http.ts'

/** 造一个只被 `getText` 读到的响应桩。 */
function response(options: {
  status?: number
  ok?: boolean
  text?: () => Promise<string>
}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: options.text ?? (async () => ''),
  } as unknown as Response
}

describe('observe-http · token 与地址归一', () => {
  it('--token 优先，值两端空白被裁掉；空白环境变量视为未配置', () => {
    expect(tokenOf('flag-token', { BAH_WEB_TOKEN: 'env-token' })).toBe('flag-token')
    expect(tokenOf(undefined, { BAH_WEB_TOKEN: ' env-token ' })).toBe('env-token')
    expect(tokenOf('  flag-token  ', {})).toBe('flag-token')
    expect(tokenOf('   ', {})).toBeUndefined()
    expect(tokenOf(undefined, { BAH_WEB_TOKEN: '   ' })).toBeUndefined()
    expect(tokenOf(undefined, {})).toBeUndefined()
  })

  it('--url 只收 http(s)，并去掉尾部斜杠', () => {
    expect(normalizeUrl('http://127.0.0.1:7331')).toBe('http://127.0.0.1:7331')
    expect(normalizeUrl('https://host.test/base///')).toBe('https://host.test/base')
    expect(normalizeUrl('HTTP://HOST.TEST/')).toBe('HTTP://HOST.TEST')
    expect(normalizeUrl('ftp://host.test')).toBeUndefined()
    expect(normalizeUrl('127.0.0.1:7331')).toBeUndefined()
  })

  it('正整数只认十进制整数', () => {
    expect(positiveInt('12')).toBe(12)
    expect(positiveInt(undefined)).toBeUndefined()
    expect(positiveInt('0')).toBeUndefined()
    expect(positiveInt('1.5')).toBeUndefined()
    expect(positiveInt('-3')).toBeUndefined()
    expect(positiveInt('abc')).toBeUndefined()
  })
})

describe('observe-http · GET 结果归一', () => {
  it('2xx 返回文本', async () => {
    const fetchImpl: ObserveFetch = async () => response({ text: async () => 'hello' })
    await expect(getText(fetchImpl, 'http://host.test/api', 't')).resolves.toEqual({
      ok: true,
      status: 200,
      text: 'hello',
    })
  })

  it('错误体里取 error.code；没有就用 http-<status> 兜底', async () => {
    const cases: { body: string; status: number; code: string }[] = [
      { body: '{"error":{"code":"web-forbidden"}}', status: 403, code: 'web-forbidden' },
      { body: '{"error":{"code":""}}', status: 403, code: 'http-403' },
      { body: '{"error":{"code":42}}', status: 403, code: 'http-403' },
      { body: '<html>gateway</html>', status: 502, code: 'http-502' },
    ]
    for (const entry of cases) {
      const fetchImpl: ObserveFetch = async () =>
        response({ ok: false, status: entry.status, text: async () => entry.body })
      const result = await getText(fetchImpl, 'http://host.test/api', 'secret-token')
      expect(result).toEqual({ ok: false, status: entry.status, code: entry.code })
      expect(JSON.stringify(result)).not.toContain('secret-token')
    }
  })

  it('读响应体失败（连接中断）不抛：成功状态给空文本', async () => {
    const fetchImpl: ObserveFetch = async () =>
      response({ text: async () => Promise.reject(new Error('aborted')) })
    await expect(getText(fetchImpl, 'http://host.test/api', 't')).resolves.toEqual({
      ok: true,
      status: 200,
      text: '',
    })
  })

  it('网络失败归一成 network-error，非 Error 抛出也保底', async () => {
    const fetchImpl: ObserveFetch = async () => Promise.reject(new Error('connect ECONNREFUSED'))
    await expect(getText(fetchImpl, 'http://host.test/api', 't')).resolves.toEqual({
      ok: false,
      status: 0,
      code: 'network-error: connect ECONNREFUSED',
    })

    const weird: ObserveFetch = async () => Promise.reject('boom')
    const result = await getText(weird, 'http://host.test/api', 't')
    expect(result).toMatchObject({ ok: false, status: 0, code: 'network-error: boom' })
  })

  it('Bearer 头由 getText 拼装（调用方不重复写）', async () => {
    const seen: (RequestInit | undefined)[] = []
    const fetchImpl: ObserveFetch = async (_url, init) => {
      seen.push(init)
      return response({ text: async () => 'ok' })
    }
    await getText(fetchImpl, 'http://host.test/api', 't')
    expect((seen[0]?.headers as Record<string, string>)['authorization']).toBe('Bearer t')
  })
})
