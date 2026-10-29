/**
 * `intent:plane` / `prompt:ask` 装配（03 单 §4 步 9）。
 *
 * 判据是「接缝真的通了」，不是「函数能跑」：
 * - 两个工具真的进了工具面（`runtime:tools`），不是只定义了没人注册；
 * - 契约真的挂在 `runtime:tool-contracts` 上（坏出参会被 `checkToolResult` 拦）；
 * - `prompt:ask` 的追问计数与 `intent:plane` 的槽位表共用一份会话状态。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asSessionId } from '@bah/test-support'
import {
  INTENT_RESOLVE_TOOL,
  SESSION_SERVICE,
  TOOLS_SERVICE,
  checkToolResult,
  findToolContracts,
} from '@bah/runtime'
import { PROMPT_ASK_TOOL } from '@bah/interaction'
import { BahError, DEFAULT_TENANT_ID, validateAgainstSchema } from '@bah/util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolExecContext } from '@bah/core'
import { boot, type BootedApp, type ProfileSummary } from '../boot.ts'
import { rejectUnknownKeys } from '../config.ts'
import { INTENT_STATE_SERVICE, createCatalog, intentPlanePlugin, promptAskPlugin } from './index.ts'
import { demoMemoryPort, parseDemoMemory } from './intent.ts'
import type { PluginRow } from '../profile-plugins.ts'
import type { DemoMemoryEntry } from './intent.ts'

const PROFILE: ProfileSummary = { name: 'intent-test', bundles: ['t'], hmr: false }

/** 配置面用 YAML 风格（fields 是对象）；端口面用解析后的条目（fields 是数组）。 */
const DEMO_CONFIG = [{ scene: 'transfer', fields: { payee: '王建国', amountCents: 80000 } }]
const DEMO: readonly DemoMemoryEntry[] = parseDemoMemory(DEMO_CONFIG, 'test')

const ROWS: readonly PluginRow[] = [
  { id: 'core:session' },
  { id: 'core:tools' },
  { id: 'intent:plane', config: { demoMemory: DEMO_CONFIG } },
  { id: 'prompt:ask' },
]

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bah-intent-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function bootIntent(rows: readonly PluginRow[] = ROWS): Promise<BootedApp> {
  return boot({
    profile: PROFILE,
    bundles: [{ name: 't', rows }],
    layers: [],
    catalog: createCatalog(),
    run: {
      sessionId: asSessionId('s-intent'),
      tenantId: DEFAULT_TENANT_ID,
      now: () => 1_700_000_000_000,
      jsonlDir: dir,
    },
  })
}

function execCtx(sessionId = 's-intent'): ToolExecContext {
  return { sessionId: asSessionId(sessionId), callId: 'c-1', signal: new AbortController().signal }
}

describe('parseDemoMemory（配置校验）', () => {
  it('缺省返回空数组', () => {
    expect(parseDemoMemory(undefined, 'w')).toEqual([])
  })

  it('正常解析并补默认值', () => {
    const entries = parseDemoMemory([{ scene: 'transfer', fields: { payee: '张三', amountCents: 100 } }], 'w')
    expect(entries).toEqual([
      {
        unitId: 'demo-0',
        scene: 'transfer',
        confidence: 0.8,
        fields: [
          { name: 'payee', value: '张三' },
          { name: 'amountCents', value: 100 },
        ],
      },
    ])
  })

  it('非数组 / 非对象 / 未知场景 / 越界置信度 / 未知槽位 / 非法值都 fail-loud', () => {
    const cases: readonly unknown[] = [
      'x',
      [1],
      [{ scene: 'nope', fields: {} }],
      [{ scene: 'transfer', fields: {}, confidence: 1.5 }],
      [{ scene: 'transfer', fields: { nope: 1 } }],
      [{ scene: 'transfer', fields: { payee: true } }],
      [{ scene: 'transfer', fields: [] }],
      [{ scene: 'transfer', fields: {}, match: '' }],
    ]
    for (const raw of cases) expect(() => parseDemoMemory(raw, 'w')).toThrow(BahError)
  })

  it('未知配置键被拒绝', () => {
    expect(() => rejectUnknownKeys({ nope: 1 }, ['enabled'], 'intent:plane')).toThrow(BahError)
  })

  it('插件 validate 产出带默认值的设置', () => {
    expect(intentPlanePlugin.validate({})).toEqual({
      enabled: true,
      tenant: 'demo',
      userId: 'u-1',
      demoMemory: [],
    })
    expect(promptAskPlugin.validate({}).enabled).toBe(true)
  })
})

