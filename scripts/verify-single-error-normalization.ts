/**
 * 门禁：错误归一化只允许一份实现（门禁扩容 07 §2-5；`tech-debt-review` P1-1）。
 *
 * 规则：
 * 1. AST 扫描全部非测试源码，找 `errorCodeOf` / `reasonOf` / `messageOf` 的定义
 *    （函数声明与 `const f = (...) => ...` 两种形态）；
 * 2. 只允许出现在 `@bah/util`（真源）；其他包内重新定义 → 违规。
 *
 * ⚠️ **本门禁锁的是"不许重新复制实现"，不是"不许有多个兜底码"。**
 *
 * `docs/tech-debt-review-2026-10-20.md` 风险提示 3 明确指出：`tool-failed` 与 `verify-failed`
 * 的差异是**有意的**——调用方按 code 分支决定是否重试，强行统一会丢失可判别性。
 * 因此 `@bah/util` 的实现把兜底码作为显式参数（`errorCodeOf(e, 'verify-failed')`），
 * 门禁**不检查**"全仓兜底码唯一"。这条写错方向就会把 P1-1 的成果变成新的债。
 *
 * 唯一例外是 worker 加载链上的文件（零包名 import 硬约束），登记在
 * `scripts/error-normalization-excludes.ts`，按"路径 + 函数名"精确匹配。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import ts from 'typescript'

import { ERROR_NORMALIZATION_EXCLUSIONS } from './error-normalization-excludes.ts'
import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 归一化函数名册：同一语义的四种写法（`describeThrown` 是内核侧的历史名字）。 */
const NAMES = new Set(['errorCodeOf', 'reasonOf', 'messageOf', 'describeThrown'])

/** 唯一真源：`@bah/util` 的源目录。 */
const CANONICAL = 'packages/util/src/'

/** 只扫包内源码，不扫测试与声明。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

/** 一处重复定义。 */
interface Definition {
  readonly file: string
  readonly line: number
  readonly name: string
}

const gate: Gate = {
  name: 'single-error-normalization',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []
    let canonical = 0
    let exempted = 0

    for (const file of walk(root, ['packages'], isSource)) {
      const where = relative(root, file).replace(/\\/g, '/')
      const text = readFileSync(file, 'utf8')
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

      for (const definition of definitionsIn(source, where)) {
        if (where.startsWith(CANONICAL)) {
          canonical += 1
          continue
        }
        const exemption = ERROR_NORMALIZATION_EXCLUSIONS.find(
          (entry) => entry.path === where && entry.name === definition.name,
        )
        if (exemption !== undefined) {
          exempted += 1
          notes.push(`例外：${definition.file}:${definition.line} ${definition.name} —— ${exemption.why}`)
          continue
        }
        findings.push(
          `${definition.file}:${definition.line} 重复实现 ${definition.name}（唯一真源在 @bah/util；施工单 07 §2-5 / P1-1）`,
        )
      }
    }

    notes.push(
      `@bah/util 内命中 ${canonical} 处真源实现；例外 ${exempted} 处（worker 加载链）`,
    )

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 收集一个文件里的归一化函数定义。 */
function definitionsIn(source: ts.SourceFile, file: string): Definition[] {
  const found: Definition[] = []

  const add = (node: ts.Node, name: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    found.push({ file, line, name })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && NAMES.has(node.name.text)) {
      add(node, node.name.text)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && NAMES.has(node.name.text)) {
      if (node.initializer !== undefined && isFunctionLike(node.initializer)) add(node, node.name.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return found
}

/** 箭头函数 / 函数表达式（`const f = function () {}`）。 */
function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
