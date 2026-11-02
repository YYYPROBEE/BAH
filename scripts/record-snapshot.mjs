/**
 * 录制快照（阶段 8 R66）：`pnpm snapshot:record`。
 *
 * 为什么不是一条 shell 环境变量赋值：Windows 的 `cmd` 与 PowerShell 写法不同，
 * 而要求"不写 shell"。这里用 Node 起子进程，把
 * `BAH_SNAPSHOT_RECORD=1` 注入环境后跑 snapshot 面——行为在 Windows / CI 一致。
 *
 * `stdio: 'inherit'`：录制是**人工操作**，输出直接给人看；也不要通过管道捕获子进程输出
 * （受限环境下会因命名管道限制失败）。
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const child = spawn(
  process.execPath,
  [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.snapshot.config.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, BAH_SNAPSHOT_RECORD: '1' },
  },
)

child.on('error', (error) => {
  console.error(`snapshot:record: 无法启动 vitest —— ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`snapshot:record: vitest 被信号中断（${signal}）`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
