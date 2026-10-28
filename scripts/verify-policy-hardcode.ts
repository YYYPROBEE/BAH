/**
 * 门禁：策略硬编码与旧判定路径（03 §7.3）。
 *
 * 五条判据：
 * 1. `escalateTransferTier` 只允许在 `tier.ts`、`policy.ts`（legacy 工厂）出现；
 *    治理平面（`governance.ts`）不得 import/call；
 * 2. `packages/policy/src/**` 不得把 `dailyTransferLimit` / `riskyCallThreshold`
 *    赋成数字字面量（阈值只来自 Config）；
 * 3. 生产 `rules.yml` 不得出现 `dailyTransferLimit` / `dailyLimitCents` 的数值字面量，
 *    也不得在 `when:` 里内联 ≥1000 的金额常量；必须通过 `limits.*` / `params.*` 引用；
 * 4. 生产 `rules.yml` 不得出现 `lower:` / `level:` 写死级别（DSL 没有降级动作）；
 * 5. `bank:tools` 的默认阈值仍只在宿主默认值里（既有 `verify-tiers` 第 4 条）。
 *
 * 负控：把四条扫描器分别喂给"应该被抓"的合成文本，任何一个没报 = 门禁红。
 * 没有这条，正则写错时门禁会安静地放行。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { BANK_TOOL_NAME_SET } from '../packages/bank/src/tools/specs.ts'
import { loadBundle } from '../packages/policy/src/load.ts'
import { describePolicyError } from '../packages/policy/src/errors.ts'
import { kindOf } from '../packages/policy/src/expr/eval.ts'
import type { IrExpr } from '../packages/policy/src/expr/parser.ts'
import type { PolicyIr } from '../packages/policy/src/table.ts'

import { isThresholdName } from './threshold-names.ts'
import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 允许直接引用 legacy 升级函数的文件（相对仓库根、正斜杠）。 */
const LEGACY_ALLOWED = new Set([
  'packages/bank/src/tools/tier.ts',
  'packages/bank/src/tools/policy.ts',
])

/** 对外材料的阈值名册（只拦截两个资金阈值；其余名册由 verify-no-hardcoded-config 管）。 */
const FUND_THRESHOLDS = ['dailyTransferLimit', 'riskyCallThreshold'] as const

