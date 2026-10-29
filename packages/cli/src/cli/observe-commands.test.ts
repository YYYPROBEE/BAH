/**
 * 观测三命令（03 §S3.4）：metrics / trace / cost。
 *
 * 钉住四件事：
 * 1. 退出码语义（0 成功 / 1 运行期失败 / 2 用法错误）；
 * 2. token 只从 `--token` 或 `$BAH_WEB_TOKEN` 读，**任何输出不回显**；
 * 3. `--out` 写文件必须打印「已写入 <path>」；
 * 4. `bah cost` 只读 `session.jsonl`：坏行跳过、缺目录给人话。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseCommand } from './command.ts'
import { runCost } from './cost.ts'
import { METRICS_HELP, runMetrics } from './metrics.ts'
import { runTrace, TRACE_HELP } from './trace.ts'
import { HELP, runCli, type CliIo, type SignalSource } from './run.ts'

/** 收集输出的假 io。 */
function io(): CliIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = []
  const errLines: string[] = []
  return {
    outLines,
    errLines,
    out: (message) => outLines.push(message),
    err: (message) => errLines.push(message),
  }
}

/** 可控信号源。 */
function fakeSignals(): SignalSource & { emit: (event: 'SIGINT' | 'SIGTERM') => void } {
  const listeners = new Map<string, Set<() => void>>()
  return {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return undefined
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener)
      return undefined
    },
    emit(event) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener()
    },
  }
}

const dirs: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 临时目录。 */
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-obs-'))
  dirs.push(dir)
  return dir
}

/** 假 fetch：固定响应，记录 URL。 */
function stubFetch(body: string, status = 200): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(String(url))
      return new Response(body, { status, headers: { 'content-type': 'application/json' } })
    }),
  )
  return urls
}

const ENV = { BAH_WEB_TOKEN: 'secret-token' }

