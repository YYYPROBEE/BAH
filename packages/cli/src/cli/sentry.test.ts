/**
 * `bah sentry unfreeze`。
 *
 * 三件必须被钉住的事：
 * 1. **用法错误 = 退出码 2**，运行期失败 = 1，成功（含幂等 no-op）= 0；
 * 2. **token 只从环境变量读**，且**任何输出里都不出现它**；
 * 3. 它只是 HTTP 客户端——不发别的请求、不 boot app。
 */

import { describe, expect, it, vi } from 'vitest'

import { ADMIN_TOKEN_ENV } from '@bah/host'

import { parseCommand } from './command.ts'
import { HELP } from './run.ts'
import { runSentryUnfreeze, SENTRY_HELP, type SentryFetch, type SentryIo } from './sentry.ts'

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

  it('--by 已移除 / 未知参数 / 非法 URL', async () => {
    const sink = io()
    const removed = await runSentryUnfreeze(['unfreeze', '--by', 'ops'], sink, { env: ENV })
    expect(removed).toBe(2)
    expect(sink.errLines.join('\n')).toContain('--by 已移除')
    expect(await runSentryUnfreeze(['unfreeze', '--nope', 'x'], sink, { env: ENV })).toBe(2)
    expect(await runSentryUnfreeze(['unfreeze', '--url', 'ftp://x'], sink, { env: ENV })).toBe(2)
  })

  it('缺 token → 2（且不发起请求）', async () => {
    const sink = io()
    const captured: Captured[] = []
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
      env: {},
      fetchImpl: fakeFetch(200, { ok: true, unfrozen: true }, captured),
    })
    expect(code).toBe(2)
    expect(captured).toHaveLength(0)
    expect(sink.errLines.join('\n')).toContain('BAH_ADMIN_TOKEN')
  })
})

describe('HP0-13 正常请求：路径 / 头 / body 正确', () => {
  it('200 unfrozen:true → 退出 0，并打印服务端派生的操作者', async () => {
    const sink = io()
    const captured: Captured[] = []
    const code = await runSentryUnfreeze(
      ['unfreeze', '--reason', '客服复核：误报', '--url', 'http://127.0.0.1:7331/'],
      sink,
      {
        env: ENV,
        fetchImpl: fakeFetch(200, { ok: true, unfrozen: true, by: 'ops-7' }, captured),
      },
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
    // 03 TA-44：body 里不再有 by（自报操作者一律 400）
    expect(JSON.parse(String(request.init?.body))).toEqual({
      reason: '客服复核：误报',
    })
  })

  it('200 unfrozen:false → 退出 0（幂等 no-op 不是错误）', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
      env: ENV,
      fetchImpl: fakeFetch(200, { ok: true, unfrozen: false, by: 'admin' }),
    })
    expect(code).toBe(0)
    expect(sink.outLines.join('\n')).toContain('当前未处于冻结状态（by=admin）')
  })

  it('未写 --reason 时用缺省理由', async () => {
    const captured: Captured[] = []
    await runSentryUnfreeze(['unfreeze'], io(), {
      env: ENV,
      fetchImpl: fakeFetch(200, { ok: true, unfrozen: true }, captured),
    })
    expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({
      reason: 'operator-unfreeze',
    })
  })
})

