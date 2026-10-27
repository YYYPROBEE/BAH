/**
 * 门禁 G-1（W17）：断言数不得减少。
 *
 * ## 为什么需要它
 *
 * 覆盖率可以被"跑过就行"的用例堆出来：调一次函数、`expect(result)` 不带任何匹配器，
 * 行覆盖照样涨。真正的防线是"**每个文件里有多少条会失败的断言**"——它一旦下降，
 * 要么有人删了用例，要么有人把断言改成恒真。这条门禁就盯这个数。
 *
 * ## 判据
 *
 * 1. **基线文件** `scripts/assertion-baseline.json`（入库）：`{ 相对路径: 断言数 }`；
 * 2. 本次统计 < 基线 → 红（附差值）；
 * 3. 基线里有、磁盘上没有了 → 红（删测试文件必须同批更新基线并写明理由）；
 * 4. 新出现的测试文件不在基线里 → 必须 > 0 条，否则红（空壳用例）；
 * 5. 统计只数**带非字面量参数的 `expect(`**：`expect(true)` / `expect(1)` / `expect('x')`
 *    属于"恒真断言"，不计入（TC-W17-09 用一个内置自检钉住这条）。
 *
 * ## 基线怎么更新
 *
 * ```bash
 * npx tsx scripts/verify-assertions.ts --update   # 只在"重构合并用例"这类合法下降时用
 * ```
 *
 * 更新必须在同批 commit 的说明里写清楚"合并了哪些、为什么"——门禁拦不住"故意删"，
 * 只能让删的动作留下痕迹。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { Gate, GateResult } from './gate-lib.ts'
import { isMainModule, runStandalone } from './gate-lib.ts'

/** 基线文件（入库）。 */
const BASELINE_FILE = 'scripts/assertion-baseline.json'

/** 递归跳过的目录。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-types', '.git', 'coverage', '.ci-artifacts'])

/** 只扫测试文件。 */
const TEST_FILE = /\.test\.tsx?$/

/**
 * 剥掉注释（保留换行，行号不漂）。
 *
 * **必须是词法扫描，不能用正则**：测试名里经常出现 `'sentry/…'`、`'plan/…'`
 * 这类字面量，正则版会把字符串里的 `斜杠星` 当注释开头，一路吞到**下一个** `星斜杠`——
 * 于是"这个文件有多少条断言"完全取决于注释排版。实测：某文件 69 个 `expect(`
 * 被算成 24 条，触发"断言从 55 降到 24"的假红。
 *
 * 只剥行注释与块注释，字符串 / 模板串整体跳过（含转义）。
 */
function stripComments(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      out += ch
      index += 1
      while (index < source.length) {
        const inner = source[index] ?? ''
        out += inner
        if (inner === '\\') {
          index += 1
          out += source[index] ?? ''
          index += 1
          continue
        }
        index += 1
        if (inner === quote) break
      }
      continue
    }

    if (ch === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }

    if (ch === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out += '\n'
        index += 1
      }
      index += 2
      continue
    }

    out += ch ?? ''
    index += 1
  }
  return out
}

/**
 * 取 `expect(` 的第一个实参文本。
 *
 * 需要真正的扫描而不是正则：实参里可能有嵌套括号、字符串、模板串。
 * @returns 实参文本；找不到（跨行或空）时返回 `''`
 */
function firstArgument(source: string, openAt: number): string {
  let depth = 0
  let index = openAt + 1
  const start = index
  while (index < source.length) {
    const ch = source[index]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      index += 1
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 1
        index += 1
      }
      index += 1
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' && depth === 0) return source.slice(start, index)
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) return source.slice(start, index)
    index += 1
  }
  return ''
}