describe('bah metrics', () => {
  it('缺 token → 退出 2，且不发起请求', async () => {
    const sink = io()
    const urls = stubFetch('{}')
    expect(await runMetrics([], sink, { env: {} })).toBe(2)
    expect(sink.errLines.join('\n')).toContain('缺 token：设置 BAH_WEB_TOKEN 或传 --token')
    expect(urls).toHaveLength(0)
  })

  it('--format prom 走 prometheus 出口，输出含 # TYPE', async () => {
    const sink = io()
    const urls = stubFetch('# TYPE bah_up gauge\nbah_up 1\n')
    expect(await runMetrics(['--format', 'prom'], sink, { env: ENV })).toBe(0)
    expect(urls[0]).toBe('http://127.0.0.1:7331/api/metrics?format=prometheus')
    expect(sink.outLines.join('\n')).toContain('# TYPE')
  })

  it('JSON 出口美化；4xx → 退出 1 并打印结构化 code', async () => {
    const sink = io()
    stubFetch('{"turns":1}', 200)
    expect(await runMetrics([], sink, { env: ENV })).toBe(0)
    expect(sink.outLines[0]).toContain('"turns": 1')

    const failed = io()
    stubFetch('{"error":{"code":"web-unauthorized"}}', 401)
    expect(await runMetrics([], failed, { env: ENV })).toBe(1)
    expect(failed.errLines.join('\n')).toContain('401 web-unauthorized')
    expect(failed.errLines.join('\n')).not.toContain('secret-token')
  })

  it('网络不可达 → 退出 1，理由码 network-error（不带 token）', async () => {
    const sink = io()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))))
    expect(await runMetrics([], sink, { env: ENV })).toBe(1)
    expect(sink.errLines.join('\n')).toContain('network-error')
    expect(sink.errLines.join('\n')).not.toContain('secret-token')
  })

  it('返回非 JSON 时原样输出（不抛）', async () => {
    const sink = io()
    stubFetch('not json')
    expect(await runMetrics([], sink, { env: ENV })).toBe(0)
    expect(sink.outLines[0]).toBe('not json')
  })

  it('--url / --token 显式参数：去尾斜杠，token 优先于环境变量且不回显', async () => {
    const sink = io()
    const urls = stubFetch('{"turns":1}')
    expect(
      await runMetrics(['--url', 'http://127.0.0.1:9100/', '--token=flag-token'], sink, {
        env: { BAH_WEB_TOKEN: 'env-token' },
      }),
    ).toBe(0)
    expect(urls[0]).toBe('http://127.0.0.1:9100/api/metrics')
    expect(sink.outLines.join('\n')).not.toContain('flag-token')
  })

  it('不显式传 env 时读 process.env 的 BAH_WEB_TOKEN', async () => {
    vi.stubEnv('BAH_WEB_TOKEN', 'env-token')
    const sink = io()
    stubFetch('{"turns":1}')
    expect(await runMetrics([], sink, {})).toBe(0)
  })

  it('参数缺值 / 空值 / 帮助带值 → 2', async () => {
    for (const argv of [['--url'], ['--token'], ['--url='], ['--help=1']]) {
      const sink = io()
      expect(await runMetrics(argv, sink, { env: ENV }), argv.join(' ')).toBe(2)
    }
  })

  it('--watch 每 N 秒重抓，SIGINT 退出 0', async () => {
    vi.useFakeTimers()
    const sink = io()
    const urls = stubFetch('{"turns":1}')
    const signals = fakeSignals()

    const done = runMetrics(['--watch', '2'], sink, { env: ENV, signals })
    await vi.advanceTimersByTimeAsync(0)
    expect(urls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(urls).toHaveLength(2)

    signals.emit('SIGINT')
    await expect(done).resolves.toBe(0)
    expect(sink.outLines.join('\n')).toContain('已停止')
  })

  it('帮助与用法错误都退 2 / 0', async () => {
    const help = io()
    expect(await runMetrics(['--help'], help, { env: ENV })).toBe(0)
    expect(help.outLines.join('\n')).toBe(METRICS_HELP)

    for (const argv of [['--format', 'xml'], ['--url', 'ftp://x'], ['--watch', '0'], ['--nope']]) {
      const sink = io()
      expect(await runMetrics(argv, sink, { env: ENV }), argv.join(' ')).toBe(2)
    }
  })
})

