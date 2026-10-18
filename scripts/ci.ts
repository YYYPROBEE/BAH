/**
 * 本地等价 CI（施工单 01 §5 / §7）：一条命令跑完整链路。
 *
 * 纪律：
 * - 子进程一律 `stdio: 'inherit'`——不捕获输出（受限环境下捕获管道会 EPERM），
 *   也让人直接看到失败步骤的原始输出；
 * - Windows 上 `pnpm` 是 `.cmd`，必须经 shell 启动（`shell: true`）；
 * - **fail-fast**：先修第一个红的，不浪费时间跑后面的。
 */

import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根：本文件位于 `<root>/scripts/`。 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

interface Step {
  readonly name: string
  readonly command: string
}

/** 与施工单 01 §5 的四个测试面 + §6 门禁一一对应。 */
const STEPS: readonly Step[] = [
  { name: 'typecheck', command: 'pnpm typecheck' },
  { name: 'test (unit)', command: 'pnpm test' },
  { name: 'test:coverage', command: 'pnpm test:coverage' },
  { name: 'gate', command: 'pnpm gate' },
  { name: 'test:e2e', command: 'pnpm test:e2e' },
  { name: 'test:snapshot', command: 'pnpm test:snapshot' },
  { name: 'test:web', command: 'pnpm test:web' },
]

interface Outcome {
  readonly name: string
  readonly ms: number
  readonly ok: boolean
}

console.log(`BAH CI · ${STEPS.length} 步（cwd=${root}）\n`)

const outcomes: Outcome[] = []
let blocked = false

for (const [index, step] of STEPS.entries()) {
  console.log(`▶ [${index + 1}/${STEPS.length}] ${step.command}`)
  const startedAt = performance.now()
  const result = spawnSync(step.command, { cwd: root, stdio: 'inherit', shell: true })
  const ms = Math.round(performance.now() - startedAt)
  const ok = result.status === 0
  outcomes.push({ name: step.name, ms, ok })
  if (!ok) {
    blocked = true
    break
  }
}

console.log('\nBAH CI · 汇总')
for (const outcome of outcomes) {
  const mark = outcome.ok ? '✔' : '✘'
  console.log(`${mark} ${outcome.name.padEnd(16)} ${String(outcome.ms).padStart(6)}ms`)
}

const skipped = STEPS.length - outcomes.length
if (blocked) {
  console.error(`\n阻断合并：有步骤未通过${skipped > 0 ? `（后续 ${skipped} 步未执行）` : ''}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}
