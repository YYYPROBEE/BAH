/**
 * 门禁 G-2（W17）：禁止 focused / skipped 用例进主干。
 *
 * ## 为什么这条必须机械化
 *
 * `it.only` 是最隐蔽的"看起来绿了"：本地只剩一个用例在跑，其余全部静默不执行，
 * 而 CI 的用例数门槛只会看到"通过"。`.skip` 更直接——把失败的用例标记掉，
 * 数字一样好看。人工 review 抓不住（一行 diff），所以必须扫。
 *
 * ## 判据
 *
 * 扫 `*.test.ts` / `*.test.tsx`，命中任一即红：
 *
 * - `it.only(` / `test.only(` / `describe.only(` / `suite.only(`
 * - `it.skip(` / `test.skip(` / `describe.skip(` / `suite.skip(`
 * - `xit(` / `xdescribe(` / `xtest(`
 * - `it.todo(` / `test.todo(`
 *
 * ## 已知边界（不假装能覆盖一切）
 *
 * - 只看**代码**：先剥掉 `//` 与 `/* *\/` 注释，再匹配；字符串字面量里出现这些词会被误判
 *   （故意把字面量写成 `it.only` 的用例极少，真出现时用 `'it' + '.only'` 或改文案）；
 * - 不扫 e2e / 快照配置下的文件——它们本来就有 `SKIP` 分支，且由各自的用例数门槛兜住；
 * - 注释掉一行 `.skip` 也算违规吗？不算：剥注释后它就不再是代码，等价于删除。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { Gate, GateResult } from './gate-lib.ts'
import { isMainModule, runStandalone } from './gate-lib.ts'

/** 递归遍历时跳过的目录。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-types', '.git', 'coverage', '.ci-artifacts'])

/** 只扫测试文件。 */
const TEST_FILE = /\.test\.tsx?$/

/** 命中模式（按强度排序，报错时直接给名字）。 */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\b(?:it|test|describe|suite)\s*\.\s*only\s*\(/g, label: 'only' },
  { pattern: /\b(?:it|test|describe|suite)\s*\.\s*skip\s*\(/g, label: 'skip' },
  { pattern: /\b(?:xit|xtest|xdescribe)\s*\(/g, label: 'x-prefixed' },
  { pattern: /\b(?:it|test)\s*\.\s*todo\s*\(/g, label: 'todo' },
]

/**
 * 剥掉注释但保留行号。
 *
 * 做法：块注释整体替换成等量换行（行号不漂），行注释整行清空。
 * 不用正则一次性处理（`//` 在 URL 字符串里会误伤），这里按"块注释优先"两遍走。
 */
function stripComments(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  )
  return withoutBlock
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//')
      if (at < 0) return line
      // 行内 `//` 前面若是 `:`（如 http://）就当真注释处理也不影响判据：那些行本来不是测试声明
      return line.slice(0, at)
    })
    .join('\n')
}

/** 递归收集测试文件。 */
function collectTests(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      collectTests(full, out)
      continue
    }
    if (TEST_FILE.test(entry)) out.push(full)
  }
}

const gate: Gate = {
  name: 'no-focused-tests',

  async run(root: string): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const files: string[] = []
    const packagesDir = join(root, 'packages')
    collectTests(packagesDir, files)
    // 根级 tests/ 若存在也扫（e2e 之外的集成面）
    try {
      collectTests(join(root, 'tests'), files)
    } catch {
      // 没有 tests/ 目录不是问题
    }

    for (const file of files) {
      const rel = relative(root, file).replace(/\\/g, '/')
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
      for (const [index, line] of lines.entries()) {
        for (const rule of FORBIDDEN) {
          rule.pattern.lastIndex = 0
          if (!rule.pattern.test(line)) continue
          findings.push(`${rel}:${String(index + 1)} 出现 ${rule.label}（禁止进主干：${line.trim()}）`)
        }
      }
    }

    notes.push(`已扫描 ${String(files.length)} 个测试文件（packages/ 全树 + tests/）`)
    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
