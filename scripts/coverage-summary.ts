/**
 * 全仓覆盖率报表 + 判据（W17 的 TC-W17-01 / TC-W17-02）。
 *
 * 读 `vitest.coverage.config.ts` 产出的 `coverage-summary.json`，打印**两个口径**并判定：
 *
 * | 口径 | 定义 | 目标 |
 * |---|---|---|
 * | **行口径**（主指标） | 参与统计的可执行行里被覆盖的比例 | ≥ **80%** |
 * | **包口径**（副指标） | 包级行覆盖 ≥80% 的包数 / 参与统计的包数 | ≥ **14/16**（≈85%） |
 *
 * 两个数必须**同时**报：只报行口径会把"大包很绿、小包全黑"藏起来；
 * 只报包口径会把"每包刚过 80%"说成"覆盖很好"。口径标签缺一个，W20 的抽查会判不合格。
 *
 * ## 为什么判据在脚本里而不是 vitest 的 thresholds
 *
 * vitest 只能表达"全局/逐文件"阈值，表达不了"**几个包达标**"。
 * 如果在配置里再写一份行阈值，就会出现"配置判一次、脚本判一次"的两套真相。
 * 所以：配置只负责产出报表，判据只在这里。
 *
 * ```bash
 * pnpm test:coverage:all     # = vitest run --config vitest.coverage.config.ts && tsx scripts/coverage-summary.ts
 * ```
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { projectRoot } from './gate-lib.ts'

/** 行口径目标（主指标，设计 W17 §1.1）。 */
const LINE_TARGET_PCT = 80

/** 包口径目标：包级行覆盖 ≥80% 的包数（副指标，14/16 ≈ 85%）。 */
const PACKAGE_TARGET = 14

/** 包级达标线（单个包的聚合行覆盖）。 */
const PACKAGE_LINE_PCT = 80

/** v8 报表的结构（只取用到的字段）。 */
interface CoverageEntry {
  readonly lines: { readonly covered: number; readonly total: number; readonly pct: number }
}

/** 报表根。 */
const REPORTS = '.ci-artifacts/cov-all/coverage-summary.json'

/** 递归数物理行（含注释与空行）——"源码总行数"这个数只用于说明分母占多大比例。 */
function physicalLines(dir: string, acc: { value: number }): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-types') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      physicalLines(full, acc)
      continue
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
    const text = readFileSync(full, 'utf8')
    let count = 1
    for (const ch of text) if (ch === '\n') count += 1
    acc.value += count
  }
}

/** 主流程。 */
function main(): void {
  const root = projectRoot()
  const reportPath = join(root, REPORTS)
  if (!existsSync(reportPath)) {
    console.error(`✘ 缺覆盖率报表 ${REPORTS}`)
    console.error('   先跑：pnpm test:coverage:all（内部会先执行 vitest --config vitest.coverage.config.ts）')
    process.exitCode = 1
    return
  }

  const table = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, CoverageEntry> & {
    total: CoverageEntry
  }

  /* ── 行口径 ─────────────────────────────────────────────────────── */
  const total = table.total.lines
  const linePct = total.total === 0 ? 0 : (total.covered / total.total) * 100

  /* ── 包口径 ─────────────────────────────────────────────────────── */
  const byPackage = new Map<string, { covered: number; total: number }>()
  for (const [path, entry] of Object.entries(table)) {
    if (path === 'total') continue
    const normal = path.replace(/\\/g, '/')
    const at = normal.indexOf('packages/')
    if (at < 0) continue
    const pkg = normal.slice(at).split('/')[1] ?? ''
    const acc = byPackage.get(pkg) ?? { covered: 0, total: 0 }
    acc.covered += entry.lines.covered
    acc.total += entry.lines.total
    byPackage.set(pkg, acc)
  }

  const rows = [...byPackage.entries()]
    .map(([pkg, acc]) => ({ pkg, pct: acc.total === 0 ? 0 : (acc.covered / acc.total) * 100, ...acc }))
    .sort((a, b) => b.pct - a.pct)
  const packageOk = rows.filter((row) => row.pct >= PACKAGE_LINE_PCT).length

  /* ── 源码总行数（物理行）───────────────────────────────────────── */
  const physical = { value: 0 }
  physicalLines(join(root, 'packages'), physical)

  /* ── 打印 ───────────────────────────────────────────────────────── */
  console.log('全仓覆盖率（口径：packages/*/src/**/*.ts，排除测试/纯类型/barrel）')
  console.log('')
  console.log(`  行口径      ${linePct.toFixed(2)}%   （覆盖 ${String(total.covered)} 行 / 参与统计 ${String(total.total)} 行）`)
  console.log(`  包口径      ${String(packageOk)}/${String(rows.length)} 个包 ≥${String(PACKAGE_LINE_PCT)}%`)
  console.log(`  源码物理行  ${String(physical.value)} 行（含注释/空行；分母占 ${((total.total / physical.value) * 100).toFixed(1)}%）`)
  console.log('')
  console.log('  按包：')
  for (const row of rows) {
    const mark = row.pct >= PACKAGE_LINE_PCT ? '✔' : '✘'
    console.log(
      `    ${mark} ${row.pkg.padEnd(14)} ${row.pct.toFixed(2).padStart(6)}%   ${String(row.covered)}/${String(row.total)}`,
    )
  }

  /* ── 判据 ───────────────────────────────────────────────────────── */
  const findings: string[] = []
  if (linePct < LINE_TARGET_PCT) {
    findings.push(`行口径 ${linePct.toFixed(2)}% < 目标 ${String(LINE_TARGET_PCT)}%`)
  }
  if (packageOk < PACKAGE_TARGET) {
    const short = rows
      .filter((row) => row.pct < PACKAGE_LINE_PCT)
      .map((row) => `${row.pkg} ${row.pct.toFixed(2)}%`)
      .join('、')
    findings.push(
      `包口径 ${String(packageOk)}/${String(rows.length)} < 目标 ${String(PACKAGE_TARGET)}（未达标：${short}）`,
    )
  }

  console.log('')
  if (findings.length > 0) {
    for (const finding of findings) console.error(`✘ ${finding}`)
    process.exitCode = 1
    return
  }
  console.log(
    `✔ 达标：行口径 ≥${String(LINE_TARGET_PCT)}%（实测 ${linePct.toFixed(2)}%）、包口径 ≥${String(PACKAGE_TARGET)}/${String(rows.length)}（实测 ${String(packageOk)}/${String(rows.length)}）`,
  )
  console.log(`  报表：${relative(root, reportPath).replace(/\\/g, '/')}`)
}

main()
