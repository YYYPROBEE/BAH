/**
 * 门禁：意图/追问平面的确定性与接线完整性（D14 ·  §6）。
 *
 * ## 为什么主 AST
 *
 * I1/I2/I5 用 TypeScript Compiler API：
 * ① grep 会被注释与字符串骗——头注释里写「禁止 Date.now」就会假红，
 * 把 `globalThis['Date']['now']` 写进模板串就假绿；
 * ② `new Date()` 无参（违规）与 `new Date(injectedMs)`（合法，注入钟换算）只有 AST
 * 能按**实参个数**区分；
 * ③ `verify-session-events` 已确立 AST 先例，`typescript` 依赖现成。
 *
 * I3/I4 用文本存在性：跨文件「有没有人用」是存在性命题，AST 无额外判别力，
 * 且发射点分布在 llm/eval/host 三个包，全仓 AST 扫描成本不成比例。
 *
 * ## findings / notes 分工
 *
 * findings = I1～I5 违规，**唯一阻断面**（`ok = findings.length === 0`）；
 * notes = 扫描统计与非阻断播报。把违规塞进 notes 等于假绿。
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 纯函数面：这两个目录里的非测试源码禁一切时钟/随机/网络（I1）。 */
const PURE_DIRS = ['packages/runtime/src/intent', 'packages/interaction/src/prompt'] as const

/** 点名禁止的调用（I1）。 */
const BANNED_CALLS: Readonly<Record<string, string>> = {
  'Date.now': 'I1',
  'Math.random': 'I1',
  'performance.now': 'I1',
}

/**
 * I2 黑名单：**槽位**默认值的惯用名（默认收款人 / 默认账户 / 默认金额…）。
 *
 * WHY 不写 `^DEFAULT_[A-Z0-9_]+$`：那会把 `DEFAULT_MAX_K` 这类合法常量一起判红，
 * 于是下一次有人为了过门禁去改名——门禁就变成了噪音源。判别力来自「默认值用在哪个槽位上」，
 * 语义由 TC-INT-15（ADR 分支无胜出值）与 eval T-15/Q-12 锁。
 */
const BANNED_IDENT =
  /^DEFAULT_(PAYEE|ACCOUNT|AMOUNT|TIME|CATEGORY|PRODUCT|SCENE|SLOT|CHOICE|CANDIDATE)$|^defaultSlot|^fallbackSlot/

/** 决策函数名：只有它们的 `case 'ambiguous'` 必须是 `return 'ask'`。 */
const DECIDE_FUNCTIONS = new Set(['decide', 'decideFor'])

export interface ScanOptions {
  readonly rel: string
  readonly source: string
}

/**
 * 单文件扫描（导出供夹具直测，不依赖 fs）。
 *
 * 注释不参与遍历：`ts.createSourceFile` 的 AST 里没有注释节点，
 * 头注释里写「禁止 Date.now」不会触发 finding。
 */
