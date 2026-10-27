/**
 * CLI 入口的进程级冒烟（施工单 01 §5 的 unit 面 + 06 §0 出口标准 1/2）。
 *
 * 为什么放在 unit 面而不是 e2e 面：e2e 面的语义是「真实 DeepSeek API，无密钥整面 skip」，
 * 而这条用例**不需要密钥**、也不打外网——它只验证「入口进程起得来、能加载真实
 * `profiles/headless`、退出码 0、stderr 干净」，即 tsx 运行、workspace 源码解析、
 * 动态 import bundle 三条通道都通。`required: false` 的 sidecar 缺席告警是唯一允许的
 * stderr 行（见 `unexpectedStderr`），它证明告警通道真的接到了 CLI。
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * `required: false` 的外部依赖告警是**预期**输出，不算噪声。
 *
 * RAG sidecar 不在时 `bank:knowledge` 会在**真实启动**告警（缺口报告 §5.3）；
 * `--dump-config` 已由 `RunContext.probe=false` 关掉探活，dump 路径应零 stderr（A8）。
 * 这里只过滤这一条，其它任何 stderr 仍判红——否则"stderr 干净"会变成"允许一切"。
 */
const KNOWN_WARNING = 'bank:knowledge 健康检查失败'

function unexpectedStderr(text: string | Buffer | null | undefined): readonly string[] {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.length > 0 && !line.includes(KNOWN_WARNING))
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

  // 显式超时：本用例 spawn 一个真实 Node 进程加载 profile，5s 默认值在负载高时会假红
  // （实测 5333ms 触发过一次）。断言一条没改，只是给它真实的执行预算。
  it('--profile headless --dump-config：真实 profile 加载成功、生效树带来源层', { timeout: 30_000 }, () => {
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

  // W04 TC-08：web profile 不写 autoDecision（`responder: none` 是"等人点"），
  // 若有人给它加了 headless 的配置键，`rejectUnknownKeys` 会让这里退出码非 0。
  it('--profile web --dump-config：web profile 起得来（W04 TC-08）', { timeout: 30_000 }, () => {
    const result = run(['--profile', 'web', '--dump-config'])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('profile-patch:profiles/web/patch.yml')
    expect(result.stdout).toContain('channel:web')
    expect(result.stdout).toContain('bank:knowledge')
    // A8：dump 是"只看不跑"，`probe=false` 后不再做启动期探活 → stderr 严格为空
    expect(result.stderr).toBe('')
  })

  // W04 TC-09：头尾两个 profile 的审批默认值必须与矩阵一致
  // （headless / plan 的 allow 是**演示开关**，web 是人工弹窗 + 默认 reject）。
  it('三个 profile 的审批配置实测值（W04 TC-09）', { timeout: 60_000 }, () => {
    const expected: readonly (readonly [string, string])[] = [
      ['headless', '{"responder":"headless","autoDecision":"allow","autoVerify":true}'],
      ['plan', '{"responder":"headless","autoDecision":"allow","autoVerify":true}'],
      ['web', '{"responder":"none","autoDecision":"reject","autoVerify":true}'],
    ]
    for (const [profile, config] of expected) {
      const result = run(['--profile', profile, '--dump-config'])
      expect(result.status, profile).toBe(0)
      expect(result.stdout, profile).toContain(`interaction:approval`)
      expect(result.stdout, profile).toContain(config)
      expect(unexpectedStderr(result.stderr), profile).toEqual([])
    }
  })

  // W08 TC-08：headless 的 patch-*.yml 变体都必须能载入，且继承基础 patch 的 trace.sink。
  // 施工单写“7 个 patch-*.yml”；实测 6 个变体（第 7 份是基础 patch.yml，不是变体），
  // 数字差异记在 W08 回执里。
  it('W08 TC-08：6 个 headless patch 变体全部可载入（trace.sink 继承）', { timeout: 120_000 }, () => {
    const dir = join(repoRoot, 'profiles/headless')
    const variants = readdirSync(dir)
      .filter((file) => file.startsWith('patch-') && file.endsWith('.yml'))
      .sort()
    expect(variants).toHaveLength(6)

    for (const file of variants) {
      const result = run(['--profile', 'headless', '--patch', `profiles/headless/${file}`, '--dump-config'])
      expect(result.status, file).toBe(0)
      expect(unexpectedStderr(result.stderr), file).toEqual([])
      expect(result.stdout, file).toContain('"sink":"session"')
    }
  })
})
