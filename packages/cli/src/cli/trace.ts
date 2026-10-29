/**
 * `bah trace`（可观测性 03 §5）：把 `/api/trace` 导出成 JSON 森林或 Chrome Trace。
 *
 * Chrome Trace 是**裸数组**，Perfetto / `chrome://tracing` 可直接打开；
 * `--out` 写文件后必须打印一行 `已写入 <path>`（脚本靠这行判断成功）。
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  getText,
  normalizeUrl,
  OBS_DEFAULT_URL,
  positiveInt,
  tokenOf,
  type ObserveFetch,
} from './observe-http.ts'
import type { CliIo, CliOptions } from './run.ts'

export const TRACE_USAGE =
  '用法：bah trace [--url <base>] [--token <t>] [--format json|chrome] [--limit <n>] [--out <file>]'

export const TRACE_HELP = [
  'bah trace —— 读取运行中宿主的 /api/trace（事件派生的 span 森林）',
  '',
  TRACE_USAGE,
  '',
  '选项：',
  '  --url <base>       宿主地址（缺省 http://127.0.0.1:7331）',
  '  --token <t>        访问 token（缺省读 BAH_WEB_TOKEN）',
  '  --format <fmt>     json（缺省）| chrome（Chrome Trace 裸数组）',
  '  --limit <n>        只取最近 n 条 span（缺省 2000）',
  '  --out <file>       写文件（打印「已写入 <path>」）',
  '  -h, --help         显示本帮助',
].join('\n')

interface TraceArgs {
  readonly url: string
  readonly token?: string
  readonly format: 'json' | 'chrome'
  readonly limit: number
  readonly out?: string
  readonly help: boolean
}

type Parsed = { readonly ok: true; readonly args: TraceArgs } | { readonly ok: false; readonly error: string }

/** 解析 `bah trace` 的参数。 */
export function parseTraceArgs(argv: readonly string[]): Parsed {
  let url = OBS_DEFAULT_URL
  let token: string | undefined
  let format: 'json' | 'chrome' = 'json'
  let limit = 2000
  let out: string | undefined
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
        if (read !== 'json' && read !== 'chrome') return { ok: false, error: `${flag} 只接受 json | chrome` }
        format = read
        break
      }
      case '--limit': {
        const read = positiveInt(value())
        if (read === undefined) return { ok: false, error: `${flag} 需要一个正整数` }
        limit = read
        break
      }
      case '--out': {
        const read = value()
        if (read === undefined) return { ok: false, error: `${flag} 需要一个值` }
        out = read
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

  return {
    ok: true,
    args: {
      url,
      format,
      limit,
      help,
      ...(token === undefined ? {} : { token }),
      ...(out === undefined ? {} : { out }),
    },
  }
}

/** 执行 `bah trace`；返回退出码。 */
export async function runTrace(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  const parsed = parseTraceArgs(argv)
  if (!parsed.ok) {
    io.err(`bah trace: ${parsed.error}`)
    io.err(TRACE_USAGE)
    return 2
  }
  const args = parsed.args
  if (args.help) {
    io.out(TRACE_HELP)
    return 0
  }

  const token = tokenOf(args.token, options.env ?? process.env)
  if (token === undefined) {
    io.err('bah trace: 缺 token：设置 BAH_WEB_TOKEN 或传 --token')
    return 2
  }

  const search = new URLSearchParams({ limit: String(args.limit) })
  if (args.format === 'chrome') search.set('format', 'chrome')
  const fetchImpl: ObserveFetch = (input, init) => fetch(input, init)
  const result = await getText(fetchImpl, `${args.url}/api/trace?${search.toString()}`, token)
  if (!result.ok) {
    io.err(`bah trace: 读取失败（${String(result.status)} ${result.code}）`)
    return 1
  }

  const payload = render(result.text, args.format)
  if (args.out === undefined) {
    io.out(payload)
    return 0
  }

  const target = resolve(options.root ?? process.cwd(), args.out)
  try {
    writeFileSync(target, payload, 'utf8')
  } catch (error) {
    io.err(`bah trace: 写入失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  io.out(`已写入 ${target}`)
  return 0
}

/** JSON 美化；chrome 保持裸数组原样（Perfetto 直接可读）。 */
function render(text: string, format: 'json' | 'chrome'): string {
  if (format === 'chrome') return text.trimEnd()
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text.trimEnd()
  }
}
