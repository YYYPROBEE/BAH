/**
 * `safety:verify` 宿主插件：装配、出站文本、事件与顺序（W05 TC-07~10）。
 *
 * 纯函数判定在 `@bah/safety` 的 `verify.test.ts`；这里只证明"钩子通电且改写
 * 真的到达 channels"——不是只断言事件落了。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebProjector } from '@bah/channels'
import { SESSION_EVENT_TYPES } from '@bah/runtime'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import { asSessionId, captureRejection } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { boot, type BootOptions, type BootedApp, type ProfileSummary } from '../boot.ts'
import { createCatalog } from './index.ts'

import type { AnySessionEvent } from '@bah/runtime'
import type { Bundle, PluginRow } from '../profile-plugins.ts'
import { testRunContext } from '../test-run-context.ts'

const PROFILE: ProfileSummary = { name: 'fx', bundles: ['fx'], hmr: false }

function rows(options: {
  readonly verify?: 'on' | 'off' | 'disabled'
  readonly text?: string
  readonly script?: readonly Readonly<Record<string, unknown>>[]
  readonly bank?: boolean
} = {}): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    {
      id: 'core:model',
      config: {
        provider: 'mock',
        script: options.script ?? [{ text: options.text ?? '你好' }],
      },
    },
    { id: 'core:agent', config: { loop: { model: 'mock:mock-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
    ...(options.bank === true
      ? [{ id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' } }]
      : []),
    ...(options.verify === 'on' || options.verify === 'disabled'
      ? [
          {
            id: 'safety:verify',
            config: options.verify === 'disabled' ? { enabled: false } : {},
          },
        ]
      : []),
  ]
}

async function bootWith(
  pluginRows: readonly PluginRow[],
  sessionId: string,
): Promise<{ readonly app: BootedApp; readonly dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'bah-verify-'))
  const bundle: Bundle = { name: 'fx', rows: pluginRows }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({ sessionId: asSessionId(sessionId), now: () => 1_000, jsonlDir: dir }),
  }
  return { app: await boot(options), dir }
}

function assistantTexts(events: readonly AnySessionEvent[]): string[] {
  return events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => {
      const blocks = (event as { data: { content: readonly { type: string; text?: string }[] } }).data
        .content
      return blocks.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('')
    })
}

function assertionEvents(events: readonly AnySessionEvent[]): readonly Record<string, unknown>[] {
  return events
    .filter((event) => event.type === 'safety/assertion')
    .map((event) => event.data as unknown as Record<string, unknown>)
}

describe('safety:verify · 装配与出站文本', () => {
  it('TC-W05-07 插件未装配 / enabled=false 时行为与今日完全一致（零影响）', async () => {
    for (const mode of ['off', 'disabled'] as const) {
      const { app, dir } = await bootWith(rows({ verify: mode, text: '你的余额 5000 元。' }), `s-${mode}`)
      try {
        const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
        if (agent === undefined) throw new Error('没有活体 agent')
        agent.send('查余额')
        await agent.run()

        const events = app.ctx.get(SESSION_SERVICE).events()
        expect(assistantTexts(events)).toEqual(['你的余额 5000 元。'])
        expect(assertionEvents(events)).toHaveLength(0)
      } finally {
        await app.dispose('test')
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('TC-W05-08 agent/reply 有真实发射点，载荷带本 turn 文本与工具结果；事件已声明', async () => {
    expect(SESSION_EVENT_TYPES).toContain('safety/assertion')
    const { app, dir } = await bootWith(rows({ text: '你好' }), 's-hook')
    try {
      const seen: string[] = []
      app.ctx.events.on('agent/reply', async (input, next) => {
        seen.push(`${input.text}|${String(input.toolResults.length)}|${String(input.hasToolCalls)}`)
        return next(input)
      })
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
      if (agent === undefined) throw new Error('没有活体 agent')
      agent.send('你好')
      await agent.run()
      expect(seen).toEqual(['你好|0|false'])
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TC-W05-09 needs-evidence 的改写文本到达 channels（不是只落事件）', async () => {
    const { app, dir } = await bootWith(rows({ verify: 'on', text: '你的余额 5000 元。' }), 's-rewrite')
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
      if (agent === undefined) throw new Error('没有活体 agent')
      agent.send('查余额')
      await agent.run()

      const events = app.ctx.get(SESSION_SERVICE).events()
      const logged = assistantTexts(events)
      expect(logged).toHaveLength(1)
      expect(logged[0]?.startsWith('【未核实】')).toBe(true)

      const projector = new WebProjector()
      const frames = events.flatMap((event) => projector.apply(event))
      const assistantFrames = frames.filter(
        (frame) => frame.kind === 'message' && frame.role === 'assistant',
      )
      const last = assistantFrames.at(-1)
      if (last === undefined || last.kind !== 'message') throw new Error('没有 assistant 消息帧')
      const sent = last.blocks
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
      expect(sent).toBe(logged[0])
      expect(sent).toContain('【未核实】')

      const recorded = assertionEvents(events)
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({ total: 1, verified: 0, needsEvidence: 1, rejected: 0 })
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TC-W05-10 内层监听器不调 next() 时，核验门仍拿到它返回的文本', async () => {
    const { app, dir } = await bootWith(rows({ verify: 'on', text: '你好' }), 's-order')
    try {
      // 注册在 verify 之后 = 链的更内层；不调 next() 直接返回（"我拥有这个判决"）
      app.ctx.events.on('agent/reply', async (input) => ({
        ...input,
        text: '余额 5000 元（第三方改写）',
      }))

      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
      if (agent === undefined) throw new Error('没有活体 agent')
      agent.send('查余额')
      await agent.run()

      const events = app.ctx.get(SESSION_SERVICE).events()
      const text = assistantTexts(events)[0] ?? ''
      expect(text).toContain('第三方改写')
      expect(text.startsWith('【未核实】')).toBe(true)
      expect(assertionEvents(events)[0]).toMatchObject({ total: 1, needsEvidence: 1 })
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('端到端：工具出参真的进入核验证据（余额一致 → 通过；数字篡改 → 未核实）', async () => {
    const script = [
      { tool: { id: 'call-balance', name: 'account_balance', args: {} } },
      { text: '账户尾号 1234：余额 ¥12,345.67。' },
    ]
    const honest = await bootWith(rows({ verify: 'on', bank: true, script }), 's-evidence-ok')
    try {
      const agent = honest.app.ctx.get(AGENTS_SERVICE).list()[0]
      if (agent === undefined) throw new Error('没有活体 agent')
      agent.send('查余额')
      await agent.run()
      const events = honest.app.ctx.get(SESSION_SERVICE).events()
      expect(assistantTexts(events).at(-1)).toBe('账户尾号 1234：余额 ¥12,345.67。')
      expect(assertionEvents(events).at(-1)).toMatchObject({ total: 2, verified: 2, needsEvidence: 0 })
    } finally {
      await honest.app.dispose('test')
      rmSync(honest.dir, { recursive: true, force: true })
    }

    const lying = await bootWith(
      rows({
        verify: 'on',
        bank: true,
        script: [
          { tool: { id: 'call-balance', name: 'account_balance', args: {} } },
          { text: '账户尾号 1234：余额 ¥9,999.00。' },
        ],
      }),
      's-evidence-bad',
    )
    try {
      const agent = lying.app.ctx.get(AGENTS_SERVICE).list()[0]
      if (agent === undefined) throw new Error('没有活体 agent')
      agent.send('查余额')
      await agent.run()
      const events = lying.app.ctx.get(SESSION_SERVICE).events()
      const text = assistantTexts(events).at(-1) ?? ''
      expect(text.startsWith('【未核实】')).toBe(true)
      expect(assertionEvents(events).at(-1)).toMatchObject({ verified: 1, needsEvidence: 1 })
    } finally {
      await lying.app.dispose('test')
      rmSync(lying.dir, { recursive: true, force: true })
    }
  })

  it('钩子抛错时 fail-closed：落拒答文本 + assistant/attempt 留痕', async () => {
    const { app, dir } = await bootWith(rows({ verify: 'on', text: '你好' }), 's-throw')
    try {
      app.ctx.events.on('agent/reply', async () => {
        throw new Error('probe: inner listener exploded')
      })
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
      if (agent === undefined) throw new Error('没有活体 agent')
      agent.send('你好')
      await agent.run()

      const events = app.ctx.get(SESSION_SERVICE).events()
      const text = assistantTexts(events)[0] ?? ''
      expect(text).toContain('reply-hook-failed')
      expect(
        events.some(
          (event) =>
            event.type === 'assistant/attempt' && event.data.reason?.includes('inner listener exploded'),
        ),
      ).toBe(true)
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('配置：未知键 fail-loud；enabled 默认 true', async () => {
    const rowsWith = (config: Readonly<Record<string, unknown>>): readonly PluginRow[] =>
      rows({ verify: 'on' }).map((row) => (row.id === 'safety:verify' ? { ...row, config } : row))

    const unknown = await captureRejection(() =>
      boot({
        profile: PROFILE,
        bundles: [{ name: 'fx', rows: rowsWith({ nope: 1 }) }],
        layers: [],
        catalog: createCatalog(),
        run: testRunContext({ sessionId: asSessionId('s-config'), now: () => 1_000 }),
      } satisfies BootOptions),
    )
    expect(unknown.code).toBe('unknown-config-key')

    const bad = await captureRejection(() =>
      boot({
        profile: PROFILE,
        bundles: [{ name: 'fx', rows: rowsWith({ enabled: 'yes' }) }],
        layers: [],
        catalog: createCatalog(),
        run: testRunContext({ sessionId: asSessionId('s-config-2'), now: () => 1_000 }),
      } satisfies BootOptions),
    )
    expect(bad.code).toBe('invalid-config')
  })
})
