/**
 * 门禁：Saga 领域类型的两个定义点不得静默分叉（门禁扩容 07 §2-6，**方案已改，见下**）。
 *
 * ## 为什么不是设计说明写的"只允许一份真源"
 *
 * 设计说明 §2-6 要求"`SideEffectClass`/`CompKind` 的唯一真源在 `@bah/saga`，
 * `persistence/src/saga-store/types.ts` 只允许 `import type`"。该方案的**前提不成立**：
 *
 * - 设计说明的取证只看了 `package.json`（pnpm 依赖图），那里确实无环；
 * - 但 `saga/tsconfig.json` 为了给自己的 `src/*.test.ts` 提供类型，**已经** reference 了
 *   `../persistence`；一旦 persistence 反向 reference saga，`tsc -b` 直接报
 *   `TS6202: Project references may not form a circular graph`（实测，非推断）。
 * - 因而 `persistence → saga` 在这套"测试与被测代码同处 src"的工程结构下**做不到**，
 *   除非把 10 个 saga 测试文件搬出 src 并单开 tsconfig——那是另一个量级的改动。
 *
 * 退而求其次但更诚实的目标：**消除"静默分叉"这个真实风险**。两份定义可以并存
 * （`persistence` 文件头已写明为什么不能 import），但语义必须一致：
 *
 * ## 规则
 * 1. 解析两份类型文件，收集顶层 `type X = ...` 与 `interface X { ... }`；
 * 2. **必备项**：`SideEffectClass`、`CompKind` 必须两边都有（防止"删掉一份"这种假修复）；
 * 3. **交集不许分叉**：两边同名的定义必须语义一致：
 *    - 字符串字面量联合 → 比较**成员序列**（含顺序：状态顺序是 SA-00 的书写顺序）；
 *      `(typeof SOME_STATES)[number]` 这种派生写法会先解析到同文件的常量数组再比；
 *    - `interface` / 其他形状 → 去注释、压空白后逐字比。
 * 4. 任一条不满足 → 违规，并指出名字与两侧行号。
 *
 * 代价是"改一处要同步另一处"（门禁会逼你），收益是分叉不再可能悄悄发生。
 */

import { readFileSync } from 'node:fs'

import ts from 'typescript'

import { isMainModule, runStandalone, type Gate, type GateResult } from './gate-lib.ts'

/** 领域类型的两个定义点。 */
const SAGA_TYPES = 'packages/saga/src/types.ts'
const STORE_TYPES = 'packages/persistence/src/saga-store/types.ts'

/** 必须两边都有的类型（防止"删一份"通过）。 */
const REQUIRED = ['SideEffectClass', 'CompKind']

/** 一处顶层类型定义。 */
interface Definition {
  readonly name: string
  /** 规范化后的形状（联合取 `union:a|b`，其余取压空白文本）。 */
  readonly shape: string
  readonly line: number
}

const gate: Gate = {
  name: 'single-saga-types',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const saga = definitionsOf(root, SAGA_TYPES, findings)
    const store = definitionsOf(root, STORE_TYPES, findings)
    if (saga.size === 0 || store.size === 0) return { ok: false, findings, notes: [] }

    for (const name of REQUIRED) {
      if (!saga.has(name)) findings.push(`${SAGA_TYPES}: 缺少必备类型 ${name}`)
      if (!store.has(name)) findings.push(`${STORE_TYPES}: 缺少必备类型 ${name}`)
    }

    let shared = 0
    for (const [name, left] of saga) {
      const right = store.get(name)
      if (right === undefined) continue
      shared += 1
      if (left.shape === right.shape) continue

      findings.push(
        `${name} 在两个定义点已分叉：${SAGA_TYPES}:${left.line} 与 ${STORE_TYPES}:${right.line}（改一处必须同步另一处）`,
      )
      findings.push(describeDifference(left.shape, right.shape))
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `saga ${saga.size} 个定义、store ${store.size} 个定义、同名 ${shared} 个逐一比对`,
        '方案说明：persistence 无法 reference saga（TS6202 环），故本门禁锁"不分叉"而非"单一真源"',
      ],
    }
  },
}

