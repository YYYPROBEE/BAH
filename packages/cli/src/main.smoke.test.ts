/**
 * CLI 入口的进程级冒烟（施工单 01 §5 的 unit 面 + 06 §0 出口标准 1/2）。
 *
 * 为什么放在 unit 面而不是 e2e 面：e2e 面的语义是「真实 DeepSeek API，无密钥整面 skip」，
 * 而这条用例**不需要密钥**、也不打网络——它只验证「入口进程起得来、能加载真实
 * `profiles/headless`、退出码 0、stderr 干净」，即 tsx 运行、workspace 源码解析、
 * 动态 import bundle 三条通道都通。
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** 仓库根（本文件在 `packages/cli/src/`，向上三层到仓库根）。 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** CLI 入口（与根 `package.json` 的 `bah` 脚本同一文件）。 */
const entry = fileURLToPath(new URL('./main.ts', import.meta.url))

/** 跑一次真实进程。 */
function run(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

describe('CLI 入口（进程级冒烟）', () => {
  it('--help：退出码 0、stdout 是帮助、stderr 干净', () => {
    const result = run(['--help'])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^bah —— BAH 底座 CLI/m)
    expect(result.stdout).toContain('--dump-config')
    expect(result.stderr).toBe('')
  })

  it('--profile headless --dump-config：真实 profile 加载成功、生效树带来源层', () => {
    const result = run(['--profile', 'headless', '--dump-config'])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    // 每一行都能被上层 patch 替换：来源层标注必须在
    expect(result.stdout).toContain('bundle:base')
    expect(result.stdout).toContain('profile-patch:profiles/headless/patch.yml')
    expect(result.stdout).toContain('core:model')
    expect(result.stdout).toContain('demo:echo')
    expect(result.stderr).toBe('')
  })
})
