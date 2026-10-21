/**
 * 门禁：判别标签 switch 必须收尾（门禁扩容 07 §2-1；`AGENTS.md` 编码纪律第 6 条）。
 *
 * 规则：
 * 1. 遍历各包 `src` 下的全部非测试源码的 `SwitchStatement`；
 * 2. `caseBlock.clauses` 必须含 `default`，或含以 `assertNever(...)` 结尾的语句，二者至少其一；
 * 3. 两者皆无 → 违规。
 *
 * 已知粒度限制（显式登记，不假装没有）：TypeScript 的 AST 无法可靠区分"封闭联合上的 switch"
 * 与"对 `string` / `number` 等开放类型做的穷举分支"。本门禁按"凡 switch 皆须收尾"的**严口径**
 * 执行；确需无收尾的穷举，走 `scripts/assert-never-excludes.ts` 的显式名单并写明理由，
 * 不放宽规则本身——放宽一次，后续所有 switch 都会找到借口。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import ts from 'typescript'

import { ASSERT_NEVER_EXCLUSIONS } from './assert-never-excludes.ts'
import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 只扫包内源码，不扫测试与声明。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

/** 一处 switch。 */
interface SwitchSite {
  readonly file: string
  readonly line: number
  /** 判别表达式文本（给人看的定位锚点）。 */
  readonly on: string
}

const gate: Gate = {
  name: 'assert-never',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []
    let total = 0
    let closedByDefault = 0
    let closedByAssertNever = 0
    let excluded = 0

    for (const file of walk(root, ['packages'], isSource)) {
      const text = readFileSync(file, 'utf8')
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const where = relative(root, file).replace(/\\/g, '/')

      const visit = (node: ts.Node): void => {
        if (ts.isSwitchStatement(node)) {
          total += 1
          const site = siteOf(source, where, node)
          const closed = closureOf(node)
          if (closed === 'default') {
            closedByDefault += 1
          } else if (closed === 'assert-never') {
            closedByAssertNever += 1
          } else {
            const exemption = ASSERT_NEVER_EXCLUSIONS.find(
              (entry) => entry.path === site.file && entry.line === site.line,
            )
            if (exemption === undefined) {
              findings.push(
                `${site.file}:${site.line} switch (${site.on}) 既无 default 也无 assertNever 收尾`,
              )
            } else {
              excluded += 1
              notes.push(`例外：${site.file}:${site.line} switch (${site.on}) —— ${exemption.why}`)
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }

    notes.push(
      `switch ${total} 处：default 收尾 ${closedByDefault}、assertNever 收尾 ${closedByAssertNever}、例外 ${excluded}`,
    )

    return { ok: findings.length === 0, findings, notes }
  },
}

/** switch 的收尾形态。 */
function closureOf(node: ts.SwitchStatement): 'default' | 'assert-never' | 'none' {
  let hasDefault = false
  let hasAssertNever = false

  for (const clause of node.caseBlock.clauses) {
    if (clause.statements.some((statement) => callsAssertNever(statement))) hasAssertNever = true
    if (ts.isDefaultClause(clause)) hasDefault = true
  }

  if (hasAssertNever) return 'assert-never'
  return hasDefault ? 'default' : 'none'
}

/**
 * 语句里是否直接调用了 `assertNever(...)`。
 *
 * 只看本层语句：进入嵌套函数或嵌套 switch 就不算本 switch 的收尾
 * （否则 `default: { forEach(() => switch(...)) }` 会被误判为已收尾）。
 */
function callsAssertNever(node: ts.Node): boolean {
  let found = false

  const visit = (current: ts.Node): void => {
    if (found) return
    if (ts.isFunctionLike(current) || ts.isSwitchStatement(current)) return
    if (ts.isCallExpression(current) && isAssertNever(current.expression)) {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }

  visit(node)
  return found
}

/** 调用目标是否是 `assertNever`（支持 `assertNever` 与 `x.assertNever` 两种写法）。 */
function isAssertNever(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'assertNever'
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === 'assertNever'
  return false
}

function siteOf(source: ts.SourceFile, file: string, node: ts.SwitchStatement): SwitchSite {
  return {
    file,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    on: node.expression.getText(source).replace(/\s+/g, ' ').slice(0, 60),
  }
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
