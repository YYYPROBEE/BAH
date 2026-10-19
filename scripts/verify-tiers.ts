/**
 * 门禁：三级权限声明完整性（施工单 01 §6 / §8 第 ⑥ 项；施工单 09 §9 收紧）。
 *
 * 四条规则（前三条为 09 的"逐条校验"要求）：
 * 1. **每个工具都声明了 `tier`**：词法扫描 `satisfies ToolDefinition` / `: ToolDefinition = {`
 *    声明点，附近必须出现 `tier:`（覆盖工具目录之外的插件工具，如 `demo:echo`）；
 * 2. **`tier.level` 合法**：导入真实的工具目录，逐条校验 `green | yellow | red`
 *    （工具目录是**唯一**元数据来源，词法扫描只能看到声明点，导入才能看到运行期事实）；
 * 3. **`amountPath` 指向真实参数**：`amountPath` 必须是该工具 `schema.properties` 的键；
 * 4. **阈值只出现在 Config**：`packages/bank/src/tools/**` 里不得把
 *    `dailyTransferLimit` / `riskyCallThreshold` 写死成数字（阈值来自 `bank:tools` 配置）。
 *
 * 为什么用导入而不是纯词法：`tier` 在工厂里是 `tier: spec.tier`（间接引用），
 * 词法只能证明"写了 tier 这个词"，证明不了"级别合法、金额字段真实存在"。
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 声明点之后多少行内必须出现 `tier`（对象字面量通常紧随其后）。 */
const TIER_WINDOW = 160

/** 合法级别。 */
const LEVELS = new Set(['green', 'yellow', 'red'])

/** 只扫包内源码，不扫产物与声明。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

/** 一个 `ToolDefinition` 声明点。 */
interface Site {
  file: string
  line: number
}

/** 运行时工具定义（只取门禁关心的字段）。 */
interface RuntimeTool {
  readonly name: string
  readonly tier: { readonly level?: unknown; readonly amountPath?: unknown }
  readonly schema: { readonly properties?: Readonly<Record<string, unknown>> }
}

const gate: Gate = {
  name: 'tiers',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const runtime = await checkRuntimeCatalog(root, findings)
    notes.push(`运行期工具目录：${runtime} 个工具（tier 级别 + amountPath 逐条校验）`)

    const sites = checkDeclarationSites(root, findings)
    notes.push(`ToolDefinition 声明点 ${sites} 个（tier 声明存在性）`)

    const hardcoded = checkThresholdsOnlyInConfig(root, findings)
    notes.push(`阈值写死扫描：${hardcoded} 个银行工具源文件（不含 Config 读取点）`)

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 导入真实工具目录，校验级别 / 名称唯一 / amountPath。 */
async function checkRuntimeCatalog(root: string, findings: string[]): Promise<number> {
  const catalogPath = join(root, 'packages', 'bank', 'src', 'tools', 'catalog.ts')
  let tools: readonly RuntimeTool[]
  try {
    const module = (await import(pathToFileURL(catalogPath).href)) as {
      createBankTools?: (deps: unknown) => readonly RuntimeTool[]
    }
    if (typeof module.createBankTools !== 'function') {
      findings.push(`${relative(root, catalogPath)}：缺少 createBankTools（工具目录必须可枚举）`)
      return 0
    }
    // 工厂只闭包 deps、不在创建期调用任何方法：空依赖足够拿到定义面
    tools = module.createBankTools({})
  } catch (error) {
    findings.push(
      `${relative(root, catalogPath)}：无法导入（${error instanceof Error ? error.message : String(error)}）`,
    )
    return 0
  }

  const seen = new Set<string>()
  for (const tool of tools) {
    const where = `工具 ${tool.name}`
    if (seen.has(tool.name)) findings.push(`${where}：名字重复（工具名必须全局唯一）`)
    seen.add(tool.name)

    const level = tool.tier.level
    if (typeof level !== 'string' || !LEVELS.has(level)) {
      findings.push(`${where}：tier.level 非法（${String(level)}；只允许 green / yellow / red）`)
    }
    const amountPath = tool.tier.amountPath
    if (amountPath === undefined) continue
    if (typeof amountPath !== 'string' || amountPath.length === 0) {
      findings.push(`${where}：amountPath 必须是非空字符串`)
      continue
    }
    const properties = tool.schema.properties
    if (properties === undefined || !Object.hasOwn(properties, amountPath)) {
      findings.push(`${where}：amountPath '${amountPath}' 不指向任何参数（schema.properties 里没有）`)
    }
  }
  return tools.length
}

/**
 * 词法扫描声明点：附近必须有 `tier:`；字面量级别必须合法。
 *
 * 只认两种形态：`satisfies ToolDefinition`（字面量收窄）与 `: ToolDefinition ... = {`（带对象字面量的注解）。
 * 纯类型引用（如 `Map<string, ToolDefinition>`、函数返回类型）不是声明点。
 */
function checkDeclarationSites(root: string, findings: string[]): number {
  const files = walk(root, ['packages'], isSource)
  let sites = 0

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (!isDeclarationPoint(line)) continue
      sites += 1
      const objectLines = objectLinesAt(lines, index)
      if (objectLines === undefined || !objectLines.some((item) => /\btier\s*:/.test(item))) {
        findings.push(
          `${relative(root, file)}:${index + 1} 工具定义缺少 tier 声明（施工单 00 §11 领域扩展 / 施工单 09 三级权限）`,
        )
        continue
      }
      for (const item of objectLines) {
        const literal = /\blevel\s*:\s*['"]([\w-]+)['"]/.exec(item)
        if (literal !== null && !LEVELS.has(literal[1] ?? '')) {
          findings.push(
            `${relative(root, file)}:${index + 1} tier.level '${literal[1] ?? ''}' 非法（只允许 green / yellow / red）`,
          )
        }
        if (/\btier\s*:\s*\{[^}]*\d/.test(item)) {
          findings.push(
            `${relative(root, file)}:${index + 1} tier 声明里出现数字字面量（阈值只许来自 Config，施工单 09 §1.1 第 2 条）`,
          )
        }
      }
    }
  }
  return sites
}

