/**
 * 门禁：部署相关阈值不得硬编码（门禁扩容 07 §2-7，兑施工台账偏差 R43 的欠票）。
 *
 * R43 记的是"`verify-no-hardcoded-limits` 未实现，等配置落 `bah.yml` 时才有静态扫描面"。
 * 现在根 `bah.yml` 与 `profiles/` 六份就位，扫描面已具备，这条欠账到期可兑。
 *
 * 规则（AST）：
 * 1. 扫 `packages/safety/src/**` 的非测试源码；
 * 2. 命中 `scripts/threshold-names.ts` 名册里的标识符（变量名 / 属性名），
 *    且初始化器是数字字面量 → 违规；
 * 3. **唯一豁免**：位于缺省值表（变量名形如 `DEFAULT_*` 或 `*_DEFAULTS`）的初始化器内部。
 *    理由：缺省值表是"Config 未写时的基线"，本身就是配置面的定义处（`DEFAULT_SENTRY_SETTINGS`、
 *    `DEFAULT_TIER_SPECS`、`DETECTOR_DEFAULTS`）；散落在业务逻辑里的同名字面量才是硬编码。
 *
 * 与 `verify-tiers` 第 4 条的分工：那条只覆盖 `packages/bank/src/tools/**` 的两个资金阈值，
 * 且不认缺省值表；本条覆盖 `packages/safety/src/**` 并在名册里并行登记同一组资金阈值。
 * 两条同时失败时，修一处（把字面量改成读 Config）即可让两条一起变绿。
 *
 * 为什么只做赋值、不做比较：阈值可以是配置读入后的派生量，比较运算无法静态判定来源；
 * 而"给阈值起名并赋字面量"是硬编码的充分形态，误报率也最低。内联比较阈值由
 * `verify-tiers` 在银行工具面单独兜（那里有金额语义可判）。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import ts from 'typescript'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'
import { isThresholdName } from './threshold-names.ts'

/** 扫描面：安全包的沙箱与哨兵实现。 */
const SCAN_DIRS = ['packages/safety/src']

/** 只扫源码，不扫测试与夹具。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') &&
  !fileName.endsWith('.d.ts') &&
  !fileName.endsWith('.test.ts') &&
  !fileName.endsWith('testing.ts')

const gate: Gate = {
  name: 'no-hardcoded-config',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const files = walk(root, SCAN_DIRS, isSource)

    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const where = relative(root, file).replace(/\\/g, '/')

      const report = (node: ts.Node, name: string): void => {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        findings.push(
          `${where}:${line} 阈值 ${name} 被赋了数字字面量（阈值只许来自 Config；R43 / 施工单 07 §2-7）`,
        )
      }

      const walkNode = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          if (node.initializer !== undefined && isNumeric(node.initializer)) {
            if (isThresholdName(node.name.text) && !insideDefaults(source, node)) {
              report(node, node.name.text)
            }
          }
        }
        if (ts.isPropertyAssignment(node) && isNumeric(node.initializer)) {
          const name = propertyName(node.name)
          if (name !== undefined && isThresholdName(name) && !insideDefaults(source, node)) {
            report(node, name)
          }
        }
        ts.forEachChild(node, walkNode)
      }
      walkNode(source)
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `扫描 ${files.length} 个 safety 源文件；名册见 scripts/threshold-names.ts，DEFAULT_* 缺省表豁免`,
      ],
    }
  },
}

/** 数字字面量（含正负号与 `1_000` 写法）。 */
function isNumeric(node: ts.Node): boolean {
  if (ts.isNumericLiteral(node)) return true
  return (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(node.operand)
  )
}

/** 属性名（标识符 / 字符串字面量 / 数字字面量键）。 */
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name)) return name.text
  return undefined
}

/** 是否位于缺省值表（`DEFAULT_*` / `*_DEFAULTS`）的变量初始化器内部。 */
function insideDefaults(source: ts.SourceFile, node: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current !== undefined) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return isDefaultsTable(current.name.text)
    }
    current = current.parent
  }
  return false
}

/** 缺省值表的命名约定：前缀 `DEFAULT_`（按配置段聚合）或后缀 `_DEFAULTS`（按字段族聚合）。 */
function isDefaultsTable(name: string): boolean {
  return /^DEFAULT_/.test(name) || /_DEFAULTS$/.test(name)
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
