/**
 * XSC-001/002 语料扫描（施工单 10 §9 的上线前量化步骤）。
 *
 * 输入：会话 JSONL（默认 `sessions/**\/*.jsonl`，也可指向脱敏真实语料目录）。
 * 输出：工具调用总数、每条 XSC 的命中数、**增量命中**（内置 13 条未命中、仅 XSC 命中）
 * 与样本片段；可选 `--json <path>` 落机器可读报告。
 *
 * 口径与生产一致：`collectBlob(args)` → `normalize()` → `scanToolArgs()`；
 * 因此统计结果就是控制面真实会看到的命中，不是另写一套正则。
 *
 * 用法：
 *   pnpm sentry:fp
 *   pnpm sentry:fp -- --dir <语料目录> --min-calls 1000 --json .tmp-xsc-fp.json
 *   pnpm sentry:fp -- --fail-on-hit   # CI 用：有增量命中即退出 1
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { CROSS_SCENARIO_RULES, collectBlob, normalize, scanToolArgs } from '@bah/safety'

/** 扫描选项。 */
interface Options {
  readonly dir: string
  readonly json: string | undefined
  readonly minCalls: number
  readonly failOnHit: boolean
}

/** 单条增量命中样本。 */
interface Sample {
  readonly rule: string
  readonly file: string
  readonly name: string
  readonly hit: string
}

/** 扫描汇总。 */
interface Report {
  readonly dir: string
  readonly files: number
  readonly toolCalls: number
  readonly minCalls: number
  readonly sufficient: boolean
  readonly rules: Readonly<Record<string, number>>
  readonly incrementalHits: number
  readonly samples: readonly Sample[]
}

/** 解析命令行。 */
function parseArgs(argv: readonly string[]): Options {
  let dir = 'sessions'
  let json: string | undefined
  let minCalls = 1_000
  let failOnHit = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      // pnpm 会把 `--` 原样透传；跳过它，其余参数按正常解析
      continue
    }
    if (arg === '--dir') {
      dir = requireValue(argv, (index += 1), '--dir')
    } else if (arg === '--json') {
      json = requireValue(argv, (index += 1), '--json')
    } else if (arg === '--min-calls') {
      minCalls = Number(requireValue(argv, (index += 1), '--min-calls'))
      if (!Number.isInteger(minCalls) || minCalls < 1) throw new Error('--min-calls 必须是正整数')
    } else if (arg === '--fail-on-hit') {
      failOnHit = true
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  return { dir, json, minCalls, failOnHit }
}

/** 取参数值（缺值即抛）。 */
function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少取值`)
  return value
}

/** 打印用法。 */
function printUsage(): void {
  console.log(
    [
      '用法：pnpm sentry:fp -- [--dir sessions] [--min-calls 1000] [--json out.json] [--fail-on-hit]',
      '',
      '统计 XSC-001/002 在会话 tool/call 参数上的命中与增量命中。',
      '--fail-on-hit：存在增量命中时退出码 1（供 CI 使用）。',
    ].join('\n'),
  )
}

/** 递归收集 JSONL 文件。 */
function jsonlFiles(root: string): string[] {
  const files: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(current, name)
      const stat = statSync(full)
      if (stat.isDirectory()) stack.push(full)
      else if (stat.isFile() && name.endsWith('.jsonl')) files.push(full)
    }
  }
  return files.sort()
}

/** 扫描一个目录。 */
function scan(dir: string, minCalls: number): Report {
  const root = resolve(dir)
  const files = jsonlFiles(root)
  const counts = Object.fromEntries(CROSS_SCENARIO_RULES.map((rule) => [rule.id, 0])) as Record<
    string,
    number
  >
  const samples: Sample[] = []
  let toolCalls = 0
  let incrementalHits = 0

  for (const file of files) {
    const where = relative(process.cwd(), file)
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line.trim().length === 0) continue
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof event !== 'object' || event === null) continue
      const record = event as { readonly type?: unknown; readonly data?: unknown }
      if (record.type !== 'tool/call') continue
      const data = (record.data ?? {}) as { readonly name?: unknown; readonly args?: unknown }
      toolCalls += 1

      const normalized = normalize(collectBlob(data.args)).normalized
      const builtin = scanToolArgs(normalized, { demoWhitelist: true })
      const withXsc = scanToolArgs(normalized, {
        demoWhitelist: true,
        extraRules: CROSS_SCENARIO_RULES,
      })
      const builtinIds = new Set(builtin.map((finding) => finding.id))
      const xsc = withXsc.filter((finding) => finding.id.startsWith('XSC-'))
      if (xsc.length > 0 && builtinIds.size === 0) incrementalHits += 1

      for (const finding of xsc) {
        counts[finding.id] = (counts[finding.id] ?? 0) + 1
        if (samples.length < 20) {
          samples.push({
            rule: finding.id,
            file: where,
            name: typeof data.name === 'string' ? data.name : '(unknown)',
            hit: truncate(finding.hit, 120),
          })
        }
      }
    }
  }

  return {
    dir: relative(process.cwd(), root) || '.',
    files: files.length,
    toolCalls,
    minCalls,
    sufficient: toolCalls >= minCalls,
    rules: counts,
    incrementalHits,
    samples,
  }
}

/** 截断样本片段（报告可读性）。 */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** 打印报告。 */
function printReport(report: Report): void {
  console.log('sentry XSC 语料扫描')
  console.log(
    `目录 ${report.dir}：${report.files} 个 JSONL，${report.toolCalls} 次 tool/call（门槛 ${report.minCalls}）`,
  )
  if (!report.sufficient) {
    console.log(
      `⚠ 样本不足：还差 ${report.minCalls - report.toolCalls} 次调用；当前命中率只能作为线索，不能作为上线结论。`,
    )
  }
  console.log('')
  for (const [rule, count] of Object.entries(report.rules)) {
    const rate = report.toolCalls === 0 ? 0 : (count / report.toolCalls) * 100
    console.log(`${rule.padEnd(8)} 命中 ${String(count).padStart(5)}  ${rate.toFixed(3)}%`)
  }
  console.log(`增量命中（内置 13 条未命中、仅 XSC 命中）：${report.incrementalHits}`)
  if (report.samples.length > 0) {
    console.log('\n样本（前 20 条）：')
    for (const sample of report.samples) {
      console.log(`- ${sample.rule} ${sample.file} ${sample.name}：${sample.hit}`)
    }
  }
  console.log('')
  console.log('结论口径：有命中 ≠ 误报；需人工复核样本后，再决定 rules.crossScenario 是否开启。')
}

const options = parseArgs(process.argv.slice(2))
const report = scan(options.dir, options.minCalls)
printReport(report)
if (options.json !== undefined) {
  writeFileSync(resolve(options.json), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`JSON 报告已写入 ${options.json}`)
}
if (options.failOnHit && report.incrementalHits > 0) process.exitCode = 1
