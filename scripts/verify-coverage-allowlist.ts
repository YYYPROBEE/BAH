/**
 * 门禁：覆盖率强制名单必须逐条命中真实源码（BAH 代码修改清单 2026-10-20 · B1.1）。
 *
 * 防止三种“名单腐化”导致的假绿：
 * 1. 目录改名 / 文件删除后，scope 静默匹配 0 个文件；
 * 2. 同一 package+scope 重复登记（后一条永远不会被单独验证）；
 * 3. 条目没有 why（评审无法判断为什么强制 100%）。
 */

import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'

import { COVERAGE_ALLOWLIST } from './coverage-allowlist.ts'
import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** 覆盖率统计的源码：排除测试与声明文件（与 vitest 口径一致）。 */
const isCoveredSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

const gate: Gate = {
  name: 'coverage-allowlist',

  async run(root) {
    const findings: string[] = []
    const seen = new Set<string>()
    let totalFiles = 0

    for (const entry of COVERAGE_ALLOWLIST) {
      const label = `${entry.package}/${entry.scope === '' ? '<all>' : entry.scope}`
      if (entry.why.trim().length === 0) {
        findings.push(`${label}: 缺少 why（必须说明为什么强制 100% 覆盖）`)
      }

      const key = `${entry.package}\u0000${entry.scope}`
      if (seen.has(key)) {
        findings.push(`${label}: 在覆盖率名单里重复登记`)
        continue
      }
      seen.add(key)

      const packageDir = join(root, 'packages', entry.package)
      if (!existsSync(packageDir)) {
        findings.push(`${label}: 包目录不存在（packages/${entry.package}）`)
        continue
      }

      const sources = walk(root, [`packages/${entry.package}/src`], isCoveredSource).filter(
        (file) => matchesScope(toPosix(relative(root, file)), entry.package, entry.scope),
      )
      if (sources.length === 0) {
        findings.push(`${label}: scope 命中 0 个源码文件（目录改名或 scope 写错）`)
        continue
      }
      totalFiles += sources.length
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `覆盖率名单 ${COVERAGE_ALLOWLIST.length} 条，命中 ${totalFiles} 个源码文件（去重前）`,
      ],
    }
  },
}

/** 与 `vitest.config.ts` 的 include 规则保持一致。 */
function matchesScope(rel: string, pkg: string, scope: string): boolean {
  const prefix = `packages/${pkg}/src/`
  if (!rel.startsWith(prefix)) return false
  const rest = rel.slice(prefix.length)
  if (scope === '') return true
  return scope.endsWith('.ts') ? rest === scope : rest.startsWith(scope)
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
