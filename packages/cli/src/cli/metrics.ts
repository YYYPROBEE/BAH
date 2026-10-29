/**
 * `bah metrics`（可观测性 03 §5）：把 `/api/metrics` 的数字带到终端。
 *
 * 只是 HTTP 客户端：不 boot app、不读会话目录。token 只从 `--token` 或
 * `$BAH_WEB_TOKEN` 读，**任何输出都不回显它**。
 */

import {
  getText,
  normalizeUrl,
  OBS_DEFAULT_URL,
  positiveInt,
  tokenOf,
  type ObserveFetch,
} from './observe-http.ts'
import type { CliIo, CliOptions, SignalSource } from './run.ts'

export const METRICS_USAGE =
  '用法：bah metrics [--url <base>] [--token <t>] [--format json|prom] [--watch <sec>]'

export const METRICS_HELP = [
  'bah metrics —— 读取运行中宿主的 /api/metrics（只读 HTTP 客户端）',
  '',
  METRICS_USAGE,
  '',
  '选项：',
  '  --url <base>       宿主地址（缺省 http://127.0.0.1:7331）',
  '  --token <t>        访问 token（缺省读 BAH_WEB_TOKEN）',
  '  --format <fmt>     json（缺省）| prom（Prometheus 文本）',
  '  --watch <sec>      每 N 秒重抓一次，Ctrl+C 退出',
  '  -h, --help         显示本帮助',
].join('\n')

interface MetricsArgs {
  readonly url: string
  readonly token?: string
  readonly format: 'json' | 'prom'
  readonly watch?: number
  readonly help: boolean
}

type Parsed = { readonly ok: true; readonly args: MetricsArgs } | { readonly ok: false; readonly error: string }

/** 解析 `bah metrics` 的参数（`--flag value` 与 `--flag=value` 都支持）。 */
export function parseMetricsArgs(argv: readonly string[]): Parsed {
  let url = OBS_DEFAULT_URL
  let token: string | undefined
  let format: 'json' | 'prom' = 'json'
  let watch: number | undefined
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] as string
    const separator = raw.indexOf('=')
    const flag = separator > 0 ? raw.slice(0, separator) : raw
    const inline = separator > 0 ? raw.slice(separator + 1) : undefined
    const value = (): string | undefined => {
      const candidate = inline ?? argv[index + 1]
      if (candidate === undefined || candidate.length === 0) return undefined
      if (inline === undefined) index += 1
      return candidate
    }

    switch (flag) {
      case '--url': {
        const read = value()
        if (read === undefined) return { ok: false, error: `${flag} 需要一个值` }
        const normalized = normalizeUrl(read)
        if (normalized === undefined) return { ok: false, error: `${flag} 只支持 http/https` }
        url = normalized
        break
      }
      case '--token': {
        const read = value()
        if (read === undefined) return { ok: false, error: `${flag} 需要一个值` }
        token = read
        break
      }
      case '--format': {
        const read = value()
        if (read !== 'json' && read !== 'prom') return { ok: false, error: `${flag} 只接受 json | prom` }
        format = read
        break
      }
      case '--watch': {
        const read = positiveInt(value())
        if (read === undefined) return { ok: false, error: `${flag} 需要一个正整数秒数` }
        watch = read
        break
      }
      case '-h':
      case '--help':
        if (inline !== undefined) return { ok: false, error: `${flag} 不接受值（写成 ${flag}）` }
        help = true
        break
      default:
        return { ok: false, error: `未知参数 ${raw}` }
    }
  }

  return { ok: true, args: { url, format, help, ...(token === undefined ? {} : { token }), ...(watch === undefined ? {} : { watch }) } }
}

/** 执行 `bah metrics`；返回退出码。 */
export async function runMetrics(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  const parsed = parseMetricsArgs(argv)
  if (!parsed.ok) {
    io.err(`bah metrics: ${parsed.error}`)
    io.err(METRICS_USAGE)
    return 2
  }
  const args = parsed.args
  if (args.help) {
    io.out(METRICS_HELP)
    return 0
  }

  const token = tokenOf(args.token, options.env ?? process.env)
  if (token === undefined) {
    io.err('bah metrics: 缺 token：设置 BAH_WEB_TOKEN 或传 --token')
    return 2
  }

  const fetchImpl: ObserveFetch = (input, init) => fetch(input, init)
  const bearer = token
  const path = args.format === 'prom' ? '/api/metrics?format=prometheus' : '/api/metrics'

  /** 抓一次并打印；返回是否成功。 */
  async function fetchOnce(): Promise<boolean> {
    const result = await getText(fetchImpl, `${args.url}${path}`, bearer)
    if (!result.ok) {
      io.err(`bah metrics: 读取失败（${String(result.status)} ${result.code}）`)
      return false
    }
    io.out(pretty(result.text, args.format))
    return true
  }

  const online = await fetchOnce()
  if (args.watch === undefined) return online ? 0 : 1
  return await watch(args.watch, fetchOnce, io, options.signals ?? process)
}

/** JSON 美化；非 JSON 原样输出（服务端永远回 JSON，这里只是不炸）。 */
function pretty(text: string, format: 'json' | 'prom'): string {
  if (format === 'prom') return text.trimEnd()
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text.trimEnd()
  }
}

/** `--watch`：setTimeout 链 + 信号退出（Ctrl+C 返回 0）。 */
async function watch(
  seconds: number,
  tick: () => Promise<boolean>,
  io: CliIo,
  signals: SignalSource,
): Promise<number> {
  return await new Promise<number>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const stop = (): void => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      signals.off('SIGINT', stop)
      signals.off('SIGTERM', stop)
      io.out('bah metrics: 已停止')
      resolve(0)
    }
    signals.on('SIGINT', stop)
    signals.on('SIGTERM', stop)

    const next = (): void => {
      timer = setTimeout(() => {
        timer = null
        void tick().then(() => {
          if (!stopped) next()
        })
      }, seconds * 1000)
    }
    next()
  })
}
