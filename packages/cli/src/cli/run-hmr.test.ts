/**
 * config-only HMR 的真实接线（`run.ts` 里 `reload` / 两个 `warn` 闭包）。
 *
 * 为什么单独一个文件：这三条闭包只有在**真的启动了 HMR 并且 watcher 触发**时才会执行，
 * 而 `runCli` 不把 `startConfigHmr` 的 `watch` 注入点透出来，所以测试也不应去抢
 * `fs.watchFile` 的 25ms 轮询窗口（那是必然 flaky 的写法）。
 *
 * 做法：把 `node:fs` 的 `watchFile` 换成一个「注册即触发」的替身——
 * 注册发生在 boot 读完 patch **之后**、turn 开始之前，因此
 * ① 改动一定晚于 boot 的读层，② reload 一定早于 `hmr.stop()`。
 * 时序被结构性地消掉了，不是靠 sleep 撞上的。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runCli, type CliIo } from './run.ts'

type Watcher = (stats: { mtimeMs: number }) => void

const { hmr } = vi.hoisted(() => ({
  hmr: {
    /** 记录每次 watch 注册的回调。 */
    watchers: [] as Watcher[],
    /** 注册瞬间要执行的「文件变更」动作（只跑一次）。 */
    onChangeDuringRegister: null as null | (() => void),
  },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watchFile: ((_file: string, _options: unknown, listener: Watcher) => {
      hmr.watchers.push(listener)
      const action = hmr.onChangeDuringRegister
      if (action !== null) {
        hmr.onChangeDuringRegister = null
        action()
        // 首次 stat 的 mtimeMs 与内部初值 0 不同 → 监听器必然被调用。
        queueMicrotask(() => listener({ mtimeMs: 1 }))
      }
    }) as unknown as typeof actual.watchFile,
    unwatchFile: (() => undefined) as unknown as typeof actual.unwatchFile,
  }
})

function write(root: string, path: string, content: string): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

const BASE_BUNDLE = `export const bundle = {
  name: 'base',
  rows: [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    { id: 'core:model', config: { provider: 'deepseek', model: 'deepseek-chat' } },
    { id: 'core:agent', config: { loop: { model: 'deepseek:deepseek-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions' } },
  ],
}
`

const HEADLESS_PATCH = `- id: core:model
  config:
    provider: mock
    model: mock-chat
    script:
      - tool: { id: call-1, name: echo, args: { text: 回显内容 } }
      - text: 已完成
- id: core:agent
  config: { channel: headless, loop: { model: 'mock:mock-chat' } }
- id: demo:echo
  use: demo:echo
  config: { prefix: '[hd] ' }
`

/** 去掉 `demo:echo` 那一行：结构变化（少一个插件行），但每一行都仍然合法。 */
const PATCH_WITHOUT_ECHO = `- id: core:model
  config:
    provider: mock
    model: mock-chat
    script:
      - tool: { id: call-1, name: echo, args: { text: 回显内容 } }
      - text: 已完成
- id: core:agent
  config: { channel: headless, loop: { model: 'mock:mock-chat' } }
`

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bah-hmr-'))
  write(root, 'bah.yml', 'profile:\n  default: hd\n  bundles: [base]\n')
  write(
    root,
    'packages/cli/package.json',
    JSON.stringify({ name: '@bah/cli', bah: { profile: { bundles: ['base'] } } }),
  )
  write(root, 'packages/cli/bundles/base/index.ts', BASE_BUNDLE)
  write(root, 'profiles/hd/profile.yml', 'bundles: [base]\npatch: ./patch.yml\nhmr: true\n')
  write(root, 'profiles/hd/patch.yml', HEADLESS_PATCH)
  return root
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } }
}

function reset(): void {
  hmr.watchers.length = 0
  hmr.onChangeDuringRegister = null
}

describe('config HMR 接线（run.ts 的三个闭包）', () => {
  it('patch 增删插件行：告警「需要重启」，且不让 turn 失败', async () => {
    const root = makeRepo()
    reset()
    const { io, err } = capture()
    try {
      // 注册 watcher 的瞬间把 patch 改成「少一个插件行」——结构变了，
      // 但不是改某行的配置，所以 boot.reload 必须走 requiresRestart 分支。
      hmr.onChangeDuringRegister = () => {
        write(root, 'profiles/hd/patch.yml', PATCH_WITHOUT_ECHO)
      }

      const code = await runCli(
        ['--profile', 'hd', '--prompt', '回显', '--jsonl', join(root, 'out')],
        io,
        { root, now: () => 1_000 },
      )

      expect(code).toBe(0)
      // 这是 run.ts 传给 boot 的 warn：插件行结构变化不可热更。
      expect(err.join('\n')).toContain('config-only HMR 不处理这些')
      expect(hmr.watchers.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
      reset()
    }
  })

  it('patch 被改坏：重载失败必须告警并沿用旧配置，不能静默也不能中断', async () => {
    const root = makeRepo()
    reset()
    const { io, err } = capture()
    try {
      hmr.onChangeDuringRegister = () => {
        // 非法 YAML：readLayers 在 reload 时会抛，落到 startConfigHmr 的 catch。
        write(root, 'profiles/hd/patch.yml', '- id: [未闭合\n')
      }

      const code = await runCli(
        ['--profile', 'hd', '--prompt', '回显', '--jsonl', join(root, 'out')],
        io,
        { root, now: () => 1_000 },
      )

      expect(code).toBe(0)
      // 这是 run.ts 传给 startConfigHmr 的 warn：失败可见，旧配置继续生效。
      expect(err.join('\n')).toContain('配置重载失败')
    } finally {
      rmSync(root, { recursive: true, force: true })
      reset()
    }
  })
})