const gate: Gate = {
  name: 'policy-hardcode',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const bankFiles = walk(
      root,
      ['packages/bank/src/tools'],
      (name) => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts'),
    )
    let scannedBank = 0
    for (const file of bankFiles) {
      scannedBank += 1
      const rel = relative(root, file).replace(/\\/g, '/')
      for (const finding of scanLegacyReferences(rel, readFileSync(file, 'utf8'))) {
        findings.push(finding)
      }
    }
    notes.push(`银行工具源码 ${String(scannedBank)} 个：escalateTransferTier 只许出现在 tier/policy`)

    const policyFiles = walk(
      root,
      ['packages/policy/src'],
      (name) => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts'),
    )
    let scannedPolicy = 0
    for (const file of policyFiles) {
      scannedPolicy += 1
      const rel = relative(root, file).replace(/\\/g, '/')
      for (const finding of scanPolicyLiterals(rel, readFileSync(file, 'utf8'))) {
        findings.push(finding)
      }
    }
    notes.push(`策略包源码 ${String(scannedPolicy)} 个：两个资金阈值不得写死`)

    const productionDirs = readProductionDirs(root, findings)
    const toolNames = [...BANK_TOOL_NAME_SET]
    for (const dir of productionDirs) {
      const abs = join(root, dir)
      if (!existsSync(abs)) {
        findings.push(`${dir}: 生产 bundle 目录不存在`)
        continue
      }
      try {
        const result = loadBundle({ dir: abs, toolNames, verifyLock: true, withCorpus: false })
        for (const finding of scanIrLiterals(dir, result.compiled.ir)) findings.push(finding)
      } catch (error) {
        const described = describePolicyError(error)
        findings.push(`${dir}: 生产 bundle 无法编译 ${described.code} —— ${described.message}`)
      }
    }
    notes.push(`生产 bundle ${String(productionDirs.length)} 个：IR 里禁止数字常量（阈值必须走 limits/params）`)

    // 负控：四条扫描器必须对合成样本报错。
    const negatives = [
      scanLegacyReferences('packages/bank/src/tools/governance.ts', 'const x = escalateTransferTier(a, b)'),
      scanLegacyReferences('packages/bank/src/tools/evil.ts', 'escalateTransferTier("yellow", preview)'),
      scanPolicyLiterals('packages/policy/src/evil.ts', 'const dailyTransferLimit = 5000'),
      scanPolicyLiterals('packages/policy/src/evil.ts', 'const riskyCallThreshold: number = 3'),
      scanIrLiterals('policies/evil/1.0.0', badIr()),
    ]
    if (negatives.some((hits) => hits.length === 0)) {
      findings.push('负控失败：至少一条扫描器没有识别出合成违规样本')
    }

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 扫描 legacy 升级函数的引用（只看代码，注释不算引用）。 */
function scanLegacyReferences(rel: string, text: string): string[] {
  const findings: string[] = []
  if (!/\bescalateTransferTier\b/.test(stripTsComments(text))) return findings
  if (LEGACY_ALLOWED.has(rel)) return findings
  findings.push(`${rel}: 直接引用 escalateTransferTier（只允许 tier.ts / policy.ts；03 §7.3 第 1 条）`)
  return findings
}

/** 扫描策略包里的资金阈值字面量（只看代码，注释不算赋值）。 */
function scanPolicyLiterals(rel: string, text: string): string[] {
  const findings: string[] = []
  const code = stripTsComments(text)
  for (const [index, line] of code.split(/\r?\n/).entries()) {
    for (const name of FUND_THRESHOLDS) {
      if (!isThresholdName(name)) continue
      const pattern = new RegExp(`\\b${name}\\b[^\\n]{0,20}?[:=]\\s*-?\\d`)
      if (!pattern.test(line)) continue
      findings.push(
        `${rel}:${String(index + 1)} ${name} 被赋成数字字面量（阈值只来自 Config；03 §7.3 第 2 条）`,
      )
    }
  }
  return findings
}

/**
 * 扫描生产 bundle 的 **IR**：任何 `when` 里的数字字面量都算写死阈值。
 *
 * 为什么不扫 `rules.yml` 文本：manifest 的 `rulesFile` 可以是任意简单文件名，
 * 只读 `rules.yml` 会被"诱饵文件"绕过；IR 是编译后的唯一执行形态，不存在第二个入口。
 * `lower` / `level` 写死级别由编译器直接拒绝（`policy-lower-tier`），无需重复文本扫描。
 */
function scanIrLiterals(dir: string, ir: PolicyIr): string[] {
  const findings: string[] = []
  for (const table of ir.tables) {
    for (const row of table.rows) {
      if (!hasIntLiteral(row.when)) continue
      findings.push(
        `${dir}: 规则 ${row.id} 的 when 内联了数字常量（金额阈值/边界必须走 limits/params；03 §7.3 第 3 条）`,
      )
    }
  }
  return findings
}

/** 表达式里是否含整数字面量。 */
function hasIntLiteral(node: IrExpr): boolean {
  const kind = kindOf(node)
  if (kind === 'int') return true
  if (kind === 'unary') return hasIntLiteral((node as { arg: IrExpr }).arg)
  if (kind === 'binary') {
    const binary = node as { left: IrExpr; right: IrExpr }
    return hasIntLiteral(binary.left) || hasIntLiteral(binary.right)
  }
  return false
}

/** 负控用的坏 IR：一条规则内联了 5000。 */
function badIr(): PolicyIr {
  return {
    tables: [
      {
        id: 't',
        hit: 'first',
        rows: [{ id: 'R-1', when: { int: 5000 }, action: { kind: 'keep' } }],
      },
    ],
  } as unknown as PolicyIr
}

/** 去 TS 注释（块注释 + 行注释）。字符串里的 `//` 会误删，但扫描器只找名字，不会因此漏报。 */
function stripTsComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 从 registry 取生产 bundle 目录（`demo !== true`）。 */
function readProductionDirs(root: string, findings: string[]): string[] {
  const path = join(root, 'policies/registry.json')
  if (!existsSync(path)) {
    findings.push('缺 policies/registry.json（无法判定哪些是生产 bundle）')
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    findings.push('policies/registry.json: 不是合法 JSON')
    return []
  }
  const kinds = (parsed as { kinds?: unknown }).kinds
  if (typeof kinds !== 'object' || kinds === null) {
    findings.push('policies/registry.json: kinds 必须是对象')
    return []
  }
  const dirs: string[] = []
  for (const value of Object.values(kinds)) {
    const versions = (value as { versions?: unknown }).versions
    if (typeof versions !== 'object' || versions === null) continue
    for (const entry of Object.values(versions)) {
      const raw = entry as { path?: unknown; demo?: unknown }
      if (typeof raw.path !== 'string' || raw.demo === true) continue
      dirs.push(raw.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    }
  }
  return dirs.sort()
}

if (isMainModule(import.meta.url)) await runStandalone(gate)

export { gate }
