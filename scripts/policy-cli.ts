/**
 * 策略 CLI 的公共部分（`policy:lint` / `policy:compile` / `policy:test`）。
 *
 * 纪律（01 §10）：人类可读摘要到 stdout；错误到 stderr，首行 `file:line: ruleId: message`；
 * 退出码 0/1/2（2 = 用法错误）。
 */

import { BANK_TOOL_SPECS } from '../packages/bank/src/tools/specs.ts'
import { describePolicyError } from '../packages/policy/src/errors.ts'

/** 解析后的命令行参数。 */
export interface CliArgs {
  readonly positional: readonly string[]
  readonly flags: ReadonlySet<string>
}

/** `--flag` 进集合，其余按位置参数（顺序保留）。 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = []
  const flags = new Set<string>()
  for (const arg of argv) {
    if (arg.startsWith('--')) flags.add(arg.slice(2))
    else positional.push(arg)
  }
  return { positional, flags }
}

/** 工具目录（`appliesTo` 的合法值）——唯一来源是 `specs.ts`。 */
export function toolNames(): readonly string[] {
  return BANK_TOOL_SPECS.map((spec) => spec.name)
}

/** 打印一条策略错误并返回退出码 1。 */
export function fail(error: unknown): 1 {
  const described = describePolicyError(error)
  console.error(`${described.code}: ${described.message}`)
  return 1
}

/** 用法错误（退出码 2）。 */
export function usage(message: string): 2 {
  console.error(message)
  return 2
}
