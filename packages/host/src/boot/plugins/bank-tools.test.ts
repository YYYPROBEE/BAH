/**
 * `bank:tools` 插件（施工单 08 §0 第 6 条：headless 端到端）。
 *
 * 两条链路：
 * 1. 真实 `HOST_PLUGINS` + 自定义行启动，mock 模型调 `account_balance` → 绿级放行 → 卡片数据落账；
 * 2. 不写 `demoUserId` → 未绑定身份，业务工具 deny `no-identity`（施工单 09 §4）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asSessionId, captureThrown } from '@bah/test-support'
import { AGENTS_SERVICE, SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import { SessionIdentityStore, restoreSessionIdentity } from '@bah/bank'
import { CREDENTIALS } from '@bah/persistence'
import { describe, expect, it } from 'vitest'

import { boot, type BootOptions } from '../boot.ts'
import { createCatalog } from './index.ts'
import { DEFAULT_BANK_TOOLS, bankToolsPlugin, type BankToolsSettings } from './bank-tools.ts'
import { SESSION_FILES } from './persistence.ts'
import type { AnySessionEvent } from '@bah/runtime'
import type { PluginRow } from '../profile-plugins.ts'

/** 造一组 base 行（bank:tools 的配置可替换）。 */
function rows(bank: Readonly<Record<string, unknown>>): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    {
      id: 'core:model',
      config: {
        provider: 'mock',
        model: 'mock-chat',
        script: [
          { tool: { id: 'call-1', name: 'account_balance', args: {} } },
          { text: '已为你在模拟环境查询账户余额。' },
        ],
      },
    },
    { id: 'core:agent', config: { channel: 'headless', loop: { model: 'mock:mock-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
    { id: 'bank:tools', config: bank },
  ]
}

/** 启动一个应用（真实依赖清单）。 */
async function bootWith(
  bank: Readonly<Record<string, unknown>>,
  sessionId: string,
  jsonlDir?: string,
  extraRows: readonly PluginRow[] = [],
): Promise<Awaited<ReturnType<typeof boot>>> {
  const options: BootOptions = {
    profile: { name: 'fx', bundles: ['fx'], hmr: false },
    bundles: [{ name: 'fx', rows: [...rows(bank), ...extraRows] }],
    layers: [],
    catalog: createCatalog(),
    run: {
      sessionId: asSessionId(sessionId),
      now: () => 1_792_000_000_000,
      ...(jsonlDir === undefined ? {} : { jsonlDir }),
    },
  }
  return boot(options)
}

/** 取某类会话事件载荷。 */
function payloads(events: readonly AnySessionEvent[], type: string): Record<string, unknown>[] {  return events
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>)
}

describe('bank:tools 配置（fail-loud）', () => {
  it('默认值：不写身份 = 未绑定；其余字段有默认', () => {
    const settings = bankToolsPlugin.validate({})
    expect(settings).toEqual(DEFAULT_BANK_TOOLS)
    expect(settings.demoUserId).toBeUndefined()
  })

  it('日限额默认值是赛题口径 1000 元（黄色 ≤1000、红色 >1000）', () => {
    const settings = bankToolsPlugin.validate({})
    // 写成断言而不是注释：这个数同时决定判决与预览展示，被误改会让两处一起漂
    expect(settings.dailyTransferLimit).toBe(1_000)
  })

  it('显式 demoUserId 与嵌套 verify 覆盖', () => {
    const settings = bankToolsPlugin.validate({
      demoUserId: ' u-1 ',
      seed: 9,
      datasetTier: 'adversarial',
      verify: { successAfter: 2, maxAttempts: 4, lockMinutes: 10 },
    }) as BankToolsSettings
    expect(settings.demoUserId).toBe('u-1')
    expect(settings.seed).toBe(9)
    expect(settings.datasetTier).toBe('adversarial')
    expect(settings.verify).toEqual({ successAfter: 2, maxAttempts: 4, lockMinutes: 10 })
  })

  it('09 新增阈值：日限额 / 风险名单 / 风险次数都可被配置覆盖', () => {
    const settings = bankToolsPlugin.validate({
      dailyTransferLimit: 1_000,
      riskyOps: ['transfer_create'],
      riskyCallThreshold: 2,
    }) as BankToolsSettings
    expect(settings.dailyTransferLimit).toBe(1_000)
    expect(settings.riskyOps).toEqual(['transfer_create'])
    expect(settings.riskyCallThreshold).toBe(2)
  })

  it('未知键 / 非法类型 / 非法枚举全部拒绝', () => {
    const cases: readonly [string, Readonly<Record<string, unknown>>, string][] = [
      ['顶层未知键', { nope: 1 }, 'unknown-config-key'],
      ['verify 未知键', { verify: { nope: 1 } }, 'unknown-config-key'],
      ['seed 非正整数', { seed: 0 }, 'invalid-config'],
      ['档位非法', { datasetTier: 'ghost' }, 'invalid-config'],
      ['挑战渠道非法', { redChallenge: 'password' }, 'invalid-config'],
      ['disclaimerId 空串', { disclaimerId: ' ' }, 'invalid-config'],
      ['verify 嵌套非对象', { verify: 1 }, 'invalid-config'],
      ['日限额非正整数', { dailyTransferLimit: 0 }, 'invalid-config'],
      ['风险名单含未知工具', { riskyOps: ['transfer_creat'] }, 'invalid-config'],
      ['风险次数非正整数', { riskyCallThreshold: 0 }, 'invalid-config'],
    ]
    for (const [name, config, code] of cases) {
      const error = captureThrown(() => bankToolsPlugin.validate(config))
      expect(`${name}: ${error.code}`).toBe(`${name}: ${code}`)
    }
  })
})

