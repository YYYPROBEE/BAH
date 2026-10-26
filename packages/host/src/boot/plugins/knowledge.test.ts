/**
 * `bank:knowledge` 宿主插件：配置校验 + fixture 端到端 + 失败策略。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asSessionId } from '@bah/test-support'
import {
  AGENTS_SERVICE,
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_SERVICE,
  TOOLS_SERVICE,
} from '@bah/runtime'
import { describe, expect, it } from 'vitest'

import { boot, type BootOptions, type ProfileSummary } from '../boot.ts'
import { createCatalog } from '../index.ts'
import { parseKnowledgeSettings } from './knowledge.ts'

import type { Bundle, PluginRow } from '../profile-plugins.ts'

const PROFILE: ProfileSummary = { name: 'fx', bundles: ['fx'], hmr: false }
const FIXTURE = 'packages/knowledge/fixtures/headless.json'

const CLAIMS = {
  default: { role: 'retail', audience: 'standard', region: 'CN-SH' },
  users: { 'u-1': { role: 'retail', audience: 'standard', region: 'CN-SH' } },
}

function rows(overrides: {
  readonly knowledge?: Readonly<Record<string, unknown>>
  readonly model?: Readonly<Record<string, unknown>>
  readonly withIdentity?: boolean
} = {}): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    {
      id: 'core:model',
      config:
        overrides.model ??
        {
          provider: 'mock',
          script: [
            {
              tool: {
                id: 'k-1',
                name: 'knowledge_answer',
                args: { question: '稳盈90天持有不满7天赎回费率是多少？' },
              },
            },
            { text: '以上为知识库校验后的回答。' },
          ],
        },
    },
    { id: 'core:agent', config: { loop: { model: 'mock:mock-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
    {
      id: 'bank:tools',
      config: {
        seed: 7,
        datasetTier: 'demo',
        ...(overrides.withIdentity === false ? {} : { demoUserId: 'u-1' }),
      },
    },
    {
      id: 'bank:knowledge',
      use: 'bank:knowledge',
      config: overrides.knowledge ?? {
        mode: 'fixture',
        fixturePath: FIXTURE,
        channel: 'headless',
        claims: CLAIMS,
      },
    },
  ]
}

let bootSequence = 0

async function bootWith(pluginRows: readonly PluginRow[]): Promise<Awaited<ReturnType<typeof boot>>> {
  const bundle: Bundle = { name: 'fx', rows: pluginRows }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [],
    catalog: createCatalog(),
    run: {
      sessionId: asSessionId(`s-knowledge-${bootSequence}`),
      now: () => 1_000,
      jsonlDir: mkdtempSync(join(tmpdir(), 'bah-knowledge-')),
    },
  }
  bootSequence += 1
  return boot(options)
}

function rawEvents(events: readonly { type: string; data: unknown }[]): readonly { type: string; data: unknown }[] {
  return events
}

describe('bank:knowledge 配置校验', () => {
  it('补默认值并解析 claims / timeouts', () => {
    const settings = parseKnowledgeSettings({
      mode: 'fixture',
      fixturePath: FIXTURE,
      claims: CLAIMS,
      timeouts: { answer: 9000 },
    })
    expect(settings.baseUrl).toBe('http://127.0.0.1:7801')
    expect(settings.tokenEnv).toBe('BAH_KNOWLEDGE_TOKEN')
    expect(settings.required).toBe(false)
    expect(settings.channel).toBe('headless')
    expect(settings.timeouts).toEqual({ answer: 9000, query: 1500, health: 1000 })
    expect(settings.claims.users['u-1']?.role).toBe('retail')
  })

  it('拒绝未知键 / 非法 mode / fixture 缺路径', () => {
    expect(() => parseKnowledgeSettings({ unknown: true })).toThrow(/未知配置键/)
    expect(() => parseKnowledgeSettings({ mode: 'grpc' })).toThrow(/只能是 http \/ fixture/)
    expect(() => parseKnowledgeSettings({ mode: 'fixture' })).toThrow(/fixturePath/)
    expect(() => parseKnowledgeSettings({ claims: { default: { role: 'x' } } })).toThrow(
      /audience/,
    )
    expect(() =>
      parseKnowledgeSettings({ claims: { users: { u1: undefined } } }),
    ).toThrow(/必填/)
    expect(() => parseKnowledgeSettings({ timeouts: { answer: 0 } })).toThrow(/正整数/)
  })

  it('W06 签名配置：默认启用 + 默认路径；未知键拒绝', () => {
    const settings = parseKnowledgeSettings({})
    expect(settings.signature).toEqual({
      enabled: true,
      manifestPath: 'packages/knowledge/fixtures/knowledge.manifest.json',
      corpusPath: 'packages/knowledge/fixtures/corpus.json',
    })
    expect(() => parseKnowledgeSettings({ signature: { nope: 1 } })).toThrow(/未知配置键/)
    expect(() => parseKnowledgeSettings({ signature: { enabled: 'yes' } })).toThrow(/布尔/)
  })
})

describe('bank:knowledge 端到端（fixture）', () => {
  it('注册知识工具、返回已校验答案、落 knowledge/answered 事件', async () => {
    const app = await bootWith(rows())
    try {
      expect(app.ctx.get(TOOLS_SERVICE).has('knowledge_answer')).toBe(true)
      expect(app.ctx.get(TOOLS_SERVICE).has('knowledge_query')).toBe(true)

      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('稳盈90天赎回费率')
      await agent.run()

      const events = rawEvents(app.ctx.get(SESSION_SERVICE).events())
      const answered = events.find((event) => event.type === 'knowledge/answered')
      expect(answered?.data).toMatchObject({ kind: 'answer', verdict: 'GREEN' })

      const result = events.find(
        (event) =>
          event.type === 'tool/result' &&
          (event.data as { name?: string }).name === 'knowledge_answer',
      )
      expect(JSON.stringify(result?.data)).toContain('1.50')

      // 领域事件不在 runtime 的公开平台表里，但必须可被 reader 跳过
      expect(KNOWN_SESSION_EVENT_TYPES.has('knowledge/answered')).toBe(false)
    } finally {
      // boot 失败的清理在 boot 内部完成；这里只保留断言
    }
  })

  it('未绑定身份时工具返回结构化错误，而不是隐式放行', async () => {
    const app = await bootWith(rows({ withIdentity: false }))
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('稳盈90天赎回费率')
      await agent.run()
      const events = rawEvents(app.ctx.get(SESSION_SERVICE).events())
      const result = events.find(
        (event) =>
          event.type === 'tool/result' &&
          (event.data as { name?: string }).name === 'knowledge_answer',
      ) as { data: { isError?: boolean; code?: string } } | undefined
      expect(result?.data.isError).toBe(true)
    } finally {
      // boot 失败时也要清理；这里只保证不抛
    }
  })

  it('用户不在 claims.users 时回落到 default claims', async () => {
    const app = await bootWith(
      rows({
        knowledge: {
          mode: 'fixture',
          fixturePath: FIXTURE,
          claims: { default: CLAIMS.default, users: {} },
        },
      }),
    )
    const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
    agent.send('稳盈90天赎回费率')
    await agent.run()
    const events = rawEvents(app.ctx.get(SESSION_SERVICE).events())
    expect(events.find((event) => event.type === 'knowledge/answered')).toBeDefined()
  })

  it('knowledge_query 落 knowledge/queried 事件', async () => {
    const app = await bootWith(
      rows({
        model: {
          provider: 'mock',
          script: [
            {
              tool: {
                id: 'q-1',
                name: 'knowledge_query',
                args: { question: '稳盈90天赎回费率' },
              },
            },
            { text: '完成' },
          ],
        },
      }),
    )
    const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
    agent.send('稳盈90天赎回费率')
    await agent.run()
    const events = rawEvents(app.ctx.get(SESSION_SERVICE).events())
    expect(events.find((event) => event.type === 'knowledge/queried')).toBeDefined()
  })
})

describe('bank:knowledge 失败策略', () => {  it('required=true 且 sidecar 不可达时拒绝启动', async () => {
    const promise = bootWith(
      rows({
        knowledge: {
          mode: 'http',
          baseUrl: 'http://127.0.0.1:1',
          required: true,
          claims: CLAIMS,
        },
      }),
    )
    await expect(promise).rejects.toThrow(/健康检查失败/)
  })

  it('required=false 且 sidecar 不可达时仍能启动（带 token）', async () => {
    process.env.TEST_KNOWLEDGE_TOKEN = 'secret'
    try {
      const app = await bootWith(
        rows({
          knowledge: {
            mode: 'http',
            baseUrl: 'http://127.0.0.1:1',
            tokenEnv: 'TEST_KNOWLEDGE_TOKEN',
            required: false,
            claims: CLAIMS,
          },
        }),
      )
      expect(app.ctx.get(TOOLS_SERVICE).has('knowledge_answer')).toBe(true)
    } finally {
      delete process.env.TEST_KNOWLEDGE_TOKEN
    }
  })

  it('fixture 文件读取失败时拒绝启动', async () => {
    await expect(
      bootWith(
        rows({
          knowledge: { mode: 'fixture', fixturePath: 'no/such.json', claims: CLAIMS },
        }),
      ),
    ).rejects.toThrow(/fixturePath 读取失败/)
  })
})

describe('W06 · 签名门启动校验', () => {
  it('TC-W06-01 fixture 正常答案逐字不变（签名门是透明装饰）', async () => {
    const app = await bootWith(rows())
    const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
    agent.send('稳盈90天赎回费率')
    await agent.run()
    const events = rawEvents(app.ctx.get(SESSION_SERVICE).events())
    const answered = events.find((event) => event.type === 'knowledge/answered')
    expect(answered?.data).toMatchObject({ kind: 'answer', verdict: 'GREEN', reasonCode: null })
    const result = events.find(
      (event) =>
        event.type === 'tool/result' &&
        (event.data as { name?: string }).name === 'knowledge_answer',
    )
    expect(JSON.stringify(result?.data)).toContain('赎回费率（持有<7天）为1.50%')
  })

  it('清单缺失 → invalid-config（不是静默降级）', async () => {
    await expect(
      bootWith(
        rows({
          knowledge: {
            mode: 'fixture',
            fixturePath: FIXTURE,
            claims: CLAIMS,
            signature: { manifestPath: 'packages/knowledge/fixtures/no-such.json' },
          },
        }),
      ),
    ).rejects.toThrow(/清单不存在/)
  })

  it('密钥缺失 → invalid-config（不许默认密钥）', async () => {
    const before = process.env['BAH_KNOWLEDGE_KEY']
    try {
      delete process.env['BAH_KNOWLEDGE_KEY']
      await expect(bootWith(rows())).rejects.toThrow(/BAH_KNOWLEDGE_KEY/)
    } finally {
      if (before === undefined) delete process.env['BAH_KNOWLEDGE_KEY']
      else process.env['BAH_KNOWLEDGE_KEY'] = before
    }
  })

  it('fixture 文件不在签名清单里 → 启动失败并点名文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-w06-unsign-'))
    const path = join(dir, 'fixture.json')
    try {
      writeFileSync(path, readFileSync(FIXTURE, 'utf8'), 'utf8')
      await expect(
        bootWith(
          rows({
            knowledge: {
              mode: 'fixture',
              fixturePath: path,
              claims: CLAIMS,
            },
          }),
        ),
      ).rejects.toThrow(/签名清单缺少文件条目/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
