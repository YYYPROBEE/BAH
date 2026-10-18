/**
 * 依赖清单与 base 插件集（施工单 06 §3：base = 内核 + 主循环 + 模型层 + 工具管线 + 持久化）。
 *
 * 这是**底座出口**在进程内的版本：用真实的 `HOST_PLUGINS` 装一个应用、跑一个 mock turn、
 * 把 JSONL 落盘。CLI 的端到端用例（`@bah/cli`）与进程级冒烟覆盖"命令行真的能起它"，
 * 这里覆盖"插件之间真的接得上"以及每一行的配置校验。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asSessionId, captureRejection } from '@bah/test-support'
import { LLM_ADAPTERS } from '@bah/llm'
import { AGENTS_SERVICE, SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import { describe, expect, it } from 'vitest'

import { boot, type BootedApp, type BootOptions, type ProfileSummary } from './boot.ts'
import { HOST_PLUGINS, createCatalog } from './plugins/index.ts'
import { ECHO_TOOL_NAME } from './plugins/echo.ts'
import { SESSION_FILES } from './plugins/persistence.ts'
import type { AnySessionEvent } from '@bah/runtime'

import type { Bundle, PluginRow } from './profile-plugins.ts'

const PROFILE: ProfileSummary = { name: 'fx', bundles: ['fx'], hmr: false }

/** 一条能跑通的 mock 脚本：先调 echo，再收尾。 */
const TOOL_SCRIPT = [
  { tool: { id: 'call-1', name: ECHO_TOOL_NAME, args: { text: '底稿' } } },
  { text: '已完成' },
]

/** 造一组完整的 base 行（可替换任一行配置）。 */
function rows(overrides: {
  readonly model?: unknown
  readonly agent?: unknown
  readonly persistence?: unknown
  readonly echo?: unknown
  readonly withEcho?: boolean
} = {}): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    {
      id: 'core:model',
      config:
        overrides.model === undefined
          ? { provider: 'mock', script: TOOL_SCRIPT }
          : (overrides.model as Readonly<Record<string, unknown>>),
    },
    {
      id: 'core:agent',
      config:
        overrides.agent === undefined
          ? { loop: { model: 'mock:mock-chat' } }
          : (overrides.agent as Readonly<Record<string, unknown>>),
    },
    {
      id: 'core:persistence',
      config:
        overrides.persistence === undefined
          ? { root: 'sessions', fsync: false }
          : (overrides.persistence as Readonly<Record<string, unknown>>),
    },
    ...(overrides.withEcho === false
      ? []
      : [
          {
            id: 'demo:echo',
            use: 'demo:echo',
            config: (overrides.echo ?? { prefix: '[p] ' }) as Readonly<Record<string, unknown>>,
          },
        ]),
  ]
}

/** 用真实依赖清单启动一个应用。 */
async function bootWith(
  pluginRows: readonly PluginRow[],
  options: { readonly jsonlDir?: string; readonly sessionId?: string } = {},
): Promise<BootedApp> {
  const bundle: Bundle = { name: 'fx', rows: pluginRows }
  const options_: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [],
    catalog: createCatalog(),
    run: {
      sessionId: asSessionId(options.sessionId ?? 's-plugin'),
      now: () => 1_000,
      ...(options.jsonlDir === undefined ? {} : { jsonlDir: options.jsonlDir }),
    },
  }
  return boot(options_)
}

/** 从日志里挑某类事件的载荷。 */
function payloads<T extends AnySessionEvent['type']>(
  events: readonly AnySessionEvent[],
  type: T,
): unknown[] {
  return events.filter((event) => event.type === type).map((event) => event.data)
}

describe('依赖清单（HOST_PLUGINS）', () => {
  it('清单 id 与插件名逐一对应（base 的七个插件行）', () => {
    const catalog = createCatalog()
    expect(Object.keys(catalog)).toEqual([
      'core:session',
      'core:tools',
      'core:prompt',
      'core:model',
      'core:agent',
      'core:persistence',
      'demo:echo',
    ])
    for (const plugin of HOST_PLUGINS) {
      expect(catalog[plugin.id]?.plugin.name).toBe(plugin.id)
    }
  })
})

