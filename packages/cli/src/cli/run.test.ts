/**
 * CLI 端到端（施工单 06 §0 出口标准 1 / 2 / 4 的命令行面）。
 *
 * 每个用例都在临时目录里搭一个**真仓库**（`bah.yml` + `packages/cli/bundles/*` + `profiles/*`），
 * 然后用 `runCli` 走完整链路：解析参数 → 读 profile → 加载 bundle → boot → 跑 turn → 落盘。
 * 这样测的是"CLI 真的能起一个应用"，而不是某个函数的形状。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureThrown } from '@bah/test-support'
import { deriveMessages } from '@bah/runtime'
import { AGENTS_SERVICE, AgentRegistry } from '@bah/runtime'
import { createContext } from '@bah/core'
import { describe, expect, it } from 'vitest'

import type { AnySessionEvent, TurnEndReason } from '@bah/runtime'
import type { Context } from '@bah/core'

import {
  HELP,
  USAGE,
  describeReason,
  lastAssistantText,
  lastTurnEnd,
  onlyAgent,
  parseArgs,
  runCli,
  type CliIo,
} from './run.ts'

/** 收集输出（测试用）。 */
interface Captured {
  readonly io: CliIo
  readonly out: string[]
  readonly err: string[]
}

function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } }
}

/** 写文件（自动建父目录）。 */
function write(root: string, path: string, content: string): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

/** base bundle：与仓库里的 `packages/cli/bundles/base/index.ts` 同形（数据）。 */
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

/** 没有 agent 的 bundle（`agent-absent` 用）。 */
const BARE_BUNDLE = `export const bundle = { name: 'bare', rows: [{ id: 'core:session' }] }
`

/** headless 风格 patch：mock 脚本里先调工具再收尾，且开着 config HMR。 */
const HEADLESS_PATCH = `- id: core:model
  config:
    provider: mock
    model: mock-chat
    script:
      - tool: { id: call-1, name: echo, args: { text: 回显内容 } }
      - text: 已完成
- id: core:agent
  config: { channel: headless, loop: { model: mock:mock-chat } }
- id: demo:echo
  use: demo:echo
  config: { prefix: '[hd] ' }
`

/** 纯文本 patch（hmr 关闭，用来验证"不打印 HMR 提示"）。 */
const PLAIN_PATCH = `- id: core:model
  config:
    provider: mock
    script:
      - text: 只有文本
- id: core:agent
  config: { loop: { model: mock:mock-chat } }
`

/** 被截断的 patch（turn 以 max-tokens 关闭 → 退出码 1）。 */
const TRUNCATED_PATCH = `- id: core:model
  config:
    provider: mock
    script:
      - text: 被截断
        finish: length
- id: core:agent
  config: { loop: { model: mock:mock-chat } }
`

/** 搭一个最小真仓库。 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bah-run-'))
  write(root, 'bah.yml', 'profile:\n  default: hd\n  bundles: [base, bare]\n')
  write(
    root,
    'packages/cli/package.json',
    JSON.stringify({ name: '@bah/cli', bah: { profile: { bundles: ['base', 'bare'] } } }),
  )
  write(root, 'packages/cli/bundles/base/index.ts', BASE_BUNDLE)
  write(root, 'packages/cli/bundles/bare/index.ts', BARE_BUNDLE)
  write(root, 'profiles/hd/profile.yml', 'bundles: [base]\npatch: ./patch.yml\nhmr: true\n')
  write(root, 'profiles/hd/patch.yml', HEADLESS_PATCH)
  write(root, 'profiles/plain/profile.yml', 'bundles: [base]\npatch: ./patch.yml\nhmr: false\n')
  write(root, 'profiles/plain/patch.yml', PLAIN_PATCH)
  write(root, 'profiles/truncated/profile.yml', 'bundles: [base]\npatch: ./patch.yml\n')
  write(root, 'profiles/truncated/patch.yml', TRUNCATED_PATCH)
  write(root, 'profiles/bare/profile.yml', 'bundles: [bare]\n')
  write(root, 'profiles/empty/.gitkeep', '')
  write(root, 'home/bah.patch.yml', '- id: demo:echo\n  config: { prefix: "[home] " }\n')
  write(root, 'overlay.yml', '- id: core:agent\n  config: { channel: headless }\n')
  return root
}

/** 读 JSONL 事件（跳过 header）。 */
function readEvents(file: string): AnySessionEvent[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .slice(1)
    .map((line) => JSON.parse(line) as AnySessionEvent)
}