/** 收集顶层 type / interface 定义。 */
function definitionsOf(root: string, path: string, findings: string[]): Map<string, Definition> {
  const found = new Map<string, Definition>()
  let text: string
  try {
    text = readFileSync(`${root}/${path}`, 'utf8')
  } catch (error) {
    findings.push(`${path}: 无法读取（${error instanceof Error ? error.message : String(error)}）`)
    return found
  }

  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const consts = constArraysOf(source)

  for (const statement of source.statements) {
    if (!ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) continue
    const name = statement.name.text
    if (found.has(name)) {
      findings.push(`${path}: ${name} 在同一文件内定义了两次`)
      continue
    }
    const members = ts.isTypeAliasDeclaration(statement) ? unionMembers(statement.type, consts) : undefined
    found.set(name, {
      name,
      shape: members === undefined ? normalize(statement.getText(source)) : `union:${members.join('|')}`,
      line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
    })
  }
  return found
}

/** 同文件里的 `const X = ['a','b'] as const` 成员表（派生联合的展开依据）。 */
function constArraysOf(source: ts.SourceFile): Map<string, string[]> {
  const table = new Map<string, string[]>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const members = arrayMembers(declaration.initializer)
      if (members !== undefined) table.set(declaration.name.text, members)
    }
  }
  return table
}

/** 数组字面量的字符串成员（支持 `as const` / `satisfies` 包裹）。 */
function arrayMembers(node: ts.Expression | undefined): string[] | undefined {
  if (node === undefined) return undefined
  if (ts.isArrayLiteralExpression(node)) {
    const members: string[] = []
    for (const element of node.elements) {
      if (!ts.isStringLiteral(element)) return undefined
      members.push(element.text)
    }
    return members
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return arrayMembers(node.expression)
  return undefined
}

/**
 * 联合类型的字符串成员：`'a'|'b'` 或 `(typeof STATES)[number]`。
 *
 * 返回 `undefined` 表示"不是字符串字面量联合"，调用方退回文本比较。
 */
function unionMembers(node: ts.TypeNode, consts: ReadonlyMap<string, string[]>): string[] | undefined {
  const inner = unwrap(node)

  if (ts.isUnionTypeNode(inner)) {
    const members: string[] = []
    for (const member of inner.types) {
      const value = singleMember(member, consts)
      if (value === undefined) return undefined
      members.push(...value)
    }
    return members
  }
  return singleMember(inner, consts)
}

/** 单个成员：字面量，或 `(typeof X)[number]` 指向的常量数组。 */
function singleMember(
  node: ts.TypeNode,
  consts: ReadonlyMap<string, string[]>,
): string[] | undefined {
  const inner = unwrap(node)
  if (ts.isLiteralTypeNode(inner) && ts.isStringLiteral(inner.literal)) return [inner.literal.text]

  // `(typeof SAGA_STATES)[number]`
  if (ts.isIndexedAccessTypeNode(inner) && inner.indexType.kind === ts.SyntaxKind.NumberKeyword) {
    const target = unwrap(inner.objectType)
    if (ts.isTypeQueryNode(target)) {
      const name = target.exprName.getText()
      return consts.get(name)
    }
  }
  return undefined
}

/** 去掉括号类型（`(typeof X)` 的括号在 AST 上是 ParenthesizedTypeNode）。 */
function unwrap(node: ts.TypeNode): ts.TypeNode {
  let current = node
  while (ts.isParenthesizedTypeNode(current)) current = current.type
  return current
}

/** 规范化：去注释、压空白、去尾随逗号/分号。 */
function normalize(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}()<>|&:=,;[\]])\s*/g, '$1')
    .replace(/[,;](?=[}\]])/g, '')
    .trim()
}

/**
 * 指出第一处分叉点，而不是把两段长文本都贴出来。
 *
 * 两份定义常常只差一个成员（例如 store 多一个 `'DRIFTED'`），截断预览会把差异藏在省略号里，
 * 读的人还得自己肉眼比对。
 */
function describeDifference(left: string, right: string): string {
  const floor = Math.min(left.length, right.length)
  let index = 0
  while (index < floor && left[index] === right[index]) index += 1
  const from = Math.max(0, index - 24)
  const to = index + 48
  const window = (text: string): string => `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
  return `    首个差异在第 ${index + 1} 字符：saga「${window(left)}」 / store「${window(right)}」`
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
