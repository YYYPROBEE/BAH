/**
 * `bah halt` / `bah unfreeze`（W07 的人工控制面）。
 *
 * 四件必须被钉住的事：
 * 1. 用法错误 = 退出码 2；运行期失败 = 1；成功（含幂等 no-op）= 0；
 * 2. token 只从环境变量读，且**任何输出里都不出现它**；
 * 3. 没有 `--force` / 没有无票据解除（`--ticket` 与 `--request` 必填其一且互斥）；
 * 4. 只打两个管理路由——不 boot app、不发别的请求。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ADMIN_TOKEN_ENV } from '@bah/host'

import { parseCommand } from './command.ts'
import { runHalt, runUnfreeze, HALT_HELP, type HaltIo } from './halt.ts'
import { runCli } from './run.ts'

/** 收集输出的假 io。 */
function io(): HaltIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = []
  const errLines: string[] = []
  return {
    outLines,
    errLines,
    out: (message) => outLines.push(message),
    err: (message) => errLines.push(message),
  }
}

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
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
}

const TOKEN = 'secret-admin-token-value'
const ENV = { BAH_ADMIN_TOKEN: TOKEN }

describe('命令路由', () => {
  it('halt / unfreeze 首项命中子命令；值位置不触发', () => {
    expect(parseCommand(['halt'])).toEqual({ kind: 'halt' })
    expect(parseCommand(['unfreeze', '--ticket', 't-1'])).toEqual({ kind: 'unfreeze' })
    expect(parseCommand(['--profile', 'halt'])).toEqual({ kind: 'run' })
  })

  it('runCli 分流：缺 token 时 halt / unfreeze 都是退出码 2（不 boot app）', async () => {
    const sink = io()
    expect(await runCli(['halt'], sink, { env: {} })).toBe(2)
    expect(await runCli(['unfreeze', '--ticket', 't-1'], sink, { env: {} })).toBe(2)
  })
})