describe('HP0-14 失败分支：退出 1，且不泄漏 token', () => {
  it('404 → 提示管理路由未启用', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
      env: ENV,
      fetchImpl: fakeFetch(404, { error: { code: 'web-not-found' } }),
    })
    expect(code).toBe(1)
    expect(sink.errLines.join('\n')).toContain('管理路由未启用')
    expect(sink.errLines.join('\n')).not.toContain(TOKEN)
  })

  it('401 → 拒绝访问，且不泄漏 token', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
      env: ENV,
      fetchImpl: fakeFetch(401, { error: { code: 'web-admin-unauthorized' } }),
    })
    expect(code).toBe(1)
    expect(sink.errLines.join('\n')).toContain('拒绝访问')
    expect(sink.errLines.join('\n')).not.toContain(TOKEN)
  })

  it('网络失败 → 退出 1，错误可读且不泄漏 token', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
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

/* ────────────────────────────────────────────────────────────────────────────
 * 补：宿主响应超出契约（网关返回 HTML / 2xx 非 JSON 时 CLI 不许抛栈、不许误判）
 *
 * 为什么这些用例值钱：退出码是编排器唯一的信号源。"运行中的宿主被网关挡下返回
 * HTML"与"2xx 但内容不是 JSON"是真实降级形态，必须退化成 `HTTP <status>` 并
 * 干净地退出 1——而不是异常上抛，更不能被误读成"未冻结"的幂等 no-op 退 0。
 * 本文件是纯 HTTP 客户端：所有响应形态都走它自带的 `SentryFetch` 注入口，
 * **不发真实网络**。只有最后一条"未注入 fetchImpl 时落到全局 fetch"的缺省路径
 * 没有注入口可用，才以 `vi.stubGlobal('fetch', …)` 兜那一条线（用例内已注明）。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 假 fetch：固定状态码 + 非 JSON 响应体（网关 HTML / 纯文本）。 */
function nonJsonFetch(status: number, text = '<html>bad gateway</html>'): SentryFetch {
  return () =>
    Promise.resolve(new Response(text, { status, headers: { 'content-type': 'text/html' } }))
}

describe('HP0-16 宿主响应超出契约：HTTP 兜底码与退出码 1', () => {
  it('5xx 且响应体非 JSON → 退出 1，stderr 给 "解冻失败（502 HTTP 502)"（httpBodyCode 的 catch 兜底）', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
      env: ENV,
      fetchImpl: nonJsonFetch(502),
    })
    expect(code).toBe(1)
    // 注意源串的收尾括号是半角：文案本身就是契约，改它要过 CLI 消费方
    expect(sink.errLines).toContain('解冻失败（502 HTTP 502)')
    expect(sink.outLines).toEqual([])
    expect(sink.errLines.join('\n')).not.toContain(TOKEN)
  })

  it('5xx 且 JSON 体带 error.code → 直接打印理由码（catch 与 try 成功是两条不同兜底）', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
      env: ENV,
      fetchImpl: fakeFetch(503, { error: { code: 'sentry-absent', reason: '没有 sentry' } }),
    })
    expect(code).toBe(1)
    expect(sink.errLines).toContain('解冻失败（503 sentry-absent)')
  })

  it('5xx 且 JSON 体没有 error.code → try 成功路径同样兜底成 HTTP <status>', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
      env: ENV,
      fetchImpl: fakeFetch(500, { note: '没有 error 字段' }),
    })
    expect(code).toBe(1)
    expect(sink.errLines).toContain('解冻失败（500 HTTP 500)')
  })

  it('403 且响应体非 JSON → "拒绝访问"文案降级成 HTTP 403（401/403 分支不只测 401）', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
      env: ENV,
      fetchImpl: nonJsonFetch(403, 'forbidden'),
    })
    expect(code).toBe(1)
    expect(sink.errLines.join('\n')).toContain('拒绝访问（403 HTTP 403）：token 或来源不合法')
    expect(sink.errLines.join('\n')).not.toContain(TOKEN)
  })

  it('2xx 但响应体不是 JSON → 退出 1 提示"不是 JSON"，绝不被误读成幂等 no-op 的退出 0', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
      env: ENV,
      fetchImpl: nonJsonFetch(200, 'OK'),
    })
    expect(code).toBe(1)
    expect(sink.errLines).toContain('解冻失败：宿主返回的不是 JSON')
    expect(sink.outLines).toEqual([])
  })
})

