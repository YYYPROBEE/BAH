/**
 * 门禁：`plan/*` 事件名与载荷表的一致性（方案 §4.5）。
 *
 * ## 为什么必须新开一条门禁
 *
 * `verify-session-events` 的 `appendReceiver()` 只认接收者方法名 `append`
 * （`callee.name.text === 'append'`），而 plan 用的是 `session.appendDomain('plan/xxx', …)`：
 * 方法名不匹配 → 直接 `return undefined` → **完全不被检查**。
 * 这是"门禁看不见"，不是"能过门禁"——本仓库的 `saga/tick` 就踩过同类洞。
 *
 * ## 四条检查
 *
 * 1. `PLAN_SESSION_EVENT_TYPES` 与 `PlanSessionEventMap` 的键**双向一致**；
 * 2. `appendDomain('<literal>', …)` 的字符串必须在表内；**动态名字**直接失败
 *    （唯一例外是通用转发实现，事件名由调用方给出，本身不构成声明点）；
 * 3. **反向覆盖**：每个键至少 1 个发射点（`emitEvent('plan/…')` / `appendDomain('plan/…')`），
 *    防"声明了没通电"；
 * 4. `plan/` 前缀不得出现在平台事件表 `SESSION_EVENT_TYPES` 里（plan 是领域事件，不是平台族）；
 * 5. **载荷不得含 `args`**（方案 §5 陷阱 7 的防线）：载荷表里不许声明这个键，
 *    发射点的对象字面量里也不许出现——金额与收款人不得进 append-only 日志。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import ts from 'typescript'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** plan 事件的权威文件（键与载荷表的唯一定义处）。 */
const PLAN_EVENTS = 'packages/runtime/src/plan/events.ts'

/** 平台事件表：plan 前缀不许出现在这里。 */
const PLATFORM_EVENTS = 'packages/runtime/src/session/types.ts'

/** 参与扫描的面：引擎目录 + 宿主装配目录（后者按文件名精确过滤）。 */
const PLAN_DIR = 'packages/runtime/src/plan'
const HOST_PLUGIN = 'packages/host/src/boot/plugins/plan.ts'

/**
 * 通用转发实现（事件名由调用方给出，本身不构成声明点）。
 *
 * 只允许 `appendDomain(type, …)` 在这里出现：那是把 `PlanEventType` 变量送到落盘面的唯一通道。
 * 它的**调用点**在引擎里，必须是字面量——由检查 3 的反向覆盖兜住。
 */
const APPEND_FORWARDER = HOST_PLUGIN