describe('headless 端到端（施工单 08 §0 第 6 条）', () => {
  it('analysis_calc 经 compute seam 求值（未装 sandbox 行时回退进程内）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bank-calc-'))
    const app = await bootWith({ demoUserId: 'u-1', seed: 7, datasetTier: 'demo' }, 's-bank-calc', dir)
    try {
      const definition = app.ctx.get(TOOLS_SERVICE).get('analysis_calc')
      const result = await definition.execute(
        { code: '1 + 2 * 3' },
        {
          sessionId: asSessionId('s-bank-calc'),
          callId: 'c-calc',
          signal: new AbortController().signal,
        },
      )
      expect(result).toMatchObject({ value: 7 })
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('analysis_calc 在 safety:sandbox 在场时经 worker 执行并落 sandbox 审计', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bank-sandbox-'))
    const app = await bootWith(
      { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' },
      's-bank-sandbox',
      dir,
      [{ id: 'safety:sandbox', config: {} }],
    )
    try {
      const definition = app.ctx.get(TOOLS_SERVICE).get('analysis_calc')
      const result = await definition.execute(
        { code: '1 + 2 * 3' },
        {
          sessionId: asSessionId('s-bank-sandbox'),
          callId: 'c-calc-sandbox',
          signal: new AbortController().signal,
        },
      )
      expect(result).toMatchObject({ value: 7 })
      const events = app.ctx.get(SESSION_SERVICE).events()
      expect(events.some((event) => String(event.type) === 'sandbox/done')).toBe(true)
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('mock 模型调 account_balance → 绿级放行 → 卡片数据落账', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bank-tools-'))
    const app = await bootWith({ demoUserId: 'u-1', seed: 7, datasetTier: 'demo' }, 's-bank-e2e', dir)
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('查一下余额')
      await agent.run()

      const events = app.ctx.get(SESSION_SERVICE).events()
      const types = events.map((event) => event.type)
      expect(types).toContain('tool/call')
      expect(types).toContain('read/balance')
      expect(types).toContain('tool/result')
      expect(types).toContain('identity/bound')
      expect(types).not.toContain('approval/asked')
      expect(payloads(events, 'identity/bound')[0]).toMatchObject({
        userId: 'u-1',
        method: 'demo-config',
      })

      expect(payloads(events, 'tool/call')[0]).toMatchObject({
        name: 'account_balance',
        tier: { level: 'green' },
      })
      const read = payloads(events, 'read/balance')[0] as { result: Record<string, unknown> }
      expect(read.result).toMatchObject({ accountId: 'a-1', balanceCents: 1_234_567 })

      const result = payloads(events, 'tool/result')[0] as {
        isError: boolean
        content: { text?: string }[]
      }
      expect(result.isError).toBe(false)
      expect(result.content.some((block) => block.text?.includes('¥12,345.67'))).toBe(true)

      // 卡片从事件数据派生（施工单 08 §4）
      const tool = app.ctx.get(TOOLS_SERVICE).get('account_balance')
      const card = tool.presentResult?.({}, read.result as never) as { kind?: string } | undefined
      expect(card?.kind).toBe('bank.balance')

      const turnEnd = payloads(events, 'turn/end')[0] as { reason: { kind: string } }
      expect(turnEnd.reason.kind).toBe('completed')
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('T-IDN-001 14 个工具全部注册；不写 demoUserId 时业务工具 deny no-identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bank-noid-'))
    const app = await bootWith({}, 's-bank-noid', dir)
    try {
      const registry = app.ctx.get(TOOLS_SERVICE)
      expect(registry.list()).toHaveLength(14)
      expect(registry.has('account_balance')).toBe(true)
      expect(registry.has('transfer_create')).toBe(true)
      expect(registry.has('verify_face')).toBe(true)

      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('查一下余额')
      await agent.run()

      const result = payloads(app.ctx.get(SESSION_SERVICE).events(), 'tool/result')[0] as {
        isError: boolean
        code?: string
      }
      expect(result.isError).toBe(true)
      expect(result.code).toBe('no-identity')
      expect(
        app.ctx
          .get(SESSION_SERVICE)
          .events()
          .some((event) => String(event.type) === 'identity/bound'),
      ).toBe(false)
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('T-IDN-002 短信登录后绑定：业务工具放行，identity/bound 记 mock-login', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bank-login-'))
    const sessionId = 's-bank-login'
    const app = await bootWith({}, sessionId, dir)
    try {
      const credentials = app.ctx.get(CREDENTIALS)
      const requested = credentials.requestSmsLogin('13800001111')
      if (!requested.ok) throw new Error(`演示用户手机号应可登录：${requested.code}`)
      const done = credentials.completeSmsLogin(
        asSessionId(sessionId),
        requested.challenge.loginId,
        requested.challenge.code,
      )
      expect(done).toEqual({ ok: true, userId: 'u-1' })

      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('查一下余额')
      await agent.run()

      const events = app.ctx.get(SESSION_SERVICE).events()
      const result = payloads(events, 'tool/result')[0] as { isError: boolean }
      expect(result.isError).toBe(false)
      expect(payloads(events, 'identity/bound')[0]).toMatchObject({
        userId: 'u-1',
        method: 'mock-login',
      })
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('T-IDN-003 identity/bound 是 durable 事实：落盘可查、回放可恢复', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bank-replay-'))
    const sessionId = asSessionId('s-bank-replay')
    const app = await bootWith({}, String(sessionId), dir)
    try {
      const credentials = app.ctx.get(CREDENTIALS)
      const requested = credentials.requestSmsLogin('13800001111')
      if (!requested.ok) throw new Error('演示用户手机号应可登录')
      credentials.completeSmsLogin(
        sessionId,
        requested.challenge.loginId,
        requested.challenge.code,
      )

      const events = app.ctx.get(SESSION_SERVICE).events()
      const bound = events.filter((event) => String(event.type) === 'identity/bound')
      expect(bound).toHaveLength(1)

      // durable：JSONL 里真的有一行 identity/bound
      const file = app.ctx.get(SESSION_FILES).fileOf(sessionId)
      expect(readFileSync(file, 'utf8')).toContain('identity/bound')
      expect(readFileSync(file, 'utf8')).toContain('mock-login')

      // 回放：用同一批事件重建身份（施工单 12 的快照回放走同一条路径）
      const restored = new SessionIdentityStore()
      restoreSessionIdentity(restored, sessionId, events)
      expect(restored.resolve(sessionId)).toBe('u-1')
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('身份绑定只能作用于当前会话（一个 host 进程一个会话，别写进别人的日志）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bank-guard-'))
    const app = await bootWith({}, 's-bank-guard', dir)
    try {
      const credentials = app.ctx.get(CREDENTIALS)
      const error = captureThrown(() => credentials.bindSession(asSessionId('s-other'), 'u-1'))
      expect(error.code).toBe('identity-session-mismatch')
      expect(
        app.ctx
          .get(SESSION_SERVICE)
          .events()
          .some((event) => String(event.type) === 'identity/bound'),
      ).toBe(false)
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