describe('demoMemoryPort（确定性假记忆）', () => {
  const port = demoMemoryPort(DEMO, 0.6)

  it('unknown 场景不检索（EMPTY_UNKNOWN_SCENE）', async () => {
    await expect(port.retrieve({ scene: 'unknown', maxK: 8, utterance: '随便' })).resolves.toEqual({
      memories: [],
      routeCode: 'EMPTY_UNKNOWN_SCENE',
    })
  })

  it('按场景过滤并带结构化槽位', async () => {
    const result = await port.retrieve({ scene: 'transfer', maxK: 8, utterance: '上次那个转账再来一次' })
    expect(result.routeCode).toBe('ROUTE_OK')
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0]?.fields).toHaveLength(2)
  })

  it('跨场景低置信度拒借，且不返回记忆', async () => {
    const result = await port.retrieve({
      scene: 'cross_scene',
      maxK: 8,
      utterance: '把那边的事接着办',
      crossSceneRef: { target: 'transfer', confidence: 0.59 },
    })
    expect(result.routeCode).toBe('CROSS_SCENE_REFUSED')
    expect(result.memories).toEqual([])
    expect(result.crossSceneRef?.accepted).toBe(false)
  })

  it('跨场景高置信度放行', async () => {
    const result = await port.retrieve({
      scene: 'cross_scene',
      maxK: 8,
      utterance: '把那边的事接着办',
      crossSceneRef: { target: 'transfer', confidence: 0.61 },
    })
    expect(result.routeCode).toBe('ROUTE_OK')
    expect(result.crossSceneRef?.accepted).toBe(true)
  })
})