/** 只扫源码：测试不构成契约。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

const gate: Gate = {
  name: 'plan-events',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const files = walk(root, [PLAN_DIR, 'packages/host/src/boot/plugins'], isSource)
      .map((file) => relative(root, file).split('\\').join('/'))
      .filter((where) => where.startsWith(PLAN_DIR) || where === HOST_PLUGIN)
      .sort()
    const sources = files.map((where) => ({ where, source: createSource(`${root}/${where}`) }))

    // ── 检查 1：键表双向一致 ────────────────────────────────────────────
    const declared = declaredKeys(root)
    if (declared.arrayKeys.size === 0 || declared.interfaceKeys.size === 0) {
      findings.push(
        `${PLAN_EVENTS}: 没有解析到 PLAN_SESSION_EVENT_TYPES 数组或 PlanSessionEventMap 接口` +
          '（事件表缺失，门禁拒绝通过）',
      )
    }
    for (const key of declared.arrayKeys) {
      if (!declared.interfaceKeys.has(key)) {
        findings.push(`${PLAN_EVENTS}: PLAN_SESSION_EVENT_TYPES 含 "${key}"，但载荷表没有声明`)
      }
      if (!key.startsWith('plan/')) {
        findings.push(`${PLAN_EVENTS}: 事件 "${key}" 不以 plan/ 开头（领域事件前缀是契约）`)
      }
    }
    for (const key of declared.interfaceKeys) {
      if (!declared.arrayKeys.has(key)) {
        findings.push(`${PLAN_EVENTS}: 载荷表声明了 "${key}"，但 PLAN_SESSION_EVENT_TYPES 缺项`)
      }
    }

    // ── 检查 5（声明面）：载荷表不得声明 args ──────────────────────────
    for (const key of declared.argsKeys) {
      findings.push(
        `${PLAN_EVENTS}: 载荷 "${key}" 声明了 args 字段——金额与收款人不得进 append-only 日志，` +
          '只许落 digest / tool / code（方案 §5 陷阱 7）',
      )
    }

    // ── 检查 2 + 3：调用点校验与反向覆盖 ────────────────────────────────
    const emitted = new Set<string>()
    let appendCalls = 0
    let emitCalls = 0

    for (const { where, source } of sources) {
      visit(source, (node) => {
        if (!ts.isCallExpression(node)) return
        const callee = node.expression
        // 两种形态都要认：`session.appendDomain(…)`（宿主）与 `emitEvent(…)`（引擎 / 裸函数）
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : undefined
        if (name === undefined) return
        const first = node.arguments[0]
        const line = lineOf(source, node)

        if (name === 'appendDomain') {
          appendCalls += 1
          checkPayload(where, source, node, findings)
          if (first === undefined || !ts.isStringLiteral(first)) {
            if (where !== APPEND_FORWARDER) {
              findings.push(
                `${where}:${String(line)} appendDomain 的事件名必须是字符串字面量（动态拼接无法静态校验）`,
              )
            }
            return
          }
          emitted.add(first.text)
          if (!declared.arrayKeys.has(first.text)) {
            findings.push(
              `${where}:${String(line)} appendDomain 落的事件 "${first.text}" 不在 ${PLAN_EVENTS} 的表里`,
            )
          }
          return
        }

        if (name !== 'emitEvent') return
        emitCalls += 1
        checkPayload(where, source, node, findings)
        if (first === undefined || !ts.isStringLiteral(first)) {
          findings.push(
            `${where}:${String(line)} emitEvent 的事件名必须是字符串字面量（动态名字无法反向覆盖）`,
          )
          return
        }
        emitted.add(first.text)
        if (!declared.arrayKeys.has(first.text)) {
          findings.push(
            `${where}:${String(line)} 发射的事件 "${first.text}" 不在 ${PLAN_EVENTS} 的表里`,
          )
        }
      })
    }

    for (const key of declared.arrayKeys) {
      if (!emitted.has(key)) {
        findings.push(
          `${PLAN_EVENTS}: 事件 "${key}" 声明了但没有任何发射点` +
            '（"声明了没通电"——本仓库的 saga/tick 踩过同类洞）',
        )
      }
    }

    // ── 检查 4：plan/ 不得进平台事件表 ─────────────────────────────────
    findings.push(...checkPlatformTable(root))

    // ── 检查 6：当前口径载体里不许再写"8 态"（W11 / TC-W11-10）──────────
    findings.push(...checkStateCountWording(root, sources))

    if (files.length === 0) {
      findings.push(`${PLAN_DIR}: 一个源文件都没扫到（目录改名或门禁扫描面失效）`)
    }

    notes.push(
      `扫描 ${String(files.length)} 个源文件：plan 事件 ${String(declared.arrayKeys.size)} 个、` +
        `发射点 ${String(emitted.size)} 个、appendDomain ${String(appendCalls)} 处、` +
        `emitEvent ${String(emitCalls)} 处，AST 校验；载荷禁 args（声明面 + 发射点）`,
    )

    return { ok: findings.length === 0, findings, notes }
  },
}

/**
 * 检查 6：**当前口径载体**里不许再写"8 态"。
 *
 * 为什么不扫全仓（W11 裁决四）：历史交接单 / 施工单 / `PROGRESS.md` 的历史节写的是
 * **当时的事实**，改成"9 态"就是篡改历史；`dist-types/` 是编译产物，扫不扫得到取决于
 * 有没有先跑 `tsc -b`。所以判据只覆盖"会被人当现状引用"的两个面：
 * `packages/runtime/src/plan/**` 与 `docs/plan.md`。
 */
function checkStateCountWording(
  root: string,
  sources: readonly { readonly where: string; readonly source: ts.SourceFile }[],
): string[] {
  const findings: string[] = []
  const stale = '8 态'
  const hint = '（W11 起是 9 态；历史记录不在本门禁范围内）'

  for (const { where, source } of sources) {
    if (source.text.includes(stale)) {
      findings.push(`${where}: 仍在写 "${stale}"${hint}`)
    }
  }

  const doc = `${root}/docs/plan.md`
  try {
    if (readFileSync(doc, 'utf8').includes(stale)) {
      findings.push(`docs/plan.md: 仍在写 "${stale}"${hint}`)
    }
  } catch {
    findings.push('docs/plan.md: 读不到（活文档缺失，口径无从校验）')
  }

  return findings
}

