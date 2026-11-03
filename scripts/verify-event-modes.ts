/**
 * 门禁：事件的 `@mode` 声明必须与派发点一致
 * （BAH 代码修改清单 2026-10-20 · B1.4）。
 *
 * 旧版是词法骨架：零声明/零派发也算通过，注释里的 `'x':` 会被当成声明。
 * 新版用 TypeScript AST：
 * - 只认 `interface BahEventMap` 的真实成员（含模块增强），每个键必须有 `@mode`；
 * - 派发点必须用**字符串字面量**事件名；核心事件系统之外的动态事件名直接失败；
 * - 声明表为空或派发点为空都算失败（不再有“骨架期放行”）。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import ts from 'typescript'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

const MODES = new Set(['emit', 'serial', 'parallel', 'waterfall', 'bail'])

/** 事件系统自身的动态派发实现（`name` 变量的唯一合法去处）。 */
const DYNAMIC_DISPATCH_WHITELIST = ['packages/core/src/context.ts', 'packages/core/src/events.ts']

/** 只扫包内源码，不扫产物、声明文件与测试。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

interface Declaration {
  readonly file: string
  readonly line: number
  readonly event: string
  readonly mode: string
}

interface Dispatch {
  readonly file: string
  readonly line: number
  readonly event: string
  readonly mode: string
  readonly dynamic: boolean
}

const gate: Gate = {
  name: 'event-modes',

  async run(root) {
    const files = walk(root, ['packages', 'apps'], isSource)
    const declarations: Declaration[] = []
    const dispatches: Dispatch[] = []

    for (const file of files) {
      const where = toPosix(relative(root, file))
      const source = createSource(file)
      visit(source, (node) => {
        if (ts.isInterfaceDeclaration(node) && node.name.text === 'BahEventMap') {
          declarations.push(...readDeclarations(source, where, node))
        }
        if (ts.isCallExpression(node)) {
          const dispatch = readDispatch(source, where, node)
          if (dispatch !== undefined) dispatches.push(dispatch)
        }
      })
    }

    const findings: string[] = []
    if (declarations.length === 0) {
      findings.push('BahEventMap 里没有任何逐键声明：事件总表缺失，门禁拒绝通过')
    }
    if (dispatches.length === 0) {
      findings.push('全仓没有字面量事件派发点：门禁拒绝通过（扫描面或解析规则失效）')
    }

    const declared = new Map<string, Declaration>()
    for (const entry of declarations) {
      const previous = declared.get(entry.event)
      if (previous !== undefined && previous.mode !== entry.mode) {
        findings.push(
          `${entry.file}:${entry.line} 事件 "${entry.event}" 重复声明且 mode 冲突（${previous.mode} vs ${entry.mode}，另见 ${previous.file}:${previous.line}）`,
        )
        continue
      }
      if (previous === undefined) declared.set(entry.event, entry)
    }

    for (const dispatch of dispatches) {
      if (dispatch.dynamic) {
        if (!DYNAMIC_DISPATCH_WHITELIST.includes(dispatch.file)) {
          findings.push(
            `${dispatch.file}:${dispatch.line} 动态事件名派发（${dispatch.mode}）：事件名必须是字面量，否则无法静态校验`,
          )
        }
        continue
      }
      const declaration = declared.get(dispatch.event)
      if (declaration === undefined) {
        findings.push(
          `${dispatch.file}:${dispatch.line} 事件 "${dispatch.event}" 按 ${dispatch.mode} 派发，但没有对应的 @mode 声明`,
        )
        continue
      }
      if (declaration.mode !== dispatch.mode) {
        findings.push(
          `${dispatch.file}:${dispatch.line} 事件 "${dispatch.event}" 声明为 ${declaration.mode}，实际按 ${dispatch.mode} 派发（声明点 ${declaration.file}:${declaration.line}）`,
        )
      }
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `声明 ${declarations.length} 个、派发 ${dispatches.length} 处（字面量 ${dispatches.filter((item) => !item.dynamic).length}），AST 逐条比对`,
      ],
    }
  },
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

/** 读取一个 `interface BahEventMap` 的字符串键与紧贴的 `@mode`。 */
function readDeclarations(
  source: ts.SourceFile,
  file: string,
  node: ts.InterfaceDeclaration,
): Declaration[] {
  const found: Declaration[] = []
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || member.name === undefined) continue
    if (!ts.isStringLiteral(member.name)) continue
    const event = member.name.text
    const mode = readModeTag(source, member)
    const line = source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1
    if (mode === undefined) {
      found.push({ file, line, event, mode: '<missing>' })
      continue
    }
    found.push({ file, line, event, mode })
  }
  return found
}

/** 从成员的 leading comment 里取 `@mode <mode>`。 */
function readModeTag(source: ts.SourceFile, member: ts.Node): string | undefined {
  for (const range of ts.getLeadingCommentRanges(source.text, member.pos) ?? []) {
    const text = source.text.slice(range.pos, range.end)
    const matched = /@mode\s+(emit|serial|parallel|waterfall|bail)\b/.exec(text)
    if (matched !== null) return matched[1]
  }
  return undefined
}

/** 读取一次 `events.<mode>(...)` 调用。 */
function readDispatch(
  source: ts.SourceFile,
  file: string,
  node: ts.CallExpression,
): Dispatch | undefined {
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  const mode = callee.name.text
  if (!MODES.has(mode)) return undefined
  const first = node.arguments[0]
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  if (first !== undefined && ts.isStringLiteral(first)) {
    return { file, line, mode, event: first.text, dynamic: false }
  }
  return { file, line, mode, event: '<dynamic>', dynamic: true }
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