describe('bah trace', () => {
  it('--out 写文件并打印「已写入」，chrome 是裸数组', async () => {
    const root = tmp()
    const sink = io()
    const urls = stubFetch('[{"name":"turn"}]')
    const code = await runTrace(
      ['--format', 'chrome', '--limit', '50', '--out', 'trace.json'],
      sink,
      { env: ENV, root },
    )

    expect(code).toBe(0)
    expect(urls[0]).toBe('http://127.0.0.1:7331/api/trace?limit=50&format=chrome')
    const target = join(root, 'trace.json')
    expect(existsSync(target)).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual([{ name: 'turn' }])
    expect(sink.outLines[0]).toBe(`已写入 ${target}`)
  })

  it('缺省 JSON 出口：limit=2000 且美化', async () => {
    const sink = io()
    const urls = stubFetch('{"roots":[]}')
    expect(await runTrace([], sink, { env: ENV })).toBe(0)
    expect(urls[0]).toBe('http://127.0.0.1:7331/api/trace?limit=2000')
    expect(sink.outLines[0]).toContain('"roots": []')
  })

  it('写文件失败（目录不存在）→ 退出 1，给人话', async () => {
    const sink = io()
    stubFetch('[]')
    expect(await runTrace(['--out', 'no-such-dir/x.json'], sink, { env: ENV, root: tmp() })).toBe(1)
    expect(sink.errLines.join('\n')).toContain('写入失败')
  })

  it('缺 token / 用法错误 / 帮助', async () => {
    const missing = io()
    expect(await runTrace([], missing, { env: {} })).toBe(2)
    expect(missing.errLines.join('\n')).toContain('缺 token')

    const bad = io()
    expect(await runTrace(['--limit', '0'], bad, { env: ENV })).toBe(2)
    expect(await runTrace(['--format', 'xml'], bad, { env: ENV })).toBe(2)

    const help = io()
    expect(await runTrace(['--help'], help, { env: ENV })).toBe(0)
    expect(help.outLines.join('\n')).toBe(TRACE_HELP)
  })

  it('--url / --token 显式参数；HTTP 失败退回 1 且不回显 token', async () => {
    const sink = io()
    const urls = stubFetch('{"error":{"code":"web-forbidden"}}', 403)
    expect(await runTrace(['--url', 'http://127.0.0.1:9100/', '--token', 'flag-token'], sink, { env: {} })).toBe(1)
    expect(urls[0]).toBe('http://127.0.0.1:9100/api/trace?limit=2000')
    expect(sink.errLines.join('\n')).toContain('403 web-forbidden')
    expect(sink.errLines.join('\n')).not.toContain('flag-token')
  })

  it('非 JSON 响应原样输出（JSON 出口不炸）', async () => {
    const sink = io()
    stubFetch('plain text\n')
    expect(await runTrace([], sink, { env: ENV })).toBe(0)
    expect(sink.outLines[0]).toBe('plain text')
  })

  it('未知参数 / 参数缺值 / 帮助带值 → 2；-h 是别名', async () => {
    for (const argv of [['--nope'], ['--url'], ['--token'], ['--limit'], ['--out'], ['--help=1']]) {
      const sink = io()
      expect(await runTrace(argv, sink, { env: ENV }), argv.join(' ')).toBe(2)
    }

    const help = io()
    expect(await runTrace(['-h'], help, { env: ENV })).toBe(0)
    expect(help.outLines[0]).toBe(TRACE_HELP)
  })
})