/** 读 `PLAN_SESSION_EVENT_TYPES` 的字符串元素与 `PlanSessionEventMap` 的键。 */
function declaredKeys(root: string): {
  readonly arrayKeys: ReadonlySet<string>
  readonly interfaceKeys: ReadonlySet<string>
  /** 载荷里声明了 `args` 的那些事件（方案 §5 陷阱 7：原文不得进日志）。 */
  readonly argsKeys: ReadonlySet<string>
} {
  const arrayKeys = new Set<string>()
  const interfaceKeys = new Set<string>()
  const argsKeys = new Set<string>()
  let source: ts.SourceFile
  try {
    source = createSource(`${root}/${PLAN_EVENTS}`)
  } catch {
    return { arrayKeys, interfaceKeys, argsKeys }
  }

  visit(source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'PLAN_SESSION_EVENT_TYPES' &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(unwrap(node.initializer))
    ) {
      // 先取出窄化后的表达式：`unwrap()` 在循环条件里调一次、在循环头再调一次，
      // TS 不会跨两次调用保持窄化（报 `Property 'elements' does not exist on 'Expression'`）。
      const literal = unwrap(node.initializer)
      if (ts.isArrayLiteralExpression(literal)) {
        for (const element of literal.elements) {
          if (ts.isStringLiteral(element)) arrayKeys.add(element.text)
        }
      }
    }
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'PlanSessionEventMap') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name !== undefined && ts.isStringLiteral(member.name)) {
          interfaceKeys.add(member.name.text)
          if (member.type !== undefined && declaresField(member.type, 'args')) {
            argsKeys.add(member.name.text)
          }
        }
      }
    }
  })

  return { arrayKeys, interfaceKeys, argsKeys }
}

/** 类型字面量里是否声明了某个字段（只下钻一层：载荷都是平铺对象）。 */
function declaresField(type: ts.TypeNode, field: string): boolean {
  const node = ts.isTypeLiteralNode(type) ? type : undefined
  if (node === undefined) return false
  return node.members.some(
    (member) =>
      (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
      member.name !== undefined &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === field,
  )
}

/** 发射点：第二个参数是对象字面量时，逐个属性名检查（禁 `args`）。 */
function checkPayload(
  where: string,
  source: ts.SourceFile,
  call: ts.CallExpression,
  findings: string[],
): void {
  const payload = call.arguments[1]
  if (payload === undefined || !ts.isObjectLiteralExpression(payload)) return
  for (const property of payload.properties) {
    const name = property.name
    if (name === undefined) continue
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue
    if (name.text !== 'args') continue
    findings.push(
      `${where}:${String(lineOf(source, property))} 事件载荷出现 args 字段——只许落 digest / tool / code，` +
        '金额与收款人不得进 append-only 日志（方案 §5 陷阱 7）',
    )
  }
}

/** 平台事件表不得含 `plan/` 前缀的键。 */
function checkPlatformTable(root: string): string[] {
  const findings: string[] = []
  let source: ts.SourceFile
  try {
    source = createSource(`${root}/${PLATFORM_EVENTS}`)
  } catch {
    return [`${PLATFORM_EVENTS}: 无法读取（平台事件表必须存在）`]
  }

  visit(source, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== 'SESSION_EVENT_TYPES' ||
      node.initializer === undefined
    ) {
      return
    }
    const initializer = unwrap(node.initializer)
    if (!ts.isArrayLiteralExpression(initializer)) return
    for (const element of initializer.elements) {
      if (ts.isStringLiteral(element) && element.text.startsWith('plan/')) {
        findings.push(
          `${PLATFORM_EVENTS}: 平台表里出现 "${element.text}"——plan 是领域事件，` +
            '必须走 appendDomain（旧 reader 要能整族跳过）',
        )
      }
    }
  })

  return findings
}

function createSource(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 去掉 `as const` / `satisfies T` / 括号，拿到真实表达式。 */
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