describe('HP0-17 参数与环境边界（退出码 2 的另一半与缺省注入路径）', () => {
  it('开关缺值：--url / --reason 各退 2 且点名开关（用法错误不许滑到运行期）', async () => {
    const cases: Array<[readonly string[], string]> = [
      [['unfreeze', '--url'], '--url 需要值'],
      [['unfreeze', '--by'], '--by 已移除'],
      [['unfreeze', '--reason'], '--reason 需要值'],
    ]
    for (const [argv, needle] of cases) {
      const sink = io()
      expect(await runSentryUnfreeze(argv, sink, { env: ENV }), needle).toBe(2)
      expect(sink.errLines.join('\n')).toContain(needle)
    }
  })

  it('--by 一律拒绝（操作者只能来自服务端 token）；超长 --reason 有独立理由码', async () => {
    const removed = io()
    expect(
      await runSentryUnfreeze(['unfreeze', '--by', 'x'.repeat(65)], removed, { env: ENV }),
    ).toBe(2)
    expect(removed.errLines.join('\n')).toContain('--by 已移除')

    const longReason = io()
    const code = await runSentryUnfreeze(['unfreeze', '--reason', 'y'.repeat(201)], longReason, {
      env: ENV,
    })
    expect(code).toBe(2)
    expect(longReason.errLines.join('\n')).toContain('--reason 不得超过 200 字符')
  })

  it('空白 --reason 回落缺省理由而不是报错（空串与全空白都算"没写"）', async () => {
    for (const blankish of ['   ', '']) {
      const captured: Captured[] = []
      const code = await runSentryUnfreeze(['unfreeze', '--reason', blankish], io(), {
        env: ENV,
        fetchImpl: fakeFetch(200, { ok: true, unfrozen: true }, captured),
      })
      expect(code).toBe(0)
      expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({
        reason: 'operator-unfreeze',
      })
    }
  })

  it('fetch 抛出非 Error：文案走 String 转换且绝不泄漏 token（错误对象本体不许进输出）', async () => {
    const sink = io()
    const code = await runSentryUnfreeze(['unfreeze'], sink, {
      env: ENV,
      fetchImpl: () => Promise.reject('socket hang up'),
    })
    expect(code).toBe(1)
    expect(sink.errLines.join('\n')).toContain('无法连接 web 宿主（http://127.0.0.1:7331）：socket hang up')
    expect(sink.errLines.join('\n')).not.toContain(TOKEN)
  })

  it('省略 options.env 时回落 process.env：两侧都没配置 → 退出 2 且不发起请求', async () => {
    const saved = process.env[ADMIN_TOKEN_ENV]
    delete process.env[ADMIN_TOKEN_ENV]
    try {
      const sink = io()
      const code = await runSentryUnfreeze(['unfreeze'], sink, {})
      expect(code).toBe(2)
      expect(sink.errLines.join('\n')).toContain('缺少环境变量 BAH_ADMIN_TOKEN')
    } finally {
      if (saved === undefined) delete process.env[ADMIN_TOKEN_ENV]
      else process.env[ADMIN_TOKEN_ENV] = saved
    }
  })

  it('未注入 fetchImpl → 走全局 fetch（这是唯一没有注入口的缺省路径，只能 vi.stubGlobal 兜住，不发真网络）', async () => {
    const saved = process.env[ADMIN_TOKEN_ENV]
    process.env[ADMIN_TOKEN_ENV] = TOKEN
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      (input: string | URL) => {
        seen.push(String(input))
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, unfrozen: true, by: 'ops' }), { status: 200 }),
        )
      },
    )
    try {
      const sink = io()
      const code = await runSentryUnfreeze(['unfreeze'], sink, {})
      expect(code).toBe(0)
      // 缺省 URL 与生产形态一致：直连本机 7331 的管理路径
      expect(seen).toEqual(['http://127.0.0.1:7331/api/admin/sentry/unfreeze'])
      expect(sink.outLines.join('\n')).toContain('已解冻（by=ops）')
    } finally {
      vi.unstubAllGlobals()
      if (saved === undefined) delete process.env[ADMIN_TOKEN_ENV]
      else process.env[ADMIN_TOKEN_ENV] = saved
    }
  })
})
