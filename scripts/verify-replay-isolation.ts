/**
 * 门禁：独立重放的 import 传递闭包只允许 persistence / eval / util / node。
 *
 * 为什么必须机械检查：W15 的核心承诺是"重放不启动 Agent、不调模型、不调工具"。
 * 只要 `replay.ts`（或其相对 import 的任何文件）value-import 了
 * `@bah/host` / `@bah/cli` / `@bah/runtime` / `@bah/llm` / `@bah/safety`，
 * 这个承诺就不成立——人眼看代码挡不住下一次"顺手 import 一个 boot"。
 *
 * 规则：
 * - 只看 **value import / value export**（`import type` / `export type` 不产生运行时依赖）；
 * - 相对 import 递归跟进（含 export * from 相对路径）；
 * - 允许的 bare package：`@bah/persistence` / `@bah/eval` / `@bah/util` / `node:*`；
 * - 其它 bare package（含 `@bah/core` 的 value import）一律红。
 *
 * 单独运行：`npx tsx scripts/verify-replay-isolation.ts [--entry <file>]`
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import ts from 'typescript'

import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'

/** 允许的 bare package 前缀（`@bah/llm/mock` 也会按前缀判断，但 llm 不在白名单）。 */
const ALLOWED_PACKAGES = ['@bah/persistence', '@bah/eval', '@bah/util'] as const
/** Node 内建模块。 */
const NODE_PREFIX = 'node:'
/** 默认入口。 */
const DEFAULT_ENTRY = 'scripts/replay.ts'

const gate: Gate = {
  name: 'replay-isolation',

  async run(root) {
    const entry = process.env['BAH_REPLAY_ENTRY'] ?? DEFAULT_ENTRY
    const result = scanClosure(root, entry)
    return {
      ok: result.findings.length === 0,
      // `scanClosure` 返回 readonly 数组（闭包扫描结果不可回写）；
      // `GateResult.findings` 是可变数组（run-gates 会汇总拼接），这里显式拷贝。
      findings: [...result.findings],
      notes: [
        `入口 ${entry}：扫描 ${String(result.files.length)} 个文件；` +
          `允许 ${ALLOWED_PACKAGES.join(' / ')}（@bah/eval 只许子路径，根入口禁止） / ${NODE_PREFIX}*；value import 递归闭包`,
      ],
    }
  },
}

/** 扫描一个入口文件的 value import 传递闭包。 */
export function scanClosure(
  root: string,
  entry: string,
): { readonly files: readonly string[]; readonly findings: readonly string[] } {
  const start = resolve(root, entry)
  const visited = new Set<string>()
  const findings: string[] = []

  const visit = (file: string, importedFrom: string): void => {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) return
    if (visited.has(file)) return
    visited.add(file)
    if (!existsSync(file)) {
      findings.push(`${toPosix(relative(root, importedFrom))}: 无法解析 import → ${file}`)
      return
    }
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const where = toPosix(relative(root, file))
    for (const specifier of valueSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        const target = resolveSpecifier(dirname(file), specifier)
        if (target === undefined) {
          findings.push(`${where}: 无法解析相对 import ${specifier}`)
          continue
        }
        visit(target, file)
        continue
      }
      if (specifier.startsWith(NODE_PREFIX)) continue
      // `@bah/eval` 的根入口会拉入 runner → host；重放只能用相对路径引 evidence/snapshot 子模块。
      if (specifier === '@bah/eval') {
        findings.push(
          `${where}: 禁止 value import @bah/eval 根入口（会拉入 runner→host）；请相对导入 evidence/snapshot`,
        )
        continue
      }
      const allowed = ALLOWED_PACKAGES.some(
        (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
      )
      if (!allowed) {
        findings.push(`${where}: 禁止 value import ${specifier}（重放只许 persistence/eval/util/node）`)
      }
      // 白名单包视为叶子：它们自己的依赖图由 package-graph 门禁负责。
    }
  }

  if (!existsSync(start)) {
    return { files: [], findings: [`replay-isolation: 入口不存在：${entry}`] }
  }
  visit(start, start)
  return { files: [...visited].map((file) => toPosix(relative(root, file))).sort(), findings }
}

/** 只取会产生运行时依赖的 import / export 说明符。 */
function valueSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly !== true) {
        specifiers.push(node.moduleSpecifier.getText(source).replace(/^['"]|['"]$/g, ''))
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly !== true && node.moduleSpecifier !== undefined) {
        specifiers.push(node.moduleSpecifier.getText(source).replace(/^['"]|['"]$/g, ''))
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      if (arg !== undefined && ts.isStringLiteral(arg)) specifiers.push(arg.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

/** 相对说明符 → 文件（`.ts` / `/index.ts`）。 */
function resolveSpecifier(fromDir: string, specifier: string): string | undefined {
  const base = resolve(fromDir, specifier)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate
  }
  return undefined
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

export { gate }

if (isMainModule(import.meta.url)) {
  const inline = process.argv.find((arg) => arg.startsWith('--entry='))
  if (inline !== undefined) process.env['BAH_REPLAY_ENTRY'] = inline.slice('--entry='.length)
  const index = process.argv.indexOf('--entry')
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (value !== undefined) process.env['BAH_REPLAY_ENTRY'] = value
  await runStandalone(gate)
}
