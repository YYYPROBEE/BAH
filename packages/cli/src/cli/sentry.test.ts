/**
 * `bah sentry unfreeze`（施工单 HP-0 §3.3 的 HP0-12…15）。
 *
 * 三件必须被钉住的事：
 * 1. **用法错误 = 退出码 2**，运行期失败 = 1，成功（含幂等 no-op）= 0；
 * 2. **token 只从环境变量读**，且**任何输出里都不出现它**；
 * 3. 它只是 HTTP 客户端——不发别的请求、不 boot app。
 */

import { describe, expect, it } from 'vitest'

import { parseCommand } from './command.ts'
import { HELP } from './run.ts'
import { runSentryUnfreeze, SENTRY_HELP, type SentryIo } from './sentry.ts'

/** 收集输出的假 io。 */
function io(): SentryIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = []
  const errLines: string[] = []
  return {
    outLines,
    errLines,
    out: (message) => outLines.push(message),
    err: (message) => errLines.push(message),
  }
}

/** 一次请求的快照（供断言方法/头/体）。 */
interface Captured {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** 假 fetch：返回给定响应，并记下请求。 */
function fakeFetch(
  status: number,
  body: unknown,
  captured: Captured[] = [],
): (url: string, init?: RequestInit) => Promise<Response> {
  return (url, init) => {
    captured.push({ url, init })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
}

const TOKEN = 'secret-token-value'
const ENV = { BAH_ADMIN_TOKEN: TOKEN }

describe('HP0-12 用法错误 → 退出码 2', () => {
  it('缺子命令 / 未知子命令', async () => {
    const sink = io()
    expect(await runSentryUnfreeze([], sink, { env: ENV })).toBe(2)
    expect(await runSentryUnfreeze(['thaw'], sink, { env: ENV })).toBe(2)
    expect(sink.errLines.join('\n')).toContain('用法')
  })

  it('缺 --by / 未知参数 / 非法 URL', async () => {
    const sink = io()
    expect(await runSentryUnfreeze(['unfreeze'], sink, { env: ENV })).toBe(2)
    expect(await runSentryUnfreeze(['unfreeze', '--by', 'ops', '--nope', 'x'], sink, { env: ENV })).toBe(2)
    expect(await runSentryUnfreeze(['unfreeze', '--by', 'ops', '--url', 'ftp://x'], sink, { env: ENV })).toBe(2)
  })

  it('缺 token → 2（且不发起请求）', async () => {
    const sink = io()
    const captured: Captured[] = []
    const code = await runSentryUnfreeze(['unfreeze', '--by', 'ops'], sink, {
      env: {},
      fetchImpl: fakeFetch(200, { ok: true, unfrozen: true }, captured),
    })
    expect(code).toBe(2)
    expect(captured).toHaveLength(0)
    expect(sink.errLines.join('\n')).toContain('BAH_ADMIN_TOKEN')
  })
})

describe('HP0-13 正常请求：路径 / 头 / body 正确', () => {
  it('200 unfrozen:true → 退出 0，并打印操作者', async () => {
    const sink = io()
    const captured: Captured[] = []
    const code = await runSentryUnfreeze(
      ['unfreeze', '--by', 'ops-7', '--reason', '客服复核：误报', '--url', 'http://127.0.0.1:7331/'],
      sink,
      { env: ENV, fetchImpl: fakeFetch(200, { ok: true, unfrozen: true }, captured) },
    )

    expect(code).toBe(0)
    expect(sink.outLines.join('\n')).toContain('已解冻（by=ops-7）')

    const request = captured[0]!
    // 末尾斜杠去掉，不拼出双斜杠
    expect(request.url).toBe('http://127.0.0.1:7331/api/admin/sentry/unfreeze')
    expect(request.init?.method).toBe('POST')
    expect((request.init?.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${TOKEN}`,
    )
    expect(JSON.parse(String(request.init?.body))).toEqual({
      by: 'ops-7',
      reason: '客服复核：误报',
    })
  })

  it('200 unfrozen:false → 退出 0（幂等 no-op 不是错误）', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze', '--by', 'ops-7'], sink, {
      env: ENV,
      fetchImpl: fakeFetch(200, { ok: true, unfrozen: false }),
    })
    expect(code).toBe(0)
    expect(sink.outLines.join('\n')).toContain('当前未处于冻结状态')
  })

  it('未写 --reason 时用缺省理由', async () => {
    const captured: Captured[] = []
    await runSentryUnfreeze(['unfreeze', '--by', 'ops-7'], io(), {
      env: ENV,
      fetchImpl: fakeFetch(200, { ok: true, unfrozen: true }, captured),
    })
    expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({
      by: 'ops-7',
      reason: 'operator-unfreeze',
    })
  })
})

describe('HP0-14 失败分支：退出 1，且不泄漏 token', () => {
  it('404 → 提示管理路由未启用', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze', '--by', 'ops'], sink, {
      env: ENV,
      fetchImpl: fakeFetch(404, { error: { code: 'web-not-found' } }),
    })
    expect(code).toBe(1)
    expect(sink.errLines.join('\n')).toContain('管理路由未启用')
    expect(sink.errLines.join('\n')).not.toContain(TOKEN)
  })

  it('401 → 拒绝访问，且不泄漏 token', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze', '--by', 'ops'], sink, {
      env: ENV,
      fetchImpl: fakeFetch(401, { error: { code: 'web-admin-unauthorized' } }),
    })
    expect(code).toBe(1)
    expect(sink.errLines.join('\n')).toContain('拒绝访问')
    expect(sink.errLines.join('\n')).not.toContain(TOKEN)
  })

  it('网络失败 → 退出 1，错误可读且不泄漏 token', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze', '--by', 'ops'], sink, {
      env: ENV,
      fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')),
    })
    expect(code).toBe(1)
    expect(sink.errLines.join('\n')).toContain('无法连接 web 宿主')
    expect(sink.errLines.join('\n')).not.toContain(TOKEN)
  })
})

describe('HP0-15 命令路由与帮助', () => {
  it('HELP 提到 sentry 子命令（含 headless 限制）', () => {
    expect(HELP).toContain('bah sentry unfreeze')
    expect(SENTRY_HELP).toContain('headless')
    expect(SENTRY_HELP).toContain('BAH_ADMIN_TOKEN')
  })

  it('`--profile sentry` 不被当成子命令', () => {
    expect(parseCommand(['--profile', 'sentry'])).toEqual({ kind: 'run' })
    expect(parseCommand(['sentry', 'unfreeze'])).toEqual({ kind: 'sentry' })
  })
})