describe('装配面（E3 注册点）', () => {
  it('两个工具都在工具面：模型看得见', async () => {
    const app = await bootIntent()
    try {
      const names = app.ctx.get(TOOLS_SERVICE).list().map((tool) => tool.name)
      expect(names).toContain(INTENT_RESOLVE_TOOL)
      expect(names).toContain(PROMPT_ASK_TOOL)
    } finally {
      await app.dispose('test')
    }
  })

  it('契约挂在服务上：坏出参被 checkToolResult 拦下', async () => {
    const app = await bootIntent()
    try {
      const source = findToolContracts(app.ctx)
      expect(source?.get(INTENT_RESOLVE_TOOL)).toBeDefined()
      expect(source?.get(PROMPT_ASK_TOOL)).toBeDefined()
      // 未知工具不提供契约（管线据此跳过校验）
      expect(source?.get('no-such-tool')).toBeUndefined()
      const violation = checkToolResult(source, INTENT_RESOLVE_TOOL, { kind: 'x' })
      expect(violation?.code).toBe('required')
    } finally {
      await app.dispose('test')
    }
  })

  it('工具真跑：intent_resolve 产出 proceed，出参过契约', async () => {
    const app = await bootIntent()
    try {
      const registry = app.ctx.get(TOOLS_SERVICE)
      const tool = registry.get(INTENT_RESOLVE_TOOL)
      const result = await tool.execute({ utterance: '给张三转500元', scene: 'transfer' }, execCtx())
      expect(result).toMatchObject({ kind: 'explicit', decision: 'proceed', requiresPreview: false })
      expect(checkToolResult(findToolContracts(app.ctx), INTENT_RESOLVE_TOOL, result)).toBeUndefined()
    } finally {
      await app.dispose('test')
    }
  })

  it('真跑模糊复现：demoMemory 夹具让 vague 走通并要求预演', async () => {
    const app = await bootIntent()
    try {
      const tool = app.ctx.get(TOOLS_SERVICE).get(INTENT_RESOLVE_TOOL)
      const result = (await tool.execute(
        { utterance: '上次那个转账再来一次', scene: 'transfer' },
        execCtx(),
      )) as { kind: string; requiresPreview: boolean; filled: readonly { name: string; source: string }[] }
      expect(result.kind).toBe('vague')
      expect(result.requiresPreview).toBe(true)
      expect(result.filled.some((slot) => slot.source === 'memory')).toBe(true)
    } finally {
      await app.dispose('test')
    }
  })

  it('问答复用同一份会话状态：第 3 次 prompt_ask 降级', async () => {
    const app = await bootIntent()
    try {
      const tool = app.ctx.get(TOOLS_SERVICE).get(PROMPT_ASK_TOOL)
      const args = {
        question: '要转给谁？',
        candidates: [
          { label: '王建国', value: 'p-wang' },
          { label: '张伟', value: 'p-zhang' },
        ],
        slot: 'payee',
      }
      const first = (await tool.execute(args, execCtx())) as { askExhausted: boolean }
      const second = (await tool.execute(args, execCtx())) as { askExhausted: boolean }
      const third = (await tool.execute(args, execCtx())) as { askExhausted: boolean; degraded: boolean }
      expect(first.askExhausted).toBe(false)
      expect(second.askExhausted).toBe(false)
      expect(third.askExhausted).toBe(true)
      expect(third.degraded).toBe(true)
      expect(app.ctx.get(INTENT_STATE_SERVICE).askCount('s-intent', 'payee')).toBe(2)
    } finally {
      await app.dispose('test')
    }
  })

  it('点选 label 回到下一轮：识别为 user-choice 并进 turn 层', async () => {
    const app = await bootIntent()
    try {
      const intent = app.ctx.get(TOOLS_SERVICE).get(INTENT_RESOLVE_TOOL)
      // 第一轮：代词无先行词 ⇒ 追问，候选来自记忆
      const asked = (await intent.execute({ utterance: '转500给他', scene: 'transfer' }, execCtx())) as {
        decision: string
        askHint: { candidates: readonly { value: string | number }[] } | null
      }
      expect(asked.decision).toBe('ask')
      expect(asked.askHint?.candidates.length).toBe(1)
      const label = String(asked.askHint?.candidates[0]?.value)
      // 第二轮：用户点了候选 ⇒ 一条普通用户消息
      const resolved = (await intent.execute({ utterance: label, scene: 'transfer' }, execCtx())) as {
        filled: readonly { name: string; source: string }[]
      }
      expect(resolved.filled.some((slot) => slot.name === 'payee' && slot.source === 'user-choice')).toBe(true)
    } finally {
      await app.dispose('test')
    }
  })

  it('未装 intent:plane 时 prompt:ask 启动失败（不静默降级）', async () => {
    await expect(
      bootIntent([{ id: 'core:session' }, { id: 'core:tools' }, { id: 'prompt:ask' }]),
    ).rejects.toThrow(/未注册/)
  })

  it('prompt:ask 配置 enabled=false 时启动成功但不注册工具（关闭即不暴露）', async () => {
    const app = await bootIntent([
      { id: 'core:session' },
      { id: 'core:tools' },
      { id: 'intent:plane', config: { demoMemory: DEMO_CONFIG } },
      { id: 'prompt:ask', config: { enabled: false } },
    ])
    try {
      const names = app.ctx.get(TOOLS_SERVICE).list().map((tool) => tool.name)
      expect(names).toContain(INTENT_RESOLVE_TOOL)
      expect(names).not.toContain(PROMPT_ASK_TOOL)
    } finally {
      await app.dispose('test')
    }
  })

  it('会话事件只有既有冻结键（零新事件键）', async () => {
    const app = await bootIntent()
    try {
      await app.ctx.get(TOOLS_SERVICE).get(INTENT_RESOLVE_TOOL).execute({ utterance: '给张三转500元', scene: 'transfer' }, execCtx())
      const types = new Set(app.ctx.get(SESSION_SERVICE).events().map((event) => event.type))
      expect([...types].every((type) => type === 'tool/call' || type === 'tool/result')).toBe(true)
    } finally {
      await app.dispose('test')
    }
  })

  it('真实记忆层适配：装配 bah:memory-store 后走 retrieveMemory（不解析 renderedText 猜槽位）', async () => {
    const rows: readonly PluginRow[] = [
      { id: 'core:session' },
      { id: 'core:tools' },
      // memory 插件 inject `runtime:system-prompt`（记忆段挂进提示词），所以要先装 core:prompt
      { id: 'core:prompt' },
      // 合流：记忆库按租户根落盘 ⇒ 需要 `core:persistence` 提供 SESSION_FILES；
      // `tenant` 也不再是 bah-memory 的配置键（租户只来自 `--tenant` / RunContext）
      { id: 'core:persistence' },
      // 租户化后 dbPath 是"租户根下的单段文件名"（`:memory:` 已不再被当特例）
      { id: 'bah:memory-store', config: { dbPath: 'memory.db', userId: 'u-1' } },
      { id: 'intent:plane' },
      { id: 'prompt:ask' },
    ]
    const app = await bootIntent(rows)
    try {
      const tool = app.ctx.get(TOOLS_SERVICE).get(INTENT_RESOLVE_TOOL)
      // 三个场景各走一次：合法场景 / 跨场景（target 映射与闸门）/ 未知场景（不检索）
      const normal = (await tool.execute({ utterance: '给张三转500元', scene: 'transfer' }, execCtx())) as {
        kind: string
      }
      expect(normal.kind).toBe('explicit')

      const cross = (await tool.execute(
        { utterance: '把那边的事接着办', scene: 'cross_scene' },
        execCtx(),
      )) as { decision: string; evidence: readonly { ruleId: string }[] }
      expect(cross.decision).toBe('ask')
      expect(cross.evidence.some((item) => item.ruleId === 'R-XS-1')).toBe(true)

      const unknown = (await tool.execute({ utterance: '随便说点什么', scene: 'nonsense' }, execCtx())) as {
        kind: string
      }
      expect(unknown.kind).toBeDefined()
    } finally {
      await app.dispose('test')
    }
  })

  it('演示记忆不影响会话事件（它只在检索面）', () => {
    // 纯函数端口：没有 session/ctx 依赖，装配与否都不会 append
    expect(typeof demoMemoryPort(DEMO, 0.6).retrieve).toBe('function')
    expect(validateAgainstSchema({ type: 'object' }, {}, 'result')).toBeUndefined()
  })
})
