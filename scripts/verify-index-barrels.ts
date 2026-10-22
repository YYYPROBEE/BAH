/**
 * 门禁：覆盖率排除项必须是**纯 barrel**（BAH 代码修改清单 2026-10-20 · B1.1）。
 *
 * 旧 `vitest.config.ts` 用 `**\/index.ts` 一次排除所有入口，顺手排掉了四个实现文件。
 * 现在排除项改为 `scripts/barrel-excludes.ts` 的显式名单；本门禁保证名单不腐化：
 *
 * 1. 每条路径存在、以 `index.ts` 结尾、无重复；
 * 2. 用 TypeScript AST 逐条检查：只允许带模块说明符的 `export ... from`（含 `export *`），
 *    任何函数/类/常量/接口/默认导出都视为实现，直接失败；
 * 3. 名单里的文件必须真的落在覆盖率 include 面内（否则是无效排除，提示删除）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

import { BARREL_EXCLUSIONS } from './barrel-excludes.ts'
import { COVERAGE_ALLOWLIST } from './coverage-allowlist.ts'
import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'

const gate: Gate = {
  name: 'index-barrels',

  async run(root) {
    const findings: string[] = []
    const seen = new Set<string>()

    for (const entry of BARREL_EXCLUSIONS) {
      if (seen.has(entry.path)) {
        findings.push(`${entry.path}: 在 barrel 排除名单里重复出现`)
        continue
      }
      seen.add(entry.path)

      if (!entry.path.endsWith('index.ts')) {
        findings.push(`${entry.path}: 只有 index.ts 可以作为 barrel 排除项`)
        continue
      }
      if (entry.why.trim().length === 0) {
        findings.push(`${entry.path}: barrel 排除项必须写明 why`)
      }

      let text: string
      try {
        text = readFileSync(join(root, entry.path), 'utf8')
      } catch {
        findings.push(`${entry.path}: 文件不存在（目录改名或误删后未同步名单）`)
        continue
      }

      const source = ts.createSourceFile(
        entry.path,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      let reexports = 0
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement)) {
          const specifier = statement.moduleSpecifier
          if (specifier === undefined || !ts.isStringLiteral(specifier)) {
            findings.push(
              `${entry.path}:${lineOf(source, statement)} 只允许「export ... from '<module>'」形式`,
            )
            continue
          }
          reexports += 1
          continue
        }
        findings.push(
          `${entry.path}:${lineOf(source, statement)} 含实现语句（${ts.SyntaxKind[statement.kind]}），不能作为 barrel 排除`,
        )
      }
      if (reexports === 0) {
        findings.push(`${entry.path}: 没有任何 re-export，不是有效的模块入口`)
      }
      if (!isInCoverageSurface(entry.path)) {
        findings.push(`${entry.path}: 不在覆盖率 include 面内，排除项无效（请从名单删除）`)
      }
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [`显式 barrel 排除 ${BARREL_EXCLUSIONS.length} 个，AST 逐条校验存在性与纯度`],
    }
  },
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

/** 该路径是否会被 allowlist 的 include 模式统计到。 */
function isInCoverageSurface(path: string): boolean {
  for (const entry of COVERAGE_ALLOWLIST) {
    const prefix = `packages/${entry.package}/src/`
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (entry.scope === '' || entry.scope === rest) return true
    if (!entry.scope.endsWith('.ts') && rest.startsWith(entry.scope)) return true
  }
  return false
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