describe('bah halt', () => {
  it('用法错误 → 2（未知参数 / 缺值 / 非 http / detail 过长）', async () => {
    const sink = io()
    expect(await runHalt(['--nope'], sink, { env: ENV })).toBe(2)
    expect(await runHalt(['--url'], sink, { env: ENV })).toBe(2)
    expect(await runHalt(['--url', 'ftp://x'], sink, { env: ENV })).toBe(2)
    expect(await runHalt(['--detail'], sink, { env: ENV })).toBe(2)
    expect(await runHalt(['--detail', 'x'.repeat(201)], sink, { env: ENV })).toBe(2)
    expect(await runHalt(['--force'], sink, { env: ENV })).toBe(2)
  })

  it('缺 token → 2，且不打印 token', async () => {
    const sink = io()
    expect(await runHalt([], sink, { env: {} })).toBe(2)
    expect(sink.errLines.join('\n')).toContain(ADMIN_TOKEN_ENV)
  })

  it('成功：POST /api/admin/halt，detail 透传；changed=false 是幂等 no-op', async () => {
    const captured: Captured[] = []
    const sink = io()
    expect(
      await runHalt(['--url', 'http://127.0.0.1:9000/', '--detail', '值班停机'], sink, {
        env: ENV,
        fetchImpl: fakeFetch(200, { ok: true, halted: true, changed: true }, captured),
      }),
    ).toBe(0)
    expect(captured[0]?.url).toBe('http://127.0.0.1:9000/api/admin/halt')
    expect(captured[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({ detail: '值班停机' })
    expect(
      (captured[0]?.init?.headers as Record<string, string>)['authorization'],
    ).toBe(`Bearer ${TOKEN}`)
    expect(sink.outLines.join('\n')).toContain('已进入 HALT')
    expect(sink.outLines.join('\n')).not.toContain(TOKEN)

    const second = io()
    expect(
      await runHalt([], second, {
        env: ENV,
        fetchImpl: fakeFetch(200, { ok: true, halted: true, changed: false }),
      }),
    ).toBe(0)
    expect(second.outLines.join('\n')).toContain('幂等 no-op')
  })

  it('管理面失败：404 / 401 / 500 / 非 JSON / 连不上 → 1', async () => {
    const cases: Array<{ status: number; body: unknown }> = [
      { status: 404, body: { error: { code: 'web-not-found' } } },
      { status: 401, body: { error: { code: 'web-admin-unauthorized' } } },
      { status: 403, body: { error: { code: 'web-admin-forbidden' } } },
      { status: 500, body: { error: { code: 'web-internal' } } },
      { status: 200, body: 'not-json' },
    ]
    for (const item of cases) {
      const sink = io()
      expect(
        await runHalt([], sink, { env: ENV, fetchImpl: fakeFetch(item.status, item.body) }),
      ).toBe(1)
      expect(sink.errLines.length).toBeGreaterThan(0)
      expect(sink.errLines.join('\n')).not.toContain(TOKEN)
    }

    const sink = io()
    expect(
      await runHalt([], sink, {
        env: ENV,
        fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
      }),
    ).toBe(1)
    expect(sink.errLines.join('\n')).toContain('无法连接')
  })
})

describe('bah unfreeze', () => {
  it('用法错误 → 2（必须二选一；--force 明确拒绝）', async () => {
    const sink = io()
    expect(await runUnfreeze([], sink, { env: ENV })).toBe(2)
    expect(await runUnfreeze(['--ticket', 't-1', '--request'], sink, { env: ENV })).toBe(2)
    expect(await runUnfreeze(['--ticket', 'bad ticket!'], sink, { env: ENV })).toBe(2)
    expect(await runUnfreeze(['--ticket', 't-1', '--force'], sink, { env: ENV })).toBe(2)
    expect(sink.errLines.join('\n')).toContain('--force')
  })

  it('缺 token → 2', async () => {
    const sink = io()
    expect(await runUnfreeze(['--ticket', 't-1'], sink, { env: {} })).toBe(2)
  })

  it('--request：POST unfreeze-request，打印票据与下一步命令', async () => {
    const captured: Captured[] = []
    const sink = io()
    expect(
      await runUnfreeze(['--request'], sink, {
        env: ENV,
        fetchImpl: fakeFetch(200, { ok: true, ticketId: 't-issued-9', expiresAt: 1_000 }, captured),
      }),
    ).toBe(0)
    expect(captured[0]?.url).toContain('/api/admin/halt/unfreeze-request')
    expect(sink.outLines.join('\n')).toContain('t-issued-9')
    expect(sink.outLines.join('\n')).toContain('bah unfreeze --ticket t-issued-9')
    expect(sink.outLines.join('\n')).not.toContain(TOKEN)
  })

  it('--request 失败：409 / 200 但缺 ticketId → 1', async () => {
    const rejected = io()
    expect(
      await runUnfreeze(['--request'], rejected, {
        env: ENV,
        fetchImpl: fakeFetch(409, { error: { code: 'halt-approval-rejected' } }),
      }),
    ).toBe(1)
    expect(rejected.errLines.join('\n')).toContain('halt-approval-rejected')

    const malformed = io()
    expect(
      await runUnfreeze(['--request'], malformed, {
        env: ENV,
        fetchImpl: fakeFetch(200, { ok: true }),
      }),
    ).toBe(1)
  })

  it('--ticket：成功 0；409（本来没 HALT）也是 0；400 / 401 → 1', async () => {
    const captured: Captured[] = []
    const sink = io()
    expect(
      await runUnfreeze(['--ticket', 't-ok-1'], sink, {
        env: ENV,
        fetchImpl: fakeFetch(200, { ok: true, halted: false }, captured),
      }),
    ).toBe(0)
    expect(captured[0]?.url).toContain('/api/admin/halt/unfreeze')
    expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({ ticketId: 't-ok-1' })
    expect(sink.outLines.join('\n')).toContain('已解除 HALT')

    const noop = io()
    expect(
      await runUnfreeze(['--ticket', 't-ok-1'], noop, {
        env: ENV,
        fetchImpl: fakeFetch(409, { error: { code: 'halt-not-halted' } }),
      }),
    ).toBe(0)
    expect(noop.outLines.join('\n')).toContain('当前没有处于 HALT')

    for (const status of [400, 401]) {
      const fail = io()
      expect(
        await runUnfreeze(['--ticket', 't-ok-1'], fail, {
          env: ENV,
          fetchImpl: fakeFetch(status, { error: { code: 'halt-ticket-unknown' } }),
        }),
      ).toBe(1)
      expect(fail.errLines.join('\n')).not.toContain(TOKEN)
    }
  })

  it('连不上 → 1（不打印 error 对象，避免带出 authorization）', async () => {
    const sink = io()
    expect(
      await runUnfreeze(['--ticket', 't-ok-1'], sink, {
        env: ENV,
        fetchImpl: () => Promise.reject(new Error('refused')),
      }),
    ).toBe(1)
    expect(sink.errLines.join('\n')).toContain('无法连接')
    expect(sink.errLines.join('\n')).not.toContain('Bearer')
  })

  it('帮助里明确写了"没有 --force"与 headless 限制', () => {
    expect(HALT_HELP).toContain('没有 --force')
    expect(HALT_HELP).toContain('headless')
  })
})

describe('边界覆盖（不改变语义，只把每条失败路径跑一遍）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('unfreeze 也支持 --url（归一化尾斜杠）', async () => {
    const captured: Captured[] = []
    const sink = io()
    expect(
      await runUnfreeze(
        ['--url', 'http://127.0.0.1:9000/', '--ticket', 't-1'],
        sink,
        { env: ENV, fetchImpl: fakeFetch(200, { ok: true }, captured) },
      ),
    ).toBe(0)
    expect(captured[0]?.url).toBe('http://127.0.0.1:9000/api/admin/halt/unfreeze')
  })

  it('错误响应体不是 JSON / 没有 error.code → 用状态码兜底', async () => {
    const brokenBody = io()
    expect(
      await runHalt([], brokenBody, {
        env: ENV,
        fetchImpl: fakeFetch(500, 'plain text'),
      }),
    ).toBe(1)
    expect(brokenBody.errLines.join('\n')).toContain('HTTP 500')

    const noCode = io()
    expect(
      await runHalt([], noCode, {
        env: ENV,
        fetchImpl: fakeFetch(500, { error: {} }),
      }),
    ).toBe(1)
  })

  it('成功响应体不是对象 → 报"不是 JSON"', async () => {
    const sink = io()
    expect(
      await runHalt([], sink, {
        env: ENV,
        fetchImpl: fakeFetch(200, []),
      }),
    ).toBe(1)
    expect(sink.errLines.join('\n')).toContain('不是 JSON')
  })

  it('--request 连不上 → 1（同 --ticket 的错误路径）', async () => {
    const sink = io()
    expect(
      await runUnfreeze(['--request'], sink, {
        env: ENV,
        fetchImpl: () => Promise.reject(new Error('refused')),
      }),
    ).toBe(1)
    expect(sink.errLines.join('\n')).toContain('无法连接')
  })

  it('未注入 fetchImpl 时走全局 fetch（默认实现）', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', (input: string) => {
      calls.push(input)
      return Promise.resolve(new Response(JSON.stringify({ ok: true, changed: true }), { status: 200 }))
    })
    const sink = io()
    expect(await runHalt([], sink, { env: ENV })).toBe(0)
    expect(calls[0]).toContain('/api/admin/halt')

    vi.stubGlobal('fetch', (input: string) => {
      calls.push(input)
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    })
    expect(await runUnfreeze(['--ticket', 't-1'], sink, { env: ENV })).toBe(0)
  })
})
