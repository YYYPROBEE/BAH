/**
 * 门禁：模型代码禁入 `none` 档 + 沙箱 worker 加载链零包名依赖
 * （BAH 代码修改清单 2026-10-20 · B1.4）。
 *
 * 旧规则只在“同一行同时出现 `codeSource: 'model'` 与 `'none'`”时报错，
 * 把两者拆到两行/变量就绕过去了。新版用 TypeScript AST：
 *
 * 1. 解析所有 `new SandboxPolicy({...})`：
 *    - `defaults` / `fallbackTier` 解析为 `'none'` → 失败（生产策略不允许把任何工具默认放进 none）；
 *    - 值无法静态解析（变量来自 import / 函数调用）→ 失败（无法证明安全）；
 * 2. 解析所有 `runner.run({...})`：
 *    - 对象里的 `codeSource` 必须是字面量 `model` / `trusted`，变量/拼接 → 失败；
 *    - `codeSource` 与档位同一对象出现 `tier: 'none'` → 失败；
 *    - 接收者像 runner 但参数不是对象字面量 → 失败（无法证明来源）；
 * 3. worker 加载链（worker.ts / language.ts / handlers / testing）只许 `node:` 与相对路径。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import ts from 'typescript'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** worker 加载链：不能 import 包名（真实运行不经 vitest 别名）。 */
const WORKER_SCOPES = [
  'safety/src/sandbox-runtime/worker.ts',
  'safety/src/sandbox-runtime/language.ts',
  'safety/src/sandbox-runtime/handlers/',
  'safety/src/sandbox-runtime/testing/',
] as const

/** import / export 的说明符（静态与动态都算）。 */
const SPECIFIER = /(?:from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\1/g

const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

const gate: Gate = {
  name: 'sandbox',

  async run(root) {
    const findings: string[] = []
    const files = walk(root, ['packages'], isSource)
    let policies = 0
    let runCalls = 0
    let scannedWorkerGraph = 0

    for (const file of files) {
      const where = toPosix(relative(root, file))
      const text = readFileSync(file, 'utf8')
      const source = createSource(file, text)

      visit(source, (node) => {
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'SandboxPolicy'
        ) {
          policies += 1
          const options = node.arguments?.[0]
          findings.push(...checkPolicy(source, where, options))
        }

        if (ts.isCallExpression(node)) {
          const callee = node.expression
          if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'run') {
            const receiver = callee.expression.getText(source)
            if (/runner$/i.test(receiver)) {
              runCalls += 1
              findings.push(...checkRunCall(source, where, node))
            }
          }
        }
      })

      const scope = WORKER_SCOPES.find((prefix) => where.includes(prefix))
      if (scope === undefined) continue
      scannedWorkerGraph += 1
      for (const matched of text.matchAll(SPECIFIER)) {
        const specifier = matched[2] ?? ''
        if (!isAllowedSpecifier(specifier)) {
          findings.push(
            `${where} import "${specifier}" —— worker 加载链只许 node: 与本包相对路径（施工单 11 §3）`,
          )
        }
      }
    }

    if (policies === 0) {
      findings.push('没有找到任何 SandboxPolicy 构造：扫描面或解析规则失效，门禁拒绝通过')
    }
    if (runCalls === 0) {
      findings.push('没有找到任何 runner.run 调用：扫描面或解析规则失效，门禁拒绝通过')
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `AST 校验 ${policies} 个 SandboxPolicy、${runCalls} 个 runner.run 调用`,
        `worker 加载链文件 ${String(scannedWorkerGraph)} 个（零包名 import 校验）`,
      ],
    }
  },
}