/** 恒真断言：实参是裸露的字面量（不含模板插值）。 */
function isLiteralArgument(argument: string): boolean {
  const text = argument.trim()
  if (text.length === 0) return true
  if (/^(?:true|false|null|undefined)$/.test(text)) return true
  if (/^-?\d[\d_]*(?:\.\d+)?$/.test(text)) return true
  if (/^(['"])(?:[^\\]|\\.)*\1$/.test(text)) return true
  if (/^`[^`$]*`$/.test(text)) return true
  return false
}

/** 统计一个文件里的"行为断言"条数。 */
export function countAssertions(source: string): number {
  const code = stripComments(source)
  let count = 0
  for (const match of code.matchAll(/\bexpect\s*\(/g)) {
    const openAt = (match.index ?? 0) + match[0].length - 1
    const argument = firstArgument(code, openAt)
    if (isLiteralArgument(argument)) continue
    count += 1
  }
  return count
}

/** 递归收集测试文件。 */
function collect(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      collect(full, out)
      continue
    }
    if (TEST_FILE.test(entry)) out.push(full)
  }
}

/** 收集全仓测试文件的断言数（路径相对仓库根、正斜杠）。 */
function countAll(root: string): Map<string, number> {
  const files: string[] = []
  collect(join(root, 'packages'), files)
  collect(join(root, 'tests'), files)
  const counts = new Map<string, number>()
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/')
    counts.set(rel, countAssertions(readFileSync(file, 'utf8')))
  }
  return counts
}

/** 读基线（缺失时返回空表；首次 `--update` 会建）。 */
function readBaseline(root: string): Record<string, number> {
  const path = join(root, BASELINE_FILE)
  if (!existsSync(path)) return {}
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${BASELINE_FILE} 必须是 { "相对路径": 数量 } 的对象`)
  }
  return parsed as Record<string, number>
}

/** 判据自检（TC-W17-09）：恒真断言不计入、普通断言计入。 */
const SELF_CHECK: readonly { readonly source: string; readonly expected: number; readonly label: string }[] = [
  { source: 'it("x", () => { expect(true).toBe(true) })', expected: 0, label: 'expect(true) 不计入' },
  { source: 'it("x", () => { expect(1).toBe(1) })', expected: 0, label: 'expect(1) 不计入' },
  { source: 'it("x", () => { expect(value).toBe(1) })', expected: 1, label: 'expect(value) 计入' },
  { source: 'it("x", () => { expect(fn(a, b)).toBe(1) })', expected: 1, label: '嵌套括号只算一条' },
  { source: 'it("x", () => { expect(compute("a,b")).toBe(1) })', expected: 1, label: '字符串里的逗号不截断' },
  { source: '// expect(true)\nit("x", () => { expect(ok).toBe(true) })', expected: 1, label: '注释里的 expect 不算' },
]

const gate: Gate = {
  name: 'assertions',

  async run(root: string): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    // 自检先跑：判据本身错了，后面的数都不可信
    for (const check of SELF_CHECK) {
      const actual = countAssertions(check.source)
      if (actual !== check.expected) {
        findings.push(
          `判据自检失败（${check.label}）：期望 ${String(check.expected)} 条，实测 ${String(actual)} 条`,
        )
      }
    }

    const update = process.argv.includes('--update')
    const counts = countAll(root)
    const baseline = readBaseline(root)

    if (update) {
      const sorted: Record<string, number> = {}
      for (const key of [...counts.keys()].sort()) sorted[key] = counts.get(key) ?? 0
      writeFileSync(join(root, BASELINE_FILE), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
      const total = [...Object.values(sorted)].reduce((sum, value) => sum + value, 0)
      notes.push(`已写入基线：${String(Object.keys(sorted).length)} 个文件 / ${String(total)} 条断言`)
      return { ok: findings.length === 0, findings, notes }
    }

    if (Object.keys(baseline).length === 0) {
      findings.push(`缺基线 ${BASELINE_FILE}：先跑一次 npx tsx scripts/verify-assertions.ts --update`)
      return { ok: false, findings, notes }
    }

    let baselineTotal = 0
    let currentTotal = 0
    for (const [path, limit] of Object.entries(baseline)) {
      baselineTotal += limit
      if (!counts.has(path)) {
        findings.push(`${path}: 基线里有 ${String(limit)} 条断言，但文件已不存在（删测试要同批更新基线并写明理由）`)
        continue
      }
    }

    for (const [path, value] of counts) {
      currentTotal += value
      const limit = baseline[path]
      if (limit === undefined) {
        // 新增文件必须**同批**登记进基线：否则它的断言不受保护（下次被删也没人知道）。
        // 与快照纪律同理——"录一次"这个动作本身就是审查点。
        if (value === 0) findings.push(`${path}: 新增测试文件里没有行为断言（空壳用例）`)
        else findings.push(`${path}: 新增 ${String(value)} 条断言但基线里没有（同批跑 --update 登记）`)
        continue
      }
      if (value < limit) {
        findings.push(`${path}: 断言从 ${String(limit)} 降到 ${String(value)}（少了 ${String(limit - value)} 条）`)
      }
    }

    notes.push(
      `断言总数：基线 ${String(baselineTotal)} → 本次 ${String(currentTotal)}（文件 ${String(counts.size)} 个）`,
    )
    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