describe('base 插件集 · 进程内跑通 turn（底座出口的进程内版本）', () => {
  it('工具调用 → 结果 → 收尾；JSONL 落盘且行数等于事件数+header', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-plugins-'))
    const app = await bootWith(rows(), { jsonlDir: dir })
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('你好')
      await agent.run()

      const session = app.ctx.get(SESSION_SERVICE)
      const events = session.events()
      expect(events.map((event) => event.type)).toContain('tool/call')
      expect(events.map((event) => event.type)).toContain('tool/result')
      // 工具结果经过七段管线，带上了 echo 的前缀
      const result = payloads(events, 'tool/result')[0] as { content: { text?: string }[] }
      expect(result.content.some((block) => block.text?.includes('[p] 底稿'))).toBe(true)

      const file = app.ctx.get(SESSION_FILES).fileOf(asSessionId('s-plugin'))
      expect(file).toBe(join(dir, 's-plugin', 'session.jsonl'))
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
      expect(lines).toHaveLength(session.lastSeq() + 1)
      expect(lines[0]).toContain('bah-session-header')
      expect(lines.some((line) => line.includes('tool/result'))).toBe(true)

      // 工具注册表里真的有 echo（模型可见）
      expect(app.ctx.get(TOOLS_SERVICE).has(ECHO_TOOL_NAME)).toBe(true)
      // 模型注册表里只有 mock 一个 provider
      expect(app.ctx.get(LLM_ADAPTERS).ids()).toEqual(['mock'])
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('channel + runtimeContext：请求里带上运行时上下文段', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-plugins-'))
    const app = await bootWith(
      rows({
        agent: {
          channel: 'headless',
          runtimeContext: { user: { name: '张三', level: '金卡' } },
          loop: { model: 'mock:mock-chat' },
        },
        model: { provider: 'mock', script: [{ text: '好的' }] },
      }),
      { jsonlDir: dir, sessionId: 's-context' },
    )
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('查一下')
      await agent.run()

      const contexts = payloads(app.ctx.get(SESSION_SERVICE).events(), 'request/context') as {
        texts: readonly string[]
      }[]
      expect(contexts).toHaveLength(1)
      expect(contexts[0]?.texts.join('')).toContain('张三')
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('默认值兜底：persistence 不写 root / fsync，echo 不写 prefix', async () => {
    const app = await bootWith(
      rows({ persistence: {}, echo: {}, model: { provider: 'mock', script: [{ text: '好的' }] } }),
    )
    try {
      const settings = app.rows()
      expect(settings.find((row) => row.id === 'core:persistence')?.settings).toEqual({
        root: 'sessions',
        fsync: true,
      })
      expect(settings.find((row) => row.id === 'demo:echo')?.settings).toEqual({ prefix: '' })
      expect(app.ctx.get(SESSION_FILES).fileOf(asSessionId('s-other'))).toBe(
        join('sessions', 's-other', 'session.jsonl'),
      )
    } finally {
      await app.dispose('test')
    }
  })

  it('core:agent 不写 loop：用默认主循环配置（真实 provider 路由）', async () => {
    const app = await bootWith(
      rows({ agent: {}, model: { provider: 'deepseek', model: 'deepseek-chat' } }),
    )
    try {
      expect(app.rows().find((row) => row.id === 'core:agent')?.settings).toEqual({
        loop: { model: 'deepseek:deepseek-chat', maxSteps: 32 },
      })
    } finally {
      await app.dispose('test')
    }
  })

  it('deepseek provider：注册真实适配器（有/无密钥都不是启动期失败）', async () => {
    const before = process.env['DEEPSEEK_API_KEY']
    try {
      delete process.env['DEEPSEEK_API_KEY']
      const withoutKey = await bootWith(rows({ model: { provider: 'deepseek' } }))
      expect(withoutKey.ctx.get(LLM_ADAPTERS).ids()).toEqual(['deepseek'])
      await withoutKey.dispose('test')

      process.env['DEEPSEEK_API_KEY'] = 'sk-test-only'
      const withKey = await bootWith(rows({ model: { provider: 'deepseek', baseUrl: 'https://x' } }))
      expect(withKey.ctx.get(LLM_ADAPTERS).ids()).toEqual(['deepseek'])
      await withKey.dispose('test')
    } finally {
      if (before === undefined) delete process.env['DEEPSEEK_API_KEY']
      else process.env['DEEPSEEK_API_KEY'] = before
    }
  })
})

describe('逐行配置校验（fail-loud）', () => {
  it('core:model：脚本形状与 provider/模型一致性全部拒绝', async () => {
    const cases: readonly (readonly [string, unknown, string])[] = [
      ['mock 缺脚本', { provider: 'mock' }, 'mock-script-missing'],
      ['deepseek 带脚本', { provider: 'deepseek', script: [{ text: 'x' }] }, 'mock-only-script'],
      ['deepseek 带 chunkSize', { provider: 'deepseek', chunkSize: 4 }, 'mock-only-config'],
      ['脚本空数组', { provider: 'mock', script: [] }, 'invalid-config'],
      ['脚本步两个键', { provider: 'mock', script: [{ text: 'x', tool: { id: 'a', name: 'b' } }] }, 'invalid-config'],
      ['脚本步都不写', { provider: 'mock', script: [{}] }, 'invalid-config'],
      ['脚本步未知键', { provider: 'mock', script: [{ text: 'x', nope: 1 }] }, 'unknown-config-key'],
      ['脚本步不是对象', { provider: 'mock', script: ['x'] }, 'invalid-config'],
      ['工具缺 name', { provider: 'mock', script: [{ tool: { id: 'a' } }] }, 'invalid-config'],
      ['工具 args 不是对象', { provider: 'mock', script: [{ tool: { id: 'a', name: 'b', args: 1 } }] }, 'invalid-config'],
      ['未知 provider', { provider: 'nope' }, 'invalid-config'],
      ['未知模型', { provider: 'mock', model: 'nope', script: [{ text: 'x' }] }, 'unknown-model'],
      ['未知键', { provider: 'mock', script: [{ text: 'x' }], nope: 1 }, 'unknown-config-key'],
      ['chunkSize 非法', { provider: 'mock', chunkSize: 0, script: [{ text: 'x' }] }, 'invalid-config'],
      ['baseUrl 非字符串', { provider: 'deepseek', baseUrl: 1 }, 'invalid-config'],
    ]

    for (const [name, model, code] of cases) {
      const error = await captureRejection(() => bootWith(rows({ model })))
      expect(`${name}: ${error.code}`).toBe(`${name}: ${code}`)
    }
  })

  it('core:agent：默认 loop / 非法 loop / 非法 channel / runtimeContext 非对象', async () => {
    const invalid = await captureRejection(() => bootWith(rows({ agent: { loop: {} } })))
    expect(invalid.code).toBe('invalid-config')

    const channel = await captureRejection(() => bootWith(rows({ agent: { channel: 'nope' } })))
    expect(channel.code).toBe('invalid-config')

    const context = await captureRejection(() =>
      bootWith(rows({ agent: { loop: { model: 'mock:mock-chat' }, runtimeContext: 1 } })),
    )
    expect(context.code).toBe('invalid-config')

    const unknown = await captureRejection(() =>
      bootWith(rows({ agent: { loop: { model: 'mock:mock-chat' }, nope: 1 } })),
    )
    expect(unknown.code).toBe('unknown-config-key')
  })

  it('无配置项的插件行：写任何键都拒绝（session / tools / prompt）', async () => {
    for (const id of ['core:session', 'core:tools', 'core:prompt']) {
      const pluginRows = rows().map((row) =>
        row.id === id ? { ...row, config: { nope: 1 } } : row,
      )
      const error = await captureRejection(() => bootWith(pluginRows))
      expect(`${id}: ${error.code}`).toBe(`${id}: unknown-config-key`)
    }
  })

  it('core:persistence / demo:echo：类型错误都拒绝', async () => {
    const root = await captureRejection(() => bootWith(rows({ persistence: { root: 1 } })))
    expect(root.code).toBe('invalid-config')

    const fsync = await captureRejection(() => bootWith(rows({ persistence: { fsync: 'yes' } })))
    expect(fsync.code).toBe('invalid-config')

    const prefix = await captureRejection(() => bootWith(rows({ echo: { prefix: 1 } })))
    expect(prefix.code).toBe('invalid-config')

    const echoUnknown = await captureRejection(() => bootWith(rows({ echo: { nope: 1 } })))
    expect(echoUnknown.code).toBe('unknown-config-key')
  })
})