export function scanSource({ rel, source }: ScanOptions): string[] {
  const findings: string[] = []
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true)
  const line = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const full = node.expression.getText()
      const rule = BANNED_CALLS[full]
      if (rule !== undefined) findings.push(`${rel}:${String(line(node))}:${rule}: 禁止调用 ${full}`)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      findings.push(`${rel}:${String(line(node))}:I1: 禁止调用 fetch`)
    }
    if (ts.isNewExpression(node) && node.expression.getText() === 'Date' && (node.arguments?.length ?? 0) === 0) {
      findings.push(`${rel}:${String(line(node))}:I1: new Date() 无参 = 读系统时钟，改用注入钟`)
    }
    if (ts.isIdentifier(node) && BANNED_IDENT.test(node.text)) {
      findings.push(`${rel}:${String(line(node))}:I2: 疑似默认值填充标识符 ${node.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

/** I2 补充：`case 'ambiguous'` 的子句必须 `return 'ask'`（AST 查 case 与 return 字面量）。 */
export function checkAmbiguousAsks(rel: string, source: string): string[] {
  const findings: string[] = []
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true)
  const line = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1

  // 只看决策函数内部：`scoreOf` 这类评分表也有 `case 'ambiguous'`，但它返回的是分数
  const visit = (node: ts.Node, inDecide: boolean): void => {
    const enter =
      (ts.isFunctionDeclaration(node) && node.name !== undefined && DECIDE_FUNCTIONS.has(node.name.text)) ||
      (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && DECIDE_FUNCTIONS.has(node.name.text))
    const inside = inDecide || enter
    if (
      inside &&
      ts.isCaseClause(node) &&
      ts.isStringLiteral(node.expression) &&
      node.expression.text === 'ambiguous'
    ) {
      const returns = node.statements.filter((statement): statement is ts.ReturnStatement =>
        ts.isReturnStatement(statement),
      )
      if (returns.length === 0) {
        findings.push(`${rel}:${String(line(node))}:I2: ambiguous 分支没有 return 字面量`)
      }
      for (const statement of returns) {
        const expression = statement.expression
        if (expression === undefined || ts.isStringLiteral(expression) === false || expression.text !== 'ask') {
          findings.push(`${rel}:${String(line(statement))}:I2: ambiguous 分支必须 return 'ask'`)
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, inside))
  }
  visit(sf, false)
  return findings
}

/** 读取文件（相对仓库根）；缺失返回 undefined（调用方给 finding）。 */
function read(root: string, rel: string): string | undefined {
  try {
    return readFileSync(join(root, rel), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * I3：`intent_resolve` / `prompt_ask` 有真实注册点与发射点（只声明不发射 = 未完成）。
 *
 * 注册点：两个宿主插件的 `create*Tool` 调用各 ≥1；
 * 发射点：demo router 与 eval 场景合计 ≥2 次（每工具）——演示与评测各至少一处。
 */
export function checkWiring(root: string): string[] {
  const findings: string[] = []
  const requirement: readonly (readonly [string, string, readonly string[]])[] = [
    ['intent_resolve', 'createIntentResolveTool', ['packages/host/src/boot/plugins/intent.ts']],
    ['prompt_ask', 'createPromptAskTool', ['packages/host/src/boot/plugins/prompt-ask.ts']],
  ]
  for (const [tool, factory, registrars] of requirement) {
    for (const file of registrars) {
      const source = read(root, file)
      if (source === undefined || !source.includes(factory)) {
        findings.push(`${file}:0:I3: 缺少 ${tool} 的注册点（${factory}）`)
      }
    }
    const emitters = [
      'packages/llm/src/demo/router.ts',
      'packages/eval/src/scenarios/t/index.ts',
      'packages/eval/src/scenarios/q/index.ts',
    ]
    const hits = emitters.filter((file) => (read(root, file) ?? '').includes(`'${tool}'`)).length
    if (hits < 2) findings.push(`packages/llm/src/demo/router.ts:0:I3: ${tool} 的发射点只有 ${String(hits)} 处（要求 ≥2）`)
  }
  return findings
}

/** I4：候选上限与手动输入在源码可查（字面量 + 返回数组末元素是 MANUAL_CHOICE）。 */
export function checkChoiceCap(root: string): string[] {
  const findings: string[] = []
  const rel = 'packages/interaction/src/prompt/candidates.ts'
  const source = read(root, rel)
  if (source === undefined) return [`${rel}:0:I4: 文件缺失`]
  if (!/MAX_CANDIDATES = 3/.test(source)) {
    findings.push(`${rel}:0:I4: 必须写死 MAX_CANDIDATES = 3（改它 = 改产品口径）`)
  }
  if (!/\[\s*\.\.\.[^\]]*slice\(0, MAX_CANDIDATES\),\s*MANUAL_CHOICE,?\s*\]/.test(source)) {
    findings.push(`${rel}:0:I4: buildChoices 的返回数组末元素必须恒为 MANUAL_CHOICE`)
  }
  return findings
}

/** I5：PII 脱敏函数存在且被**实际调用**（不是定义了没人用）。 */
export function checkPiiSanitizers(root: string): string[] {
  const findings: string[] = []
  const slotsRel = 'packages/runtime/src/intent/slots.ts'
  const evidenceRel = 'packages/runtime/src/intent/evidence.ts'
  const slots = read(root, slotsRel)
  const evidence = read(root, evidenceRel)
  if (slots === undefined) return [`${slotsRel}:0:I5: 文件缺失`]
  for (const fn of ['maskPhone', 'maskName', 'accountTail']) {
    if (!new RegExp(`export function ${fn}\\(`).test(slots)) {
      findings.push(`${slotsRel}:0:I5: 缺少脱敏函数 ${fn}`)
    }
  }
  if (evidence === undefined) return [...findings, `${evidenceRel}:0:I5: 文件缺失`]
  // sanitizeSpan 的函数体里必须出现 maskName 调用（同目录 import 与调用点）
  const bodyStart = evidence.indexOf('export function sanitizeSpan(')
  const body = bodyStart === -1 ? '' : evidence.slice(bodyStart)
  if (bodyStart === -1) findings.push(`${evidenceRel}:0:I5: 缺少 sanitizeSpan`)
  else if (!body.includes('maskName(')) findings.push(`${evidenceRel}:0:I5: sanitizeSpan 未调用脱敏函数`)
  return findings
}

const gate: Gate = {
  name: 'intent-determinism',

  async run(root: string): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []
    let scanned = 0
    let skippedTests = 0

    for (const dir of PURE_DIRS) {
      // walk 返回绝对路径；对外报错用相对路径（findings 要能贴进 issue）
      for (const file of walk(root, [dir], (name) => name.endsWith('.ts'))) {
        if (file.endsWith('.test.ts')) {
          skippedTests += 1
          continue
        }
        scanned += 1
        const rel = relative(root, file).replaceAll('\\', '/')
        const source = readFileSync(file, 'utf8')
        findings.push(...scanSource({ rel, source }), ...checkAmbiguousAsks(rel, source))
      }
    }
    findings.push(...checkWiring(root), ...checkChoiceCap(root), ...checkPiiSanitizers(root))

    notes.push(`纯函数面扫描 ${String(scanned)} 文件（跳过测试 ${String(skippedTests)}）`)
    notes.push('MAX_CANDIDATES=3、MAX_ASK_PER_SLOT=2（改它 = 改产品口径，须过 00 单）')
    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) await runStandalone(gate)
