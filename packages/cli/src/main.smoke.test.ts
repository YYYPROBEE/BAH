/**
 * CLI 入口的进程级冒烟（施工单 01 §5 的 unit 面）。
 *
 * 为什么放在 unit 面而不是 e2e 面：e2e 面的语义是「真实 DeepSeek API，无密钥整面 skip」，
 * 而这条用例**不需要密钥**、也不打网络——它只验证「入口进程起得来、有约定前缀、退出码 0」，
 * 即 tsx 运行、workspace 解析、stdout/exit code 管线三条通道都通。
 *
 * 阶段 6 接上 profile 组合后，`--profile headless --dump-config` 会在这里长成完整冒烟用例。
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** 仓库根（本文件在 `packages/cli/src/`，向上三层到仓库根）。 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** CLI 入口（与根 `package.json` 的 `bah` 脚本同一文件）。 */
const entry = fileURLToPath(new URL('./main.ts', import.meta.url))

describe('CLI 入口（进程级冒烟）', () => {
  it('进程起得来、stdout 有 bah: 前缀、退出码 0、stderr 干净', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^bah: /m)
    expect(result.stderr).toBe('')
  })
})