describe('bah cost', () => {
  /** 造一个带 session.jsonl 的目录。 */
  function sessionDir(lines: string[]): string {
    const dir = tmp()
    writeFileSync(join(dir, 'session.jsonl'), lines.join('\n'), 'utf8')
    return dir
  }

  const usage = (turn: number, input: number, output: number): string =>
    JSON.stringify({ type: 'usage/summary', data: { turn, input, output, cachedInput: 0, costMicroYuan: 0 } })

  it('汇总 3 条 usage/summary（2 轮）：千分位与「未配计价」', async () => {
    const dir = sessionDir([usage(1, 2100, 310), usage(1, 1000, 100), usage(2, 1000, 100), ''])
    const sink = io()
    expect(await runCost(['--dir', dir], sink, {})).toBe(0)

    const text = sink.outLines.join('\n')
    expect(text).toContain('2 轮')
    expect(text).toContain('输入 4,100')
    expect(text).toContain('输出 510')
    expect(text).toContain('成本 0 微元（未配计价）')
  })

  it('--format json 输出可解析的汇总', async () => {
    const dir = sessionDir([usage(1, 100, 20)])
    const sink = io()
    expect(await runCost(['--dir', dir, '--format', 'json'], sink, {})).toBe(0)
    expect(JSON.parse(sink.outLines[0] as string)).toMatchObject({ turns: 1, input: 100, output: 20, badLines: 0 })
  })

  it('目录不存在 / 没有 session.jsonl → 退出 1 + 明确文案（不是 ENOENT 栈）', async () => {
    const missing = io()
    expect(await runCost(['--dir', join(tmp(), 'nope')], missing, {})).toBe(1)
    expect(missing.errLines.join('\n')).toContain('目录不存在或不是目录')
    expect(missing.errLines.join('\n')).not.toContain('ENOENT')

    const empty = io()
    expect(await runCost(['--dir', tmp()], empty, {})).toBe(1)
    expect(empty.errLines.join('\n')).toContain('没有 session.jsonl')
  })

  it('坏行跳过并计数，不崩', async () => {
    const dir = sessionDir([usage(1, 100, 20), '{bad', '123', '   '])
    const sink = io()
    expect(await runCost(['--dir', dir], sink, {})).toBe(0)
    expect(sink.outLines.join('\n')).toContain('跳过 2 行坏行')
  })

  it('用法错误 / 帮助', async () => {
    const bad = io()
    expect(await runCost(['--format', 'xml'], bad, {})).toBe(2)
    const help = io()
    expect(await runCost(['--help'], help, {})).toBe(0)
    expect(help.outLines[0]).toContain('bah cost')
  })

  it('非零成本按 ¥ 换算、微元千分位；缺 data / 非法数值都按 0', async () => {
    const dir = sessionDir([
      JSON.stringify({
        type: 'usage/summary',
        data: { turn: 1, input: 1000, output: 200, cachedInput: 0, costMicroYuan: 1_234_567 },
      }),
      JSON.stringify({ type: 'usage/summary' }),
      JSON.stringify({
        type: 'usage/summary',
        data: { turn: 1, input: '9', output: null, cachedInput: 0, costMicroYuan: 0 },
      }),
    ])
    const sink = io()
    expect(await runCost([`--dir=${dir}`], sink, {})).toBe(0)

    const text = sink.outLines.join('\n')
    expect(text).toContain('2 轮')
    expect(text).toContain('输入 1,000')
    expect(text).toContain('成本 1,234,567 微元')
    expect(text).not.toContain('未配计价')
    expect(text).toContain('¥1.23')
  })

  it('null 行计坏行；参数缺值 / 未知参数 / 帮助带值 → 2', async () => {
    const dir = sessionDir([usage(1, 100, 20), 'null'])
    const sink = io()
    expect(await runCost(['--dir', dir], sink, {})).toBe(0)
    expect(sink.outLines.join('\n')).toContain('跳过 1 行坏行')

    for (const argv of [['--dir'], ['--nope'], ['--help=1']]) {
      const bad = io()
      expect(await runCost(argv, bad, {}), argv.join(' ')).toBe(2)
    }
  })
})

describe('命令路由与帮助', () => {
  it('三个新 kind 都被 parseCommand 识别', () => {
    expect(parseCommand(['metrics'])).toEqual({ kind: 'metrics' })
    expect(parseCommand(['trace'])).toEqual({ kind: 'trace' })
    expect(parseCommand(['cost'])).toEqual({ kind: 'cost' })
  })

  it('runCli 真的分派到三个命令（缺 token → 2；cost 坏目录 → 1）', async () => {
    const sink = io()
    expect(await runCli(['metrics'], sink, { env: {} })).toBe(2)
    expect(await runCli(['trace'], sink, { env: {} })).toBe(2)
    expect(await runCli(['cost', '--dir', join(tmp(), 'nope')], sink, {})).toBe(1)
  })

  it('HELP 列出三条新子命令', () => {
    expect(HELP).toContain('bah metrics')
    expect(HELP).toContain('bah trace')
    expect(HELP).toContain('bah cost')
  })

  it('--profile metrics 仍按 run 模式解析（子命令只看首项）', () => {
    expect(parseCommand(['--profile', 'metrics'])).toEqual({ kind: 'run' })
  })

  it('cost 的 --dir 相对 root 解析', async () => {
    const root = tmp()
    mkdirSync(join(root, 'sessions'))
    writeFileSync(
      join(root, 'sessions', 'session.jsonl'),
      `${JSON.stringify({ type: 'usage/summary', data: { turn: 1, input: 10, output: 1, cachedInput: 0, costMicroYuan: 0 } })}\n`,
      'utf8',
    )
    const sink = io()
    expect(await runCost(['--dir', 'sessions'], sink, { root })).toBe(0)
    expect(sink.outLines.join('\n')).toContain('1 轮')
  })
})
