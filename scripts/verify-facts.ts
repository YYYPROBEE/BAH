/**
 * 门禁：文档里的数字只有一个来源 —— 命令（C07）。
 *
 * ## 为什么需要它
 *
 * `facts.md` 自称"演示材料的唯一数字来源"，但 2026-10-26 复审抓到：
 * 工具数写 14（实为 16）、覆盖率 84.48 与 84.49 两个值并存、三张状态表停在门禁 30。
 * 规律是：**数字没人核，就会停在最后一次手工编辑**。本门禁把"核"变成一次命令。
 *
 * ## 判据
 *
 * 1. **从代码/文件重算**五类事实：门禁数、工具数、plan 非测试行数、快照文件/用例、覆盖率；
 * 2. 与 `docs/facts-sources.md` 的机器块（`<!-- facts:sources:start -->`）逐项比对；
 * 3. 与 `facts.md` 的表述比对；数字对不上、或同一文件出现两个覆盖率值 → 红；
 * 4. 白名单文件里的工具数必须是 16（`security-design.md` 的"旧数"说明除外）；
 * 5. 若存在 `.ci-artifacts/cov-all/coverage-summary.json`，还要核对覆盖率台账是不是最近一次跑批
 *    （干净 clone 无报表时跳过，仅记 note）。
 *
 * ## 边界（如实登记）
 *
 * - **不重跑测试**：`vitest` 的文件/用例数只校验"`facts-sources` 与 `facts.md` 一致"，
 *   不证明它们等于当前磁盘上的用例数——那由 `pnpm test` 自己证明。重跑会让每次提交多几十秒。
 * - **覆盖率台账可能滞后**：本机有报表时核对 covered/total；干净 clone 只能核台账内部自洽。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { BANK_TOOL_SPECS } from '../packages/bank/src/tools/specs.ts'

import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'

/** 机器可读块的分界。 */
const BEGIN = '<!-- facts:sources:start -->'
const END = '<!-- facts:sources:end -->'

/** 必须存在的键（缺一个就红：说明表格被人改坏了）。 */
const REQUIRED_KEYS = [
  'gates',
  'tools',
  'plan_lines',
  'snapshot_files',
  'snapshot_cases',
  'coverage_covered',
  'coverage_total',
  'coverage_pct',
  'coverage_package_ok',
  'coverage_package_total',
  'tests_main_files',
  'tests_main_cases',
] as const

type FactKey = (typeof REQUIRED_KEYS)[number]

/** 覆盖率台账（与 `gen-architecture.ts` 同一形状）。 */
interface CoverageBaseline {
  readonly measuredAt: string
  readonly line: { readonly covered: number; readonly total: number; readonly pct: number }
  readonly packages: { readonly atLeast80: number; readonly total: number }
}