/**
 * 阈值写死扫描：银行工具源码里不得出现 `dailyTransferLimit: 5000` 之类的字面量。
 *
 * 允许的两类位置：`testing.ts`（测试夹具）与读取点（`deps.config.dailyTransferLimit`）。
 */
function checkThresholdsOnlyInConfig(root: string, findings: string[]): number {
  const toolsDir = join('packages', 'bank', 'src', 'tools')
  const files = walk(root, [toolsDir], (fileName) => isSource(fileName))
  const assignment = /\b(dailyTransferLimit|riskyCallThreshold)\s*[:=]\s*\d/
  let checked = 0
  for (const file of files) {
    const name = file.replace(/\\/g, '/')
    if (name.endsWith('/testing.ts')) continue
    checked += 1
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (isCommentLine(line)) continue
      if (assignment.test(line)) {
        findings.push(
          `${relative(root, file)}:${index + 1} 阈值不得写死在代码里（只许来自 bank:tools 配置；施工单 09 §1.1 第 2 条）`,
        )
      }
    }
  }
  return checked
}

/** 是否是一个 ToolDefinition **声明点**（规则见函数注释）。 */
function isDeclarationPoint(line: string): boolean {
  return /\bsatisfies\s+ToolDefinition\b/.test(line) || /:\s*ToolDefinition\b[^=]*=\s*\{/.test(line)
}

/**
 * 取声明点所属的对象字面量行（含 `satisfies` 之前的部分）。
 *
 * `satisfies` 在对象**末尾**，`tier` 在之前：向前找到 `return {` / `const x = {` 再收口；
 * 注解形态则从声明点向后看 `TIER_WINDOW` 行（对象通常紧随其后）。
 */
function objectLinesAt(lines: readonly string[], from: number): readonly string[] | undefined {
  if (/\bsatisfies\s+ToolDefinition\b/.test(lines[from] ?? '')) {
    const start = findObjectStart(lines, from)
    if (start === undefined) return undefined
    return lines.slice(start, from + 1)
  }
  const end = Math.min(lines.length, from + TIER_WINDOW)
  return lines.slice(from, end)
}

/** 从 `satisfies` 行向前找对象字面量的起点（优先 `return {`，其次 `const x = {`）。 */
function findObjectStart(lines: readonly string[], from: number): number | undefined {
  const floor = Math.max(0, from - TIER_WINDOW)
  for (let index = from; index >= floor; index -= 1) {
    if (/^\s*return\s*\{/.test(lines[index] ?? '')) return index
  }
  for (let index = from; index >= floor; index -= 1) {
    if (/^\s*(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*\{/.test(lines[index] ?? '')) return index
  }
  return undefined
}

/** 注释行不参与扫描（文档里提到阈值不构成写死）。 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
