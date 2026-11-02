/**
 * `bah plan` 的入口接线。
 *
 * 两条都很便宜，但漏一条的代价不对称：
 * 1. `parseCommand` 认不出 `plan` ⇒ 它会被当成 `run` 的**位置参数**，CLI 于是
 *    "看起来运行了"，实际去跑了一个 prompt（用户以为在挂计划，钱却没被授权）；
 * 2. 顶层分派没接到 `runPlan` ⇒ 子命令存在但不可达。
 *
 * 第 2 条用「用法错误必须在 boot 之前返回」来证明到达了 `runPlan`：
 * 没 boot 就没有会话目录、没有落盘，退出码 2 + 用法文本是只有那条分支才有的形状。
 */

import { describe, expect, it } from 'vitest'

import { parseCommand } from './command.ts'
import { runCli, type CliIo } from './run.ts'

/** `bah plan` 的用法首行（写死而不是引用 `PLAN_USAGE`：断言不依赖被检查对象自己）。 */
const PLAN_USAGE_FIRST_LINE = '用法：bah plan <list|wake|arm|disarm> [选项]'

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err }
}

describe('parseCommand 认得 plan', () => {
  it('首项是 plan ⇒ kind=plan（不是掉进 run 的兜底）', () => {
    expect(parseCommand(['plan', 'list'])).toEqual({ kind: 'plan' })
    expect(parseCommand(['plan'])).toEqual({ kind: 'plan' })
  })

  it('反例：plan 出现在第二个位置时仍按 flag 模式（run），不被误当子命令', () => {
    expect(parseCommand(['--profile', 'plan', 'plan'])).toEqual({ kind: 'run' })
  })
})

describe('runCli 把 plan 分派给 runPlan', () => {
  it('未知 flag ⇒ 2 + 用法文本，且不 boot（证明分派真的落到了 plan 分支）', async () => {
    const { io, out, err } = capture()
    const code = await runCli(['plan', '--bogus'], io, { root: process.cwd(), env: {} })

    expect(code).toBe(2)
    expect(err.join('\n')).toContain('bah plan:')
    expect(err.join('\n')).toContain(PLAN_USAGE_FIRST_LINE)
    // 走 run 分支的话会有自己的用法横幅；这里必须一行都没有
    expect(out.join('\n')).toBe('')
  })

  it('plan list --help ⇒ 0 且只打用法（与上一条同一个入口，不同臂）', async () => {
    const { io, out, err } = capture()
    const code = await runCli(['plan', 'list', '--help'], io, { root: process.cwd(), env: {} })

    expect(code).toBe(0)
    expect(out.join('\n')).toContain(PLAN_USAGE_FIRST_LINE)
    expect(err.join('\n')).toBe('')
  })
})