const gate: Gate = {
  name: 'facts',

  async run(root) {
    const findings: string[] = []
    const notes: string[] = []

    const factsMd = readText(join(root, 'facts.md'))
    const sourcesMd = readText(join(root, 'docs/facts-sources.md'))
    if (factsMd === undefined) findings.push('缺 facts.md')
    if (sourcesMd === undefined) findings.push('缺 docs/facts-sources.md')
    if (factsMd === undefined || sourcesMd === undefined) {
      return { ok: false, findings, notes }
    }

    const declared = parseSources(sourcesMd, findings)
    const computed = computeFacts(root, findings, notes)
    // 统一两位小数：85.8 与 85.80 是同一事实，但文档里统一写 85.80
    const coveragePct = computed.coverage_pct.toFixed(2)

    // ① 代码/文件重算值 ↔ facts-sources
    compare(declared, computed, ['gates', 'tools', 'plan_lines', 'snapshot_files', 'snapshot_cases'], findings)
    if (declared.coverage_covered !== computed.coverage_covered) {
      findings.push(`coverage_covered：facts-sources ${declared.coverage_covered} ≠ 重算 ${computed.coverage_covered}`)
    }
    if (declared.coverage_total !== computed.coverage_total) {
      findings.push(`coverage_total：facts-sources ${declared.coverage_total} ≠ 重算 ${computed.coverage_total}`)
    }
    if (declared.coverage_pct !== computed.coverage_pct) {
      findings.push(`coverage_pct：facts-sources ${declared.coverage_pct} ≠ 重算 ${computed.coverage_pct}`)
    }
    if (declared.coverage_package_ok !== computed.coverage_package_ok) {
      findings.push(
        `coverage_package_ok：facts-sources ${declared.coverage_package_ok} ≠ 重算 ${computed.coverage_package_ok}`,
      )
    }
    if (declared.coverage_package_total !== computed.coverage_package_total) {
      findings.push(
        `coverage_package_total：facts-sources ${declared.coverage_package_total} ≠ 重算 ${computed.coverage_package_total}`,
      )
    }

    // ② 覆盖率台账内部自洽（pct 必须等于 covered/total 四舍五入两位）
    const baseline = readCoverageBaseline(root, findings)
    if (baseline !== undefined) {
      const pct = round2((baseline.line.covered / baseline.line.total) * 100)
      if (pct !== baseline.line.pct) {
        findings.push(
          `docs/coverage-baseline.json：pct ${baseline.line.pct} 与 ${baseline.line.covered}/${baseline.line.total} 的 ${pct} 不一致`,
        )
      }
      if (baseline.line.covered !== computed.coverage_covered || baseline.line.total !== computed.coverage_total) {
        findings.push(
          `coverage-baseline 与 facts-sources 不一致：台账 ${baseline.line.covered}/${baseline.line.total}，来源 ${computed.coverage_covered}/${computed.coverage_total}`,
        )
      }
    }

    // ③ facts.md 表述 ↔ 重算/来源值
    expectContains(factsMd, 'facts.md', `**${String(computed.gates)}/${String(computed.gates)}**`, findings)
    expectContains(factsMd, 'facts.md', `工具：${String(computed.tools)} 个`, findings)
    expectContains(factsMd, 'facts.md', `当前 ${String(computed.tools)}`, findings)
    expectContains(
      factsMd,
      'facts.md',
      `${String(computed.snapshot_files)} 文件 / ${String(computed.snapshot_cases)} 用例`,
      findings,
    )
    expectContains(
      factsMd,
      'facts.md',
      `**行口径 ${coveragePct}%**（${String(computed.coverage_covered)}/${String(computed.coverage_total)}）`,
      findings,
    )
    expectContains(
      factsMd,
      'facts.md',
      `**包口径 ${String(computed.coverage_package_ok)}/${String(computed.coverage_package_total)}**`,
      findings,
    )
    expectContains(
      factsMd,
      'facts.md',
      `${String(declared.tests_main_files)} 文件 / ${String(declared.tests_main_cases)} 用例`,
      findings,
    )
    if (factsMd.includes('84.48%')) findings.push('facts.md 仍含旧覆盖率 84.48%（只允许 84.49%）')

    // ④ 白名单：工具数 16、覆盖率单一值
    const contract = readText(join(root, 'docs/contracts/tool-contract.md'))
    if (contract === undefined) findings.push('缺 docs/contracts/tool-contract.md')
    else {
      if (contract.includes('14 个工具')) findings.push('docs/contracts/tool-contract.md 仍写「14 个工具」')
      expectContains(contract, 'docs/contracts/tool-contract.md', `${String(computed.tools)} 个工具`, findings)
    }

    const security = readText(join(root, 'docs/security-design.md'))
    if (security === undefined) findings.push('缺 docs/security-design.md')
    else {
      if (security.includes('84.48%')) findings.push('docs/security-design.md 仍含旧覆盖率 84.48%（只允许 84.49%）')
      expectContains(security, 'docs/security-design.md', `${coveragePct}%`, findings)
    }

    const intro = readText(join(root, 'docs/简介-200字.md'))
    if (intro === undefined) findings.push('缺 docs/简介-200字.md')
    else if (intro.includes('14 个工具')) findings.push('docs/简介-200字.md 仍写「14 个工具」')

    notes.push(
      `重算：门禁 ${String(computed.gates)} · 工具 ${String(computed.tools)} · plan ${String(computed.plan_lines)} 行 · ` +
        `快照 ${String(computed.snapshot_files)} 文件/${String(computed.snapshot_cases)} 例 · ` +
        `覆盖率 ${coveragePct}%（${String(computed.coverage_covered)}/${String(computed.coverage_total)}）`,
    )

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 从 facts-sources 机器块解析键值。 */
function parseSources(text: string, findings: string[]): Record<FactKey, number> {
  const from = text.indexOf(BEGIN)
  const to = text.indexOf(END)
  const values = new Map<string, number>()
  if (from < 0 || to < 0 || to < from) {
    findings.push(`docs/facts-sources.md 缺机器块（${BEGIN} … ${END}）`)
    return emptyRecord()
  }
  for (const raw of text.slice(from + BEGIN.length, to).split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const at = line.indexOf('=')
    if (at <= 0) {
      findings.push(`docs/facts-sources.md 机器块行格式错：${line}`)
      continue
    }
    const key = line.slice(0, at).trim()
    const value = Number(line.slice(at + 1).trim())
    if (!Number.isFinite(value)) {
      findings.push(`docs/facts-sources.md 机器块 ${key} 不是数字`)
      continue
    }
    values.set(key, value)
  }
  for (const key of REQUIRED_KEYS) {
    if (!values.has(key)) findings.push(`docs/facts-sources.md 机器块缺 ${key}`)
  }
  const result = emptyRecord()
  for (const key of REQUIRED_KEYS) result[key] = values.get(key) ?? Number.NaN
  return result
}

/** 从代码与文件重算事实值。 */
function computeFacts(
  root: string,
  findings: string[],
  notes: string[],
): Record<FactKey, number> {
  const gates = readdirSync(join(root, 'scripts')).filter((name) => /^verify-[\w-]+\.ts$/.test(name)).length
  const tools = BANK_TOOL_SPECS.length
  const planLines = countPlanLines(root)

  const testFiles = walkSnapshotTests(root)
  const snapshotFiles = testFiles.length
  const snapshotCases = testFiles.reduce((sum, path) => sum + countItBlocks(readFileSync(path, 'utf8')), 0)

  const baseline = readCoverageBaseline(root, findings)
  const covered = baseline?.line.covered ?? Number.NaN
  const total = baseline?.line.total ?? Number.NaN
  const pct = total > 0 ? round2((covered / total) * 100) : Number.NaN

  // 报表存在时核对台账是否最近一次：干净 clone 没有报表，只记 note。
  const reportPath = join(root, '.ci-artifacts/cov-all/coverage-summary.json')
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        total?: { lines?: { covered?: number; total?: number } }
      }
      const lines = report.total?.lines
      if (lines?.covered !== covered || lines.total !== total) {
        findings.push(
          `coverage-baseline 已过期：报表 ${String(lines?.covered)}/${String(lines?.total)}，台账 ${String(covered)}/${String(total)}（重跑 pnpm test:coverage:all 并更新台账）`,
        )
      }
    } catch {
      findings.push('.ci-artifacts/cov-all/coverage-summary.json 无法解析（重跑覆盖率）')
    }
  } else {
    notes.push('未发现覆盖率报表（.ci-artifacts/cov-all），跳过台账新鲜度核对')
  }

  return {
    gates,
    tools,
    plan_lines: planLines,
    snapshot_files: snapshotFiles,
    snapshot_cases: snapshotCases,
    coverage_covered: covered,
    coverage_total: total,
    coverage_pct: pct,
    coverage_package_ok: baseline?.packages.atLeast80 ?? Number.NaN,
    coverage_package_total: baseline?.packages.total ?? Number.NaN,
    // 这两项不重跑测试，只用于"来源与 facts.md 一致"的交叉校验。
    tests_main_files: Number.NaN,
    tests_main_cases: Number.NaN,
  }
}