describe('headless 端到端（底座出口）', () => {
  it('跑通完整 turn：工具调用 + 收尾 + JSONL 落盘 + 可派生重建', async () => {
    const root = makeRepo()
    const { io, out } = capture()
    try {
      const code = await runCli(
        ['--profile', 'hd', '--prompt', '你好', '--session', 's-e2e', '--jsonl', join(root, 'out')],
        io,
        { root, now: () => 1_000 },
      )

      expect(code).toBe(0)
      expect(out.some((line) => line.includes('回复 已完成'))).toBe(true)
      expect(out.some((line) => line.includes('config HMR 开'))).toBe(true)
      expect(out.some((line) => line.includes('会话 s-e2e'))).toBe(true)

      const file = join(root, 'out', 's-e2e', 'session.jsonl')
      const events = readEvents(file)
      // seq 连续、header 在首行
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
      expect(events.map((event) => event.type)).toContain('tool/call')
      expect(events.map((event) => event.type)).toContain('tool/result')
      expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!)).toMatchObject({
        kind: 'bah-session-header',
        sessionId: 's-e2e',
      })

      // 派生重建：工具结果带上前缀，assistant 收尾是脚本第二步
      const messages = deriveMessages(events)
      expect(messages.some((message) => message.role === 'tool' && message.callId === 'call-1')).toBe(true)
      expect(
        messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some((block) => block.type === 'text' && block.text === '已完成'),
        ),
      ).toBe(true)
      expect(out.some((line) => /（\d+ 条事件）/.test(line))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('不写 --profile 时用 bah.yml 的 profile.default；不写 --session 时按时钟生成', async () => {
    const root = makeRepo()
    const { io, out } = capture()
    try {
      const code = await runCli(['--prompt', '你好', '--jsonl', join(root, 'out')], io, {
        root,
        now: () => 99_999,
      })

      expect(code).toBe(0)
      expect(out.some((line) => line.includes(`会话 s-${(99_999).toString(36)}`))).toBe(true)
      expect(out.some((line) => line.includes('回复 已完成'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hmr 关的 profile 不打印 HMR 提示', async () => {
    const root = makeRepo()
    const { io, out } = capture()
    try {
      const code = await runCli(['--profile', 'plain', '--prompt', '你好', '--jsonl', join(root, 'out')], io, {
        root,
        now: () => 1_000,
      })
      expect(code).toBe(0)
      expect(out.some((line) => line.includes('config HMR'))).toBe(false)
      expect(out.some((line) => line.includes('回复 只有文本'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('turn 未以 completed 关闭：退出码 1 并说明原因', async () => {
    const root = makeRepo()
    const { io, err } = capture()
    try {
      const code = await runCli(
        ['--profile', 'truncated', '--prompt', '你好', '--jsonl', join(root, 'out')],
        io,
        { root, now: () => 1_000 },
      )
      expect(code).toBe(1)
      expect(err.some((line) => line.includes('max-tokens'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BAH_HOME 指向的 home patch 会叠加成一层', async () => {
    const root = makeRepo()
    const { io, out } = capture()
    try {
      const code = await runCli(['--profile', 'hd', '--dump-config'], io, {
        root,
        env: { BAH_HOME: join(root, 'home') },
      })
      expect(code).toBe(0)
      expect(out.join('\n')).toContain('home-patch:')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('--dump-config 端到端', () => {
  it('四层（bundle / profile patch / home patch / overlay）都带来源标注', async () => {
    const root = makeRepo()
    const { io, out } = capture()
    try {
      const code = await runCli(
        ['--profile', 'hd', '--dump-config', '--home', join(root, 'home'), '--patch', 'overlay.yml'],
        io,
        { root },
      )
      const text = out.join('\n')
      expect(code).toBe(0)
      expect(text).toContain('profile hd（bundles: base；config HMR: 开）')
      expect(text).toContain('bundle:base')
      expect(text).toContain('profile-patch:profiles/hd/patch.yml')
      expect(text).toContain('home-patch:')
      expect(text).toContain('overlay:overlay.yml')
      // overlay 把 core:agent 整块换成了只写 channel 的配置 → 其余字段走默认值（loop）
      expect(text).toMatch(/"channel":"headless"/)
      expect(text).toMatch(/"maxSteps":32/)
      expect(text).toContain('bah: 共 7 行')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('运行期失败（退出码 1）', () => {
  it('profile 里没有 core:agent：agent-absent', async () => {
    const root = makeRepo()
    const { io, err } = capture()
    try {
      const code = await runCli(['--profile', 'bare', '--prompt', '你好'], io, { root })
      expect(code).toBe(1)
      expect(err.some((line) => line.includes('没有活体 agent'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('只给 --profile 不给 --prompt：提示需要 --prompt', async () => {
    const root = makeRepo()
    const { io, err } = capture()
    try {
      const code = await runCli(['--profile', 'plain'], io, { root })
      expect(code).toBe(1)
      expect(err.some((line) => line.includes('需要 --prompt'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('未知 profile / 占位 profile / 没写默认 profile：都是退出码 1', async () => {
    const root = makeRepo()
    const empty = mkdtempSync(join(tmpdir(), 'bah-run-empty-'))
    try {
      const unknown = capture()
      expect(await runCli(['--profile', 'ghost'], unknown.io, { root })).toBe(1)
      expect(unknown.err.some((line) => line.includes('未知 profile'))).toBe(true)

      const pending = capture()
      expect(await runCli(['--profile', 'empty'], pending.io, { root })).toBe(1)
      expect(pending.err.some((line) => line.includes('占位目录'))).toBe(true)

      const noDefault = capture()
      expect(await runCli(['--prompt', '你好'], noDefault.io, { root: empty })).toBe(1)
      expect(noDefault.err.some((line) => line.includes('未指定 --profile'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('overlay 文件不存在：退出码 1（写了却读不到 = 配置错）', async () => {
    const root = makeRepo()
    const { io, err } = capture()
    try {
      const code = await runCli(['--profile', 'hd', '--dump-config', '--patch', 'ghost.yml'], io, { root })
      expect(code).toBe(1)
      expect(err.some((line) => line.includes('不存在'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('用法错误（退出码 2）', () => {
  it('未知参数 / 缺值 / 给布尔开关赋值：退出码 2 + 用法提示', async () => {
    for (const argv of [['--nope'], ['--profile'], ['--dump-config=1'], ['--help=true']]) {
      const { io, err } = capture()
      expect(await runCli(argv, io)).toBe(2)
      expect(err).toContain(USAGE)
    }
  })

  it('--help：退出码 0，打印完整帮助', async () => {
    const { io, out } = capture()
    expect(await runCli(['--help'], io)).toBe(0)
    expect(out).toEqual([HELP])
  })
})

describe('参数解析（补充用例）', () => {
  it('支持 --flag=value 与重复 --patch', () => {
    const parsed = parseArgs(['--profile=hd', '--patch=a.yml', '--patch', 'b.yml', '--prompt=你好'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.args.profile).toBe('hd')
    expect(parsed.args.patch).toEqual(['a.yml', 'b.yml'])
    expect(parsed.args.prompt).toBe('你好')
  })

  it('取值为空的 --flag= 也算缺值', () => {
    const parsed = parseArgs(['--profile='])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('需要一个值')
  })
})

describe('事件流辅助函数（补充用例）', () => {  it('lastAssistantText：没有文本回复时给占位文案，多段文本按序拼接', () => {
    expect(lastAssistantText([])).toBe('（本轮没有文本回复）')
    const events: AnySessionEvent[] = [
      {
        seq: 1,
        at: 0,
        formatVersion: 1,
        type: 'assistant/message',
        data: { content: [{ type: 'text', text: '前半' }] },
      },
      {
        seq: 2,
        at: 0,
        formatVersion: 1,
        type: 'assistant/message',
        data: {
          content: [
            { type: 'text', text: '后半' },
            { type: 'text', text: '！' },
          ],
        },
      },
    ]
    expect(lastAssistantText(events)).toBe('后半！')
  })

  it('lastTurnEnd：没有 turn/end 时为 undefined', () => {
    expect(lastTurnEnd([])).toBeUndefined()
    const events: AnySessionEvent[] = [
      { seq: 1, at: 0, formatVersion: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(lastTurnEnd(events)).toEqual({ kind: 'completed' })
  })

  it('describeReason：六种原因 + 未知标签由 assertNever 拒绝', () => {
    expect(describeReason({ kind: 'completed' })).toBe('completed')
    expect(describeReason({ kind: 'blocked' })).toContain('blocked')
    expect(describeReason({ kind: 'aborted' })).toContain('aborted')
    expect(describeReason({ kind: 'max-tokens' })).toContain('max-tokens')
    expect(describeReason({ kind: 'guard-stopped', reason: '超预算' })).toBe(
      'guard-stopped（判停：超预算）',
    )
    expect(describeReason({ kind: 'failed', reason: '炸了' })).toContain('炸了')
    expect(() => describeReason({ kind: 'bogus' } as unknown as TurnEndReason)).toThrow(/turn-end-reason/)
  })

  it('onlyAgent：服务未注册 / 注册表为空都翻译成 agent-absent', () => {
    expect(captureThrown(() => onlyAgent(createContext())).code).toBe('agent-absent')

    const ctx = createContext()
    ctx.provide(AGENTS_SERVICE, new AgentRegistry())
    expect(captureThrown(() => onlyAgent(ctx)).code).toBe('agent-absent')
  })

  it('onlyAgent：取服务时的意外错误原样上抛（不吞成 agent-absent）', () => {
    // 只用 get 的替身：验证"只翻译 service-missing，其它错误照原样冒泡"
    const broken = {
      get() {
        throw new Error('意料之外的失败')
      },
    } as unknown as Context
    expect(() => onlyAgent(broken)).toThrow('意料之外的失败')
  })
})