/** 校验 `new SandboxPolicy({ defaults, fallbackTier })`。 */
function checkPolicy(
  source: ts.SourceFile,
  where: string,
  options: ts.Expression | undefined,
): string[] {
  const findings: string[] = []
  if (options === undefined) {
    findings.push(`${where}: SandboxPolicy 缺少 options（无法证明默认档位不含 none）`)
    return findings
  }
  const resolved = resolveExpression(source, options)
  if (resolved === undefined || !ts.isObjectLiteralExpression(resolved)) {
    findings.push(`${where}: SandboxPolicy options 不是可解析的对象字面量（拒绝默认通过）`)
    return findings
  }
  const line = lineOf(source, options)
  const defaults = readProperty(resolved, 'defaults')
  if (defaults !== undefined) {
    const defaultsValue = resolveExpression(source, defaults)
    if (defaultsValue === undefined || !ts.isObjectLiteralExpression(defaultsValue)) {
      findings.push(`${where}:${line} SandboxPolicy.defaults 不是可解析的对象字面量`)
    } else {
      for (const property of defaultsValue.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const tier = resolveExpression(source, property.initializer)
        if (tier !== undefined && ts.isStringLiteral(tier) && tier.text === 'none') {
          findings.push(
            `${where}:${lineOf(source, property)} 工具 ${property.name.getText(source)} 的默认档是 none（模型代码禁入；施工单 11 §2）`,
          )
        }
      }
    }
  }

  const fallback = readProperty(resolved, 'fallbackTier')
  if (fallback !== undefined) {
    const tier = resolveExpression(source, fallback)
    if (tier === undefined) {
      findings.push(`${where}:${line} SandboxPolicy.fallbackTier 无法静态解析`)
    } else if (ts.isStringLiteral(tier) && tier.text === 'none') {
      findings.push(`${where}:${line} SandboxPolicy.fallbackTier 是 none（模型代码禁入；施工单 11 §2）`)
    }
  }

  return findings
}

/** 校验一个 `runner.run(request, ...)` 调用。 */
function checkRunCall(
  source: ts.SourceFile,
  where: string,
  call: ts.CallExpression,
): string[] {
  const findings: string[] = []
  const first = call.arguments[0]
  const line = lineOf(source, call)
  if (first === undefined) {
    findings.push(`${where}:${line} runner.run 缺少请求对象`)
    return findings
  }
  const resolved = resolveExpression(source, first)
  if (resolved === undefined || !ts.isObjectLiteralExpression(resolved)) {
    findings.push(
      `${where}:${line} runner.run 的请求不是对象字面量：无法静态证明 codeSource（变量/拼接一律拒绝）`,
    )
    return findings
  }

  const codeSource = readProperty(resolved, 'codeSource')
  if (codeSource === undefined) {
    findings.push(`${where}:${line} runner.run 请求缺少 codeSource（无法证明不是模型代码）`)
  } else {
    const value = resolveExpression(source, codeSource)
    if (value === undefined || !ts.isStringLiteral(value) || !['model', 'trusted'].includes(value.text)) {
      findings.push(
        `${where}:${line} codeSource 必须是字面量 'model' / 'trusted'（变量传入无法静态校验）`,
      )
    }
  }

  const tier = readProperty(resolved, 'tier')
  if (tier !== undefined) {
    const value = resolveExpression(source, tier)
    if (value !== undefined && ts.isStringLiteral(value) && value.text === 'none') {
      findings.push(`${where}:${line} runner.run 请求携带 tier: 'none'（模型代码禁入）`)
    }
  }

  return findings
}

/** 读取对象字面量的同名属性（重复时取最后一个）。 */
function readProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  let found: ts.Expression | undefined
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (property.name.getText().replace(/['"]/g, '') === name) found = property.initializer
  }
  return found
}

/** 解析标识符到同文件的 const 初始化（只做保守的一层/递归解析）。 */
function resolveExpression(source: ts.SourceFile, expression: ts.Expression): ts.Expression | undefined {
  let current = unwrap(expression)
  for (let depth = 0; depth < 8; depth += 1) {
    if (!ts.isIdentifier(current)) return current
    const declaration = findVariable(source, current.text)
    if (declaration === undefined || declaration.initializer === undefined) return undefined
    current = unwrap(declaration.initializer)
  }
  return undefined
}

function findVariable(source: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined
  visit(source, (node) => {
    if (
      found === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node
    }
  })
  return found
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function isAllowedSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  if (!specifier.startsWith('.')) return false
  return specifier.endsWith('.ts') || specifier.endsWith('.js')
}

function createSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function visit(source: ts.SourceFile, callback: (node: ts.Node) => void): void {
  const walkNode = (node: ts.Node): void => {
    callback(node)
    ts.forEachChild(node, walkNode)
  }
  walkNode(source)
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
