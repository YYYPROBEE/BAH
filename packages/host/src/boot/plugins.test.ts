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
import {
  AGENTS_SERVICE,
  RUNTIME_CONTEXT_SOURCE,
  SESSION_SERVICE,
  TOOLS_SERVICE,
} from '@bah/runtime'
import { describe, expect, it } from 'vitest'

import { boot, type BootedApp, type BootOptions, type ProfileSummary } from './boot.ts'
import { HOST_PLUGINS, createCatalog } from './plugins/index.ts'
import { ECHO_TOOL_NAME } from './plugins/echo.ts'
import { SESSION_FILES } from './plugins/persistence.ts'
import { testRunContext } from './test-run-context.ts'
import type { AnySessionEvent, RuntimeContextSource } from '@bah/runtime'

import type { Bundle, PluginRow } from './profile-plugins.ts'
import type { HostPlugin, PluginCatalog } from '../plugin-manager/index.ts'

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
  options: {
    readonly jsonlDir?: string
    readonly sessionId?: string
    readonly catalog?: PluginCatalog
  } = {},
): Promise<BootedApp> {
  const bundle: Bundle = { name: 'fx', rows: pluginRows }
  const options_: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [],
    catalog: options.catalog ?? createCatalog(),
    run: testRunContext({
      sessionId: asSessionId(options.sessionId ?? 's-plugin'),
      now: () => 1_000,
      ...(options.jsonlDir === undefined ? {} : { jsonlDir: options.jsonlDir }),
    }),
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

/**
 * 从日志里挑某类**领域**事件（`context/slots` / `identity/bound` 等）。
 *
 * 它们走 `appendDomain`、不在 `AnySessionEvent` 联合里（也不占 19 键平台表），
 * 所以只能按 `String(event.type)` 过滤——这正是"域事件与平台事件分开"的代价与证据。
 */
function domainPayloads(
  events: readonly AnySessionEvent[],
  type: string,
): readonly Record<string, unknown>[] {
  return events
    .filter((event) => String(event.type) === type)
    .map((event) => event.data as Record<string, unknown>)
}

describe('依赖清单（HOST_PLUGINS）', () => {
  it('清单 id 与插件名逐一对应（base 的全部插件行）', () => {
    const catalog = createCatalog()
    expect(Object.keys(catalog)).toEqual([
      'core:session',
      // 可观测性 01：紧跟 session 之后（只 inject run + session）
      'obs:telemetry',
      'core:tools',
      'core:prompt',
      'core:model',
      'core:agent',
      'core:persistence',
      'audit:decisions',
      'demo:echo',
      'bank:tools',
      'policy:rules',
      'bank:knowledge',
      'interaction:approval',
      'safety:sentry',
      'safety:verify',
      'safety:sandbox',
      'bank:saga-store',
      'bank:saga',
      'bank:saga-audit',
      // 接线层：把写工具接进协调器（缺了它 `runSaga` 生产零调用）
      'bank:saga-bridge',
      // 编排原语（plan:dag）：登记 = 可被 patch 的 `use` 引用，不等于默认装配
      'plan:dag',
      // G2/G3：到期唤醒驱动器与生活事实库（同样只登记不默认装配）
      'plan:scheduler',
      'fact:store',
      'bank:merchant',
      // ADR-0016：订阅续费主动提醒 + 通用主动通知通道（只登记不默认装配）
      'proactive:reminder',
      // C4 跨会话记忆：同样只登记不默认装配（记忆会改变模型输入，由 profile 显式开）
      'bah:memory-store',
      // 03 单：意图平面与追问。两行按序装配（prompt:ask 取 intent:plane 的会话状态）
      'intent:plane',
      'prompt:ask',
      // 渠道（施工单 13）：不在 base bundle 里，由 profiles/web 的 patch 加行
      'channel:web',
      // 渠道（施工单 01）：同样只登记不默认装配，由 profiles/mobile 的 patch 加行
      'channel:mobile',
      // 渠道（施工单 15 / 桌面端 01）：同样只登记不默认装配，由 profiles/desktop 的 patch 加行
      'channel:desktop',
      // IM 网关 01：同样只登记不默认装配，由 profiles/im 的 patch 加行
      'channel:im',
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
      expect(file).toBe(join(dir, 'demo', 's-plugin', 'session.jsonl'))
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
        join('sessions', 'demo', 's-other', 'session.jsonl'),
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
        loop: { model: 'deepseek:deepseek-chat', maxSteps: 32, parallelReadTools: true },
        // S3：槽位开关有默认值（关），所以设置面多一个键——这是**默认关闭**，不是行为变化
        slots: { source: 'none' },
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
      ['deepseek 带 chunkSize', { provider: 'deepseek', chunkSize: 4 }, 'local-only-config'],
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

/* ── 实体槽位（S3）：core:agent.slots 的配置面与运行时接线 ──────────────────── */

/** 槽位端口测试替身插件：只 provide 一个 `runtime:context-source`（不碰 bank）。 */
function slotsStubPlugin(source: RuntimeContextSource): HostPlugin<Record<string, never>> {
  return {
    id: 'test:slots',
    plugin: {
      name: 'test:slots',
      apply(ctx) {
        ctx.effect(ctx.provide(RUNTIME_CONTEXT_SOURCE, source))
      },
    },
    validate: () => ({}),
  }
}

describe('实体槽位配置（core:agent.slots）', () => {
  const AGENT = { loop: { model: 'mock:mock-chat' } }

  it('slots 形状与 bank/静态互斥：全部 fail-loud', async () => {
    const account = {
      name: '活期',
      maskedNumber: '1234',
      balanceText: '¥1.00',
      availableText: '¥1.00',
    }
    const cases: readonly (readonly [string, unknown, string])[] = [
      ['非法 source', { ...AGENT, slots: { source: 'nope' } }, 'invalid-config'],
      ['slots 未知键', { ...AGENT, slots: { source: 'bank', extra: 1 } }, 'unknown-config-key'],
      [
        'bank + 静态 accounts',
        { ...AGENT, slots: { source: 'bank' }, runtimeContext: { accounts: [account] } },
        'invalid-config',
      ],
      [
        'bank + 静态 recentTransactions',
        {
          ...AGENT,
          slots: { source: 'bank' },
          runtimeContext: { recentTransactions: ['2023-11-10 06:13 转出 ¥1.00（消费）'] },
        },
        'invalid-config',
      ],
      [
        '旧形状 balance: number',
        { ...AGENT, runtimeContext: { accounts: [{ name: 'x', maskedNumber: '1234', balance: 1 }] } },
        'unknown-config-key',
      ],
      [
        '缺 balanceText',
        {
          ...AGENT,
          runtimeContext: { accounts: [{ name: 'x', maskedNumber: '1234', availableText: '¥0.00' }] },
        },
        'invalid-config',
      ],
      [
        'profile 写 meta（运行时字段，防伪造 source=bank）',
        { ...AGENT, runtimeContext: { meta: { source: 'bank', status: 'ok' } } },
        'unknown-config-key',
      ],
      ['user.name 非字符串', { ...AGENT, runtimeContext: { user: { name: 1 } } }, 'invalid-config'],
      ['notes 含非字符串', { ...AGENT, runtimeContext: { notes: [1] } }, 'invalid-config'],
      ['accounts 不是数组', { ...AGENT, runtimeContext: { accounts: {} } }, 'invalid-config'],
    ]

    for (const [name, agent, code] of cases) {
      const error = await captureRejection(() => bootWith(rows({ agent })))
      expect(`${name}: ${error.code}`).toBe(`${name}: ${code}`)
    }
  })

  it('旧静态画像照旧：上下文逐字不变，且不落 context/slots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-slots-static-'))
    const app = await bootWith(
      rows({
        agent: {
          loop: { model: 'mock:mock-chat' },
          runtimeContext: {
            user: { name: '张三', level: '金卡' },
            notes: ['本对话运行在仿真数据集（demo 档）。'],
          },
        },
        model: { provider: 'mock', script: [{ text: '好的' }] },
      }),
      { jsonlDir: dir, sessionId: 's-slots-static' },
    )
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('查一下')
      await agent.run()

      const events = app.ctx.get(SESSION_SERVICE).events()
      const contexts = payloads(events, 'request/context') as { texts: readonly string[] }[]
      expect(contexts).toHaveLength(1)
      expect(contexts[0]?.texts[0]).toBe(
        '【当前用户】姓名：张三；等级：金卡\n【补充说明】\n- 本对话运行在仿真数据集（demo 档）。',
      )
      expect(events.some((event) => String(event.type) === 'context/slots')).toBe(false)
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('slots.source=bank 但没装 bank:tools → turn failed（slots-source-missing），不提交任何模型可见输入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-slots-missing-'))
    const app = await bootWith(
      rows({
        agent: { loop: { model: 'mock:mock-chat' }, slots: { source: 'bank' } },
        model: { provider: 'mock', script: [{ text: '不应该被调用' }] },
      }),
      { jsonlDir: dir, sessionId: 's-slots-missing' },
    )
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('查一下余额')
      // 解析异常的语义：**turn 以 failed 收尾**（不是 run 抛错，也不是静默退回静态）
      await agent.run()

      const events = app.ctx.get(SESSION_SERVICE).events()
      expect(events.some((event) => event.type === 'system/message')).toBe(false)
      expect(events.some((event) => event.type === 'request/context')).toBe(false)
      const end = payloads(events, 'turn/end')[0] as {
        reason: { kind: string; reason?: string }
      }
      expect(end.reason.kind).toBe('failed')
      expect(String(end.reason.reason)).toContain('slots-source-missing')
      const attempt = payloads(events, 'assistant/attempt')[0] as { status: string; reason: string }
      expect(attempt.status).toBe('failed')
      expect(attempt.reason).toContain('runtime:context-source')
      expect(events.some((event) => String(event.type) === 'context/slots')).toBe(false)
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('每 step 现算：第一步 unbound、第二步 ok（两条 context/slots、两段不同上下文）', async () => {
    let calls = 0
    const source: RuntimeContextSource = {
      resolve: async () => {
        calls += 1
        if (calls === 1) return { status: 'unbound' }
        return {
          status: 'ok',
          asOfText: '2023-11-15 06:13',
          view: {
            user: { name: '张三' },
            accounts: [
              {
                name: '活期',
                maskedNumber: '1234',
                balanceText: '¥12,345.67',
                availableText: '¥12,345.67',
                statusText: '正常',
              },
            ],
            notes: ['本对话运行在仿真数据集（demo 档）。'],
          },
        }
      },
    }

    const dir = mkdtempSync(join(tmpdir(), 'bah-slots-steps-'))
    const app = await bootWith(
      [
        ...rows({
          agent: { loop: { model: 'mock:mock-chat', maxSteps: 4 }, slots: { source: 'bank' } },
          model: {
            provider: 'mock',
            script: [
              { tool: { id: 'call-1', name: ECHO_TOOL_NAME, args: { text: '底稿' } } },
              { text: '收尾' },
            ],
          },
        }),
        // 端口由测试插件提供（row 必须存在，否则插件不会被 apply）
        { id: 'test:slots' },
      ],
      {
        jsonlDir: dir,
        sessionId: 's-slots-steps',
        catalog: createCatalog([...HOST_PLUGINS, slotsStubPlugin(source)]),
      },
    )
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('查一下余额')
      await agent.run()

      const events = app.ctx.get(SESSION_SERVICE).events()
      const slots = domainPayloads(events, 'context/slots') as {
        status: string
        accounts: number
        transactions: number
      }[]
      expect(slots.map((slot) => slot.status)).toEqual(['unbound', 'ok'])
      expect(slots[1]).toMatchObject({ accounts: 1, transactions: 0 })

      const contexts = payloads(events, 'request/context') as { texts: readonly string[] }[]
      expect(contexts).toHaveLength(2)
      const first = contexts[0]?.texts.join('\n') ?? ''
      const second = contexts[1]?.texts.join('\n') ?? ''
      expect(first).toContain('【当前用户】身份未绑定')
      expect(first).not.toContain('【账户概览】')
      expect(second).toContain('【账户概览】')
      expect(second).toContain('¥12,345.67')
      expect(first).not.toBe(second)
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
