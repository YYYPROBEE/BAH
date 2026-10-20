/**
 * 门禁脚本公共设施（施工单 01 §6）。
 *
 * 全部用 TypeScript + tsx 直跑，**不写 shell**——保证 Windows 开发机与 CI 行为一致
 * （施工单 00 §10 最后一行）。
 *
 * 每个 `verify-*.ts` 只负责导出 `gate`，由 `run-gates.ts` 统一调度；
 * 同时支持单独运行（便于人工抽查单个门禁）。
 */

import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 单个门禁的执行结果。 */
export interface GateResult {
  /** 是否通过。false 时 run-gates 汇总后以退出码 1 结束。 */
  ok: boolean
  /** 违反项：每条一行，必须能定位到文件（尽量带行号）。 */
  findings: string[]
  /** 非阻断说明：骨架版 TODO、跳过原因、扫描面统计。 */
  notes: string[]
}

/** 一个门禁。 */
export interface Gate {
  /** 门禁名（kebab-case），用于输出与文档对照。 */
  readonly name: string
  /** 在仓库根 `root` 上执行检查。 */
  run(root: string): Promise<GateResult>
}

/** 递归遍历时一律跳过的目录（构建产物、依赖与本地环境）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-types',
  '.git',
  'sessions',
  'coverage',
  '.ci-artifacts',
  '.venv',
  '__pycache__',
  '.pytest_cache',
])

/**
 * 递归收集文件（深度优先，结果按路径排序，保证输出稳定）。
 *
 * @param root 仓库根
 * @param subdirs 相对 root 的起始目录；不存在时静默跳过
 * @param accept 按文件名过滤
 */
export function walk(
  root: string,
  subdirs: readonly string[],
  accept: (fileName: string) => boolean,
): string[] {
  const found: string[] = []
  const stack: string[] = subdirs.map((dir) => join(root, dir))

  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 目录不存在 = 该项无可扫内容
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name))
      } else if (entry.isFile() && accept(entry.name)) {
        found.push(join(dir, entry.name))
      }
    }
  }

  return found.sort()
}

/** 仓库根：本文件位于 `<root>/scripts/`，故取其父目录。 */
export function projectRoot(): string {
  return resolve(fileURLToPath(new URL('..', import.meta.url)))
}

/** 是否被当作入口直接运行（而不是被 run-gates 动态 import）。 */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return resolve(fileURLToPath(metaUrl)) === resolve(entry)
}

/** 统一打印一个门禁的结果。 */
export function printResult(name: string, result: GateResult): void {
  const head = result.ok ? '✔' : '✘'
  console.log(`${head} ${name}`)
  for (const finding of result.findings) console.log(`    · ${finding}`)
  for (const note of result.notes) console.log(`    ℹ ${note}`)
}

/** 单独运行时的收尾：打印并按结果设置退出码。 */
export async function runStandalone(gate: Gate): Promise<void> {
  const result = await gate.run(projectRoot())
  printResult(gate.name, result)
  process.exitCode = result.ok ? 0 : 1
}
