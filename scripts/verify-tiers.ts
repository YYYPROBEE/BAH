/**
 * 门禁：每个写操作工具都必须声明 `tier`（施工单 01 §6 / §8 第 ⑥ 项，M0 骨架版）。
 *
 * 为什么必须有：权限分级不可漏声明（赛题高优项）。`tier` 在工具定义处声明，
 * 由治理平面统一解释；阈值只许出现在 Config，不许硬编码在工具体（施工单 01 §6）。
 *
 * M0 阶段工具集为空，脚本先占位：没有任何 `ToolDefinition` 声明点时按骨架规则通过并注明 TODO。
 *
 * 实现说明：本骨架用**词法**定位声明点（`satisfies ToolDefinition` / `: ToolDefinition`），
 * 不建 AST——真正的结构化校验待工具体落地后改写（TODO 已注明）。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** 声明点之后多少行内必须出现 `tier`（对象字面量通常紧随其后）。 */
const TIER_WINDOW = 160

/** 只扫包内源码，不扫产物与声明。 */
const isSource = (fileName: string): boolean => fileName.endsWith('.ts') && !fileName.endsWith('.d.ts')

interface Site {
  file: string
  line: number
}

const gate: Gate = {
  name: 'tiers',

  async run(root) {
    const files = walk(root, ['packages'], isSource)
    const findings: string[] = []
    const sites: Site[] = []

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        if (!isDeclarationPoint(line)) continue
        sites.push({ file, line: index + 1 })
        if (!hasTierWithin(lines, index)) {
          findings.push(
            `${relative(root, file)}:${index + 1} 工具定义缺少 tier 声明（施工单 00 §11 领域扩展 / 施工单 09 三级权限）`,
          )
        }
      }
    }

    return {
      ok: findings.length === 0,
      findings,
      notes:
        sites.length === 0
          ? [
              'M0 工具集为空：没有 ToolDefinition 声明点，按骨架规则通过。',
              'TODO(施工单 08)：工具族落地后，改为逐条校验「tier.level 合法 + amountPath 指向真实参数 + 阈值只出现在 Config」。',
            ]
          : [`发现 ${sites.length} 个 ToolDefinition 声明点，逐条核对 tier`],
    }
  },
}

/**
 * 是否是一个 ToolDefinition **声明点**。
 *
 * 只认两种形态：`satisfies ToolDefinition`（字面量收窄）与 `: ToolDefinition ... = {`（带对象字面量的注解）。
 * 纯类型引用（如 `Map<string, ToolDefinition>`、函数返回类型）不是声明点——
 * 早期版本把它们算成声明点会误报（阶段 3 落地工具注册表时踩到）。
 */
function isDeclarationPoint(line: string): boolean {
  return /\bsatisfies\s+ToolDefinition\b/.test(line) || /:\s*ToolDefinition\b[^=]*=\s*\{/.test(line)
}

/**
 * 声明点附近是否出现 `tier:`。
 *
 * 两种书写都要支持：
 * - `const x: ToolDefinition<…> = { tier: … }`：`tier` 在声明点之后；
 * - `return { … } satisfies ToolDefinition`：`satisfies` 在对象**末尾**，`tier` 在之前。
 *
 * 第二种不能简单"前后各看 60 行"——会看到相邻工具的定义（负控会假绿）。
 * 因此先向前找到对象字面量的起点（`return {` / `const x = {`），只在这个对象内找 `tier`。
 */
function hasTierWithin(lines: readonly string[], from: number): boolean {
  if (/\bsatisfies\s+ToolDefinition\b/.test(lines[from] ?? '')) {
    const start = findObjectStart(lines, from)
    if (start === undefined) return false
    for (let index = start; index <= from; index += 1) {
      if (/\btier\s*:/.test(lines[index] ?? '')) return true
    }
    return false
  }

  const end = Math.min(lines.length, from + TIER_WINDOW)
  for (let index = from; index < end; index += 1) {
    if (/\btier\s*:/.test(lines[index] ?? '')) return true
  }
  return false
}

/** 从 `satisfies` 行向前找对象字面量的起点（优先 `return {`，其次 `const x = {`）。 */
function findObjectStart(lines: readonly string[], from: number): number | undefined {
  const floor = Math.max(0, from - TIER_WINDOW)
  // 先找 `return {`：对象内部可能还有 `const result = {`，不能被它截胡
  for (let index = from; index >= floor; index -= 1) {
    if (/^\s*return\s*\{/.test(lines[index] ?? '')) return index
  }
  for (let index = from; index >= floor; index -= 1) {
    if (/^\s*(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*\{/.test(lines[index] ?? '')) return index
  }
  return undefined
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
