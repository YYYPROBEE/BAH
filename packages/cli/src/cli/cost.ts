/**
 * `bah cost`（可观测性 03 §5.3）：离线汇总一个会话目录的 `usage/summary`。
 *
 * 只读 `session.jsonl`，**不 boot app、不连网**；坏行跳过并计数（演示记录被截断是常态）。
 * 成本以**整数微元**累加；`¥x.xx` 只在打印时换算（整数分，一次取整）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import type { CliIo, CliOptions } from './run.ts'

export const COST_USAGE = '用法：bah cost [--dir <session dir>] [--format table|json]'

export const COST_HELP = [
  'bah cost —— 离线汇总会话目录的 token 与成本（只读 session.jsonl）',
  '',
  COST_USAGE,
  '',
  '选项：',
  '  --dir <path>       会话目录（缺省 sessions/）',
  '  --format <fmt>     table（缺省）| json',
  '  -h, --help         显示本帮助',
].join('\n')

interface CostArgs {
  readonly dir: string
  readonly format: 'table' | 'json'
  readonly help: boolean
}

type Parsed = { readonly ok: true; readonly args: CostArgs } | { readonly ok: false; readonly error: string }

/** 逐轮用量。 */
interface TurnRow {
  turn: number
  input: number
  output: number
  cachedInput: number
  micro: number
}

/** 汇总结果。 */
export interface CostReport {
  readonly dir: string
  readonly turns: number
  readonly input: number
  readonly output: number
  readonly cachedInput: number
  readonly micro: number
  readonly badLines: number
  readonly byTurn: readonly TurnRow[]
}

/** 解析 `bah cost` 的参数。 */
export function parseCostArgs(argv: readonly string[]): Parsed {
  let dir = 'sessions'
  let format: 'table' | 'json' = 'table'
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
      case '--dir': {
        const read = value()
        if (read === undefined) return { ok: false, error: `${flag} 需要一个值` }
        dir = read
        break
      }
      case '--format': {
        const read = value()
        if (read !== 'table' && read !== 'json') return { ok: false, error: `${flag} 只接受 table | json` }
        format = read
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

  return { ok: true, args: { dir, format, help } }
}

/** 数字或 0（事件字段缺失时不让汇总崩）。 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 汇总一个目录（纯读）。 */
export function summarize(file: string, dirLabel: string): CostReport {
  const rows = new Map<number, TurnRow>()
  let input = 0
  let output = 0
  let cachedInput = 0
  let micro = 0
  let badLines = 0

  const text = readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      badLines += 1
      continue
    }
    if (typeof event !== 'object' || event === null) {
      badLines += 1
      continue
    }
    if ((event as { type?: unknown }).type !== 'usage/summary') continue
    const data = (event as { data?: Record<string, unknown> }).data ?? {}
    const turn = num(data['turn'])
    const row = rows.get(turn) ?? { turn, input: 0, output: 0, cachedInput: 0, micro: 0 }
    row.input += num(data['input'])
    row.output += num(data['output'])
    row.cachedInput += num(data['cachedInput'])
    row.micro += num(data['costMicroYuan'])
    rows.set(turn, row)
    input += num(data['input'])
    output += num(data['output'])
    cachedInput += num(data['cachedInput'])
    micro += num(data['costMicroYuan'])
  }

  return {
    dir: dirLabel,
    turns: rows.size,
    input,
    output,
    cachedInput,
    micro,
    badLines,
    byTurn: [...rows.values()].sort((left, right) => left.turn - right.turn),
  }
}

/** 千分位（CLI 表格）。 */
function group(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 整数微元 → `¥x.xx`（显示层；`fen` 只取整一次）。 */
function yuan(micro: number): string {
  const fen = Math.round(micro / 10_000)
  return `¥${String(Math.floor(fen / 100))}.${String(fen % 100).padStart(2, '0')}`
}

/** 人读输出。 */
export function renderCostTable(report: CostReport): string {
  const suffix = report.micro === 0 ? '（未配计价）' : ''
  const lines = [
    `会话 ${report.dir} · ${String(report.turns)} 轮 · 输入 ${group(report.input)} · 缓存 ${group(report.cachedInput)} · 输出 ${group(report.output)} · 成本 ${group(report.micro)} 微元${suffix}`,
    '逐轮：',
  ]
  for (const row of report.byTurn) {
    lines.push(`  turn ${String(row.turn).padStart(2)}  in ${group(row.input)}  out ${group(row.output)}  ${yuan(row.micro)}`)
  }
  if (report.badLines > 0) lines.push(`跳过 ${String(report.badLines)} 行坏行`)
  return lines.join('\n')
}

/** 执行 `bah cost`；返回退出码。 */
export async function runCost(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  const parsed = parseCostArgs(argv)
  if (!parsed.ok) {
    io.err(`bah cost: ${parsed.error}`)
    io.err(COST_USAGE)
    return 2
  }
  const args = parsed.args
  if (args.help) {
    io.out(COST_HELP)
    return 0
  }

  const dir = resolve(options.root ?? process.cwd(), args.dir)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    io.err(`bah cost: 目录不存在或不是目录：${dir}`)
    return 1
  }
  const file = join(dir, 'session.jsonl')
  if (!existsSync(file)) {
    io.err(`bah cost: 目录里没有 session.jsonl：${file}`)
    return 1
  }

  const report = summarize(file, basename(dir))
  if (args.format === 'json') io.out(JSON.stringify(report, null, 2))
  else io.out(renderCostTable(report))
  return 0
}
