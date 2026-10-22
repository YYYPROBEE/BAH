/**
 * 门禁：会话事件与接缝事件的**声明一致性**
 * （BAH 代码修改清单 2026-10-20 · B1.4）。
 *
 * 旧版把“任意带引号的键”都当成事件声明（注释、普通对象字面量都能骗过门禁）。
 * 新版用 TypeScript AST：
 * 1. 声明集合 = 所有 `SessionEventMap` / `*SessionEventMap` 接口的字符串键
 *    + 所有 `*_SESSION_EVENT_TYPES` 常量数组的字符串元素；
 * 2. `session` / `audit` 接收者的 `append(...)` 必须是字面量事件名，且已声明；
 *    动态事件名直接失败（`session/service.ts` 的通用转发除外）；
 * 3. `SESSION_EVENT_TYPES` 必须与 `session/types.ts` 的平台接口逐键一致；
 * 4. `deriveMessages(` 仍只允许出现在投影/主循环/提示词/模型层。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import ts from 'typescript'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** 会话事件表的权威文件（相对仓库根）。 */
const SESSION_TYPES = 'packages/runtime/src/session/types.ts'

/** 允许调用 `deriveMessages(` 的路径前缀。 */
const DERIVE_WHITELIST = [
  'packages/runtime/src/session/',
  'packages/runtime/src/agent-loop/',
  'packages/runtime/src/system-prompt/',
  'packages/llm/',
] as const

/** 通用转发实现（事件名由调用方给出，本身不构成声明点）。 */
const APPEND_FORWARDER = 'packages/runtime/src/session/service.ts'

/** 只扫包内源码；测试不构成契约。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

const gate: Gate = {
  name: 'session-events',

  async run(root) {
    const files = walk(root, ['packages', 'apps'], isSource)
    const declared = new Set<string>()
    const findings: string[] = []
    let appendCalls = 0

    // 第一遍：先收齐全仓声明，再校验调用点（否则按文件顺序会误报）。
    const sources = files.map((file) => ({
      file,
      where: toPosix(relative(root, file)),
      source: createSource(file),
    }))
    for (const entry of sources) {
      visit(entry.source, (node) => {
        collectInterfaceKeys(node, declared)
        collectTypeArrayKeys(node, declared)
      })
    }

    // 第二遍：调用点校验。
    for (const { where, source } of sources) {
      visit(source, (node) => {
        if (!ts.isCallExpression(node)) return
        if (ts.isIdentifier(node.expression) && node.expression.text === 'deriveMessages') {
          if (!DERIVE_WHITELIST.some((prefix) => where.startsWith(prefix))) {
            findings.push(
              `${where}:${lineOf(source, node)} deriveMessages 只允许在 session / agent-loop / system-prompt / llm 内调用（施工单 03 §1.4 硬门禁）`,
            )
          }
        }

        const receiver = appendReceiver(source, node)
        if (receiver === undefined) return
        const first = node.arguments[0]
        const line = lineOf(source, node)
        const isSessionReceiver = /session$/i.test(receiver)
        if (first === undefined || !ts.isStringLiteral(first)) {
          if (isSessionReceiver && where !== APPEND_FORWARDER) {
            findings.push(
              `${where}:${line} ${receiver}.append 的事件名必须是字符串字面量（动态拼接无法静态校验）`,
            )
          }
          // audit.append 也可能是 saga 的 `audit.append(sagaId, 'event', data)`：
          // 首参不是字符串时不按会话事件解释（saga 事件由 event-modes 门禁负责）。
          return
        }
        appendCalls += 1
        if (!declared.has(first.text)) {
          findings.push(
            `${where}:${line} 事件 "${first.text}" 未在 ${SESSION_TYPES} / 领域 ` +
              `*SessionEventMap 里声明（施工单 03 §1.2）`,
          )
        }
      })
    }

    if (declared.size === 0) {
      findings.push('没有解析到任何会话事件声明：事件表缺失，门禁拒绝通过')
    }
    if (appendCalls === 0) {
      findings.push('全仓没有 session/audit.append 调用：扫描面或解析规则失效，门禁拒绝通过')
    }

    findings.push(...checkPlatformTable(root))

    return {
      ok: findings.length === 0,
      findings,
      notes: [`声明事件 ${declared.size} 个，session/audit.append 调用 ${appendCalls} 处，AST 校验`],
    }
  },
}

/** 平台事件数组必须与平台接口逐键一致（防止数组与类型表分叉）。 */
function checkPlatformTable(root: string): string[] {
  const path = `${root}/${SESSION_TYPES}`
  let source: ts.SourceFile
  try {
    source = createSource(path)
  } catch {
    return [`${SESSION_TYPES}: 无法读取（平台事件表必须存在）`]
  }

  const arrayKeys = new Set<string>()
  const interfaceKeys = new Set<string>()
  visit(source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'SESSION_EVENT_TYPES' &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(unwrapExpression(node.initializer))
    ) {
      for (const element of unwrapExpression(node.initializer).elements) {
        if (ts.isStringLiteral(element)) arrayKeys.add(element.text)
      }
    }
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'SessionEventMap') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name !== undefined && ts.isStringLiteral(member.name)) {
          interfaceKeys.add(member.name.text)
        }
      }
    }
  })

  const findings: string[] = []
  for (const key of arrayKeys) {
    if (!interfaceKeys.has(key)) {
      findings.push(`${SESSION_TYPES}: SESSION_EVENT_TYPES 含 "${key}"，但 SessionEventMap 没有声明`)
    }
  }
  for (const key of interfaceKeys) {
    if (!arrayKeys.has(key)) {
      findings.push(`${SESSION_TYPES}: SessionEventMap 声明了 "${key}"，但 SESSION_EVENT_TYPES 缺项`)
    }
  }
  return findings
}

/** 收集 `XxxSessionEventMap` 接口的字符串键。 */
function collectInterfaceKeys(node: ts.Node, out: Set<string>): void {
  if (!ts.isInterfaceDeclaration(node)) return
  if (!node.name.text.endsWith('SessionEventMap')) return
  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name !== undefined && ts.isStringLiteral(member.name)) {
      out.add(member.name.text)
    }
  }
}

/** 收集 `*_SESSION_EVENT_TYPES` 常量数组的字符串元素。 */
function collectTypeArrayKeys(node: ts.Node, out: Set<string>): void {
  if (!ts.isVariableDeclaration(node)) return
  if (!ts.isIdentifier(node.name) || !node.name.text.includes('SESSION_EVENT_TYPES')) return
  if (node.initializer === undefined) return
  const initializer = unwrapExpression(node.initializer)
  if (!ts.isArrayLiteralExpression(initializer)) return
  for (const element of initializer.elements) {
    if (ts.isStringLiteral(element)) out.add(element.text)
  }
}

/** 去掉 `as const` / `satisfies T` / 括号，拿到真实表达式。 */
function unwrapExpression(expression: ts.Expression): ts.Expression {
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

/**
 * 如果这是 `session.append(...)` / `audit.append(...)`，返回接收者文本。
 *
 * 只认名字以 session / audit 结尾的接收者：`trace.append({...})`、`file.append(...)`
 * 不是会话事件通道，不参与本门禁。
 */
function appendReceiver(source: ts.SourceFile, node: ts.CallExpression): string | undefined {
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'append') return undefined
  const receiver = callee.expression.getText(source)
  return /(?:session|audit)$/i.test(receiver) ? receiver : undefined
}

function createSource(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
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
