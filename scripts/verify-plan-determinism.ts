/**
 * 门禁：`packages/runtime/src/plan/` 的**确定性**（方案 §4.5，0.5 人日、ROI 最高的一条）。
 *
 * ## 为什么值得单独一条门禁
 *
 * P1 一旦做恢复，重放时的不确定时钟/随机数会让结果不一致——而**这种 bug 只在恢复路径出现，
 * 单测抓不到**（单测每次都是新时钟，永远自洽）。这条纪律抄的是 Temporal 的 workflow 确定性约束，
 * 区别是 Temporal 在运行时做沙箱，我们做**静态门禁**（零运行期成本）。
 *
 * ## 两条规则
 *
 * 1. 出现以下任一即失败：`Date.now()` / `new Date()` / `Math.random()` / `randomUUID()` /
 *    `crypto.getRandomValues()`。时钟与随机数必须从构造参数注入（`now()` / `idempotencyKey`）。
 * 2. `plan/` 只许 import `@bah/core` / `@bah/util` / 相对路径。这条防的是"顺手 import 一个
 *    `ToolRegistry` 进来"——那会让引擎认识宿主，`verify-package-graph` 也就被破了。
 *
 * 为什么用 AST 而不是正则：正则会把注释里的 `Date.now()` 也算违规，
 * 而本目录的注释里**必须**能写"这里禁止 Date.now()"这句话。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import ts from 'typescript'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 受检目录（引擎本体）。 */
const PLAN_DIR = 'packages/runtime/src/plan'

/** 允许的裸包导入：宿主依赖只能从这两个包来，且都不承载运行期能力。 */
const ALLOWED_BARE = new Set(['@bah/core', '@bah/util'])

/** 禁止的全局/命名空间调用（按"属性访问全名"匹配）。 */
const FORBIDDEN_CALLS = new Set([
  'Date.now',
  'Math.random',
  'crypto.randomUUID',
  'crypto.getRandomValues',
  'globalThis.crypto.randomUUID',
  'globalThis.crypto.getRandomValues',
])

/** 禁止的裸标识符调用。 */
const FORBIDDEN_IDENTIFIERS = new Set(['randomUUID', 'getRandomValues'])

/** 只扫源码：测试里可以随便用时钟（它们不参与重放）。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

const gate: Gate = {
  name: 'plan-determinism',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const files = walk(root, [PLAN_DIR], isSource).sort()
    let callsChecked = 0
    let importsChecked = 0

    for (const file of files) {
      const where = relative(root, file).split('\\').join('/')
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )

      visit(source, (node) => {
        if (ts.isCallExpression(node)) {
          callsChecked += 1
          const callee = node.expression
          const full = callee.getText(source)
          if (FORBIDDEN_CALLS.has(full)) {
            findings.push(
              `${where}:${String(lineOf(source, node))} 调用了 ${full}——plan 引擎必须用注入的 ` +
                'now()/幂等键，恢复重放才对得上（方案 §4.5）',
            )
          }
          if (ts.isIdentifier(callee) && FORBIDDEN_IDENTIFIERS.has(callee.text)) {
            findings.push(
              `${where}:${String(lineOf(source, node))} 调用了 ${callee.text}()——` +
                'plan 引擎不允许产生随机值（调用 ID 由 planId#nodeId#attempt 派生）',
            )
          }
        }

        if (ts.isNewExpression(node) && node.expression.getText(source) === 'Date') {
          findings.push(
            `${where}:${String(lineOf(source, node))} new Date()——时间戳一律走注入的 now()`,
          )
        }

        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          importsChecked += 1
          const specifier = node.moduleSpecifier.text
          const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
          if (!isRelative && !ALLOWED_BARE.has(specifier)) {
            findings.push(
              `${where}:${String(lineOf(source, node))} import "${specifier}"——` +
                `plan/ 只允许 ${[...ALLOWED_BARE].join(' / ')} 与相对路径（防引擎认识宿主包）`,
            )
          }
        }

        // `import x = require('y')` 与动态 import 也一并挡住
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const first = node.arguments[0]
          if (first !== undefined && ts.isStringLiteral(first)) {
            const specifier = first.text
            const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
            if (!isRelative && !ALLOWED_BARE.has(specifier)) {
              findings.push(
                `${where}:${String(lineOf(source, node))} 动态 import "${specifier}"——同上，只许 ` +
                  `${[...ALLOWED_BARE].join(' / ')} 与相对路径`,
              )
            }
          }
        }
      })
    }

    if (files.length === 0) {
      findings.push(`${PLAN_DIR}: 一个源文件都没扫到（目录改名或门禁扫描面失效）`)
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `扫描 ${String(files.length)} 个源文件：调用 ${String(callsChecked)} 处、导入 ${String(importsChecked)} 处，AST 校验`,
        `禁止项：${[...FORBIDDEN_CALLS].join(' / ')} / new Date() / ${[...FORBIDDEN_IDENTIFIERS].join(' / ')}`,
      ],
    }
  },
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

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