/** plan 目录的非测试行数（按 `\n` 计；有末尾换行时不额外 +1）。 */
function countPlanLines(root: string): number {
  const dir = join(root, 'packages/runtime/src/plan')
  let total = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    const text = readFileSync(join(dir, name), 'utf8')
    total += text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  }
  return total
}

/** 快照测试文件（含 `snapshots/fixtures.test.ts`）。 */
function walkSnapshotTests(root: string): string[] {
  const found: string[] = []
  const snapshotRoot = join(root, 'snapshots')
  if (!existsSync(snapshotRoot)) return found
  const stack = [snapshotRoot]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name))
      else if (entry.name.endsWith('.test.ts')) found.push(join(dir, entry.name))
    }
  }
  return found.sort()
}

/** 测试文件里 `it(` 的个数（与 `pnpm test:snapshot` 的用例数同口径）。 */
function countItBlocks(text: string): number {
  return (text.match(/\bit\(/g) ?? []).length
}

/** 读覆盖率台账；缺失或坏掉都记 finding。 */
function readCoverageBaseline(root: string, findings: string[]): CoverageBaseline | undefined {
  const path = join(root, 'docs/coverage-baseline.json')
  if (!existsSync(path)) {
    findings.push('缺 docs/coverage-baseline.json（覆盖率必须跑一遍并登记）')
    return undefined
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CoverageBaseline
  } catch {
    findings.push('docs/coverage-baseline.json 无法解析')
    return undefined
  }
}

/** 逐项比对（来源 vs 重算）。 */
function compare(
  declared: Record<FactKey, number>,
  computed: Record<FactKey, number>,
  keys: readonly FactKey[],
  findings: string[],
): void {
  for (const key of keys) {
    if (declared[key] !== computed[key]) {
      findings.push(`${key}：facts-sources ${String(declared[key])} ≠ 重算 ${String(computed[key])}`)
    }
  }
}

/** 文档必须包含某段文字。 */
function expectContains(text: string, file: string, needle: string, findings: string[]): void {
  if (!text.includes(needle)) findings.push(`${file} 缺「${needle}」（数字与命令不一致，或表述已漂）`)
}

/** 读文件；缺失返回 undefined。 */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return undefined
  }
}

/** 四舍五入两位小数（与 `coverage-summary.ts` 的 toFixed(2) 同口径）。 */
function round2(value: number): number {
  return Number(value.toFixed(2))
}

/** 空记录（全部 NaN，便于缺键时必然比对失败）。 */
function emptyRecord(): Record<FactKey, number> {
  const result = {} as Record<FactKey, number>
  for (const key of REQUIRED_KEYS) result[key] = Number.NaN
  return result
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
