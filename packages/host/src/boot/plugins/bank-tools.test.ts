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
import { AGENTS_SERVICE, SESSION_SERVICE, TOOLS_SERVICE, TOOL_CONTRACTS } from '@bah/runtime'
import {
  BANK_CHALLENGE,
  BANK_RESULT_SCHEMAS,
  SessionIdentityStore,
  restoreSessionIdentity,
  specOf,
} from '@bah/bank'
import { CREDENTIALS } from '@bah/persistence'
import { describe, expect, it } from 'vitest'

import { boot, type BootOptions } from '../boot.ts'
import { createCatalog } from './index.ts'
import { DEFAULT_BANK_TOOLS, bankToolsPlugin, type BankToolsSettings } from './bank-tools.ts'
import { SESSION_FILES } from './persistence.ts'
import type { AnySessionEvent } from '@bah/runtime'
import type { PluginRow } from '../profile-plugins.ts'

/** 造一组 base 行（bank:tools 的配置可替换）。 */
function rows(
  bank: Readonly<Record<string, unknown>>,
  script: readonly Readonly<Record<string, unknown>>[],
): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    {
      id: 'core:model',
      config: {
        provider: 'mock',
        model: 'mock-chat',
        script,
      },
    },
    { id: 'core:agent', config: { channel: 'headless', loop: { model: 'mock:mock-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
    { id: 'bank:tools', config: bank },
  ]
}

/** 缺省脚本：查一次余额再收尾。 */
const DEFAULT_SCRIPT = [
  { tool: { id: 'call-1', name: 'account_balance', args: {} } },
  { text: '已为你在模拟环境查询账户余额。' },
] as const

/** 启动一个应用（真实依赖清单）。 */
async function bootWith(
  bank: Readonly<Record<string, unknown>>,
  sessionId: string,
  jsonlDir?: string,
  extraRows: readonly PluginRow[] = [],
  script: readonly Readonly<Record<string, unknown>>[] = DEFAULT_SCRIPT,
): Promise<Awaited<ReturnType<typeof boot>>> {
  const options: BootOptions = {
    profile: { name: 'fx', bundles: ['fx'], hmr: false },
    bundles: [{ name: 'fx', rows: [...rows(bank, script), ...extraRows] }],
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
    expect(settings.verify).toEqual({
      provider: 'gateway',
      successAfter: 2,
      maxAttempts: 4,
      lockMinutes: 10,
    })
  })

  it('W09 verify.provider：默认网关适配器，mock 是回滚开关，非法值 fail-loud', () => {
    expect(bankToolsPlugin.validate({}).verify.provider).toBe('gateway')
    expect(
      (bankToolsPlugin.validate({ verify: { provider: 'mock' } }) as BankToolsSettings).verify
        .provider,
    ).toBe('mock')
    expect(
      captureThrown(() => bankToolsPlugin.validate({ verify: { provider: 'real-vendor' } })).code,
    ).toBe('invalid-config')
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

  it('T-IDN-001 16 个工具全部注册；不写 demoUserId 时业务工具 deny no-identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bank-noid-'))
    const app = await bootWith({}, 's-bank-noid', dir)
    try {
      const registry = app.ctx.get(TOOLS_SERVICE)
      expect(registry.list()).toHaveLength(16)
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

/**
 * 契约注册表通电（W03 · G-1）。
 *
 * 这些用例只验一件事：**宿主真的把契约提供进去了**。
 * 没有它们，`packages/runtime/src/tools/contracts.ts` 的"缺省不校验"会让整条校验静默失效
 * ——测试全绿、生产零校验，这是本仓历史上最贵的一种假绿。
 */
describe('强验证 provider 回滚开关（W09 §5）', () => {
  it('verify.provider=mock：真的装配确定性 mock（第 successAfter 次才过），不是只改配置值', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bank-verify-'))
    const app = await bootWith(
      { demoUserId: 'u-1', verify: { provider: 'mock', successAfter: 2 } },
      's-bank-verify-mock',
      dir,
    )
    try {
      const challenge = app.ctx.get(BANK_CHALLENGE)
      const issued = challenge.issue('sms')
      if (!issued.ok) throw new Error(`签发失败：${issued.code}`)

      await expect(challenge.verify(issued.challengeId, 'sms')).resolves.toMatchObject({ ok: false })
      await expect(challenge.verify(issued.challengeId, 'sms')).resolves.toEqual({ ok: true })
      expect(challenge.passed(issued.challengeId)).toBe(true)
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('契约注册表（W03 · G-1 通电）', () => {
  it('boot 后可取到契约，且 argsSchema 与 spec.schema 是**同一份对象**（不是抄的第二真相源）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-contract-'))
    const app = await bootWith(
      { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' },
      's-bank-contract',
      dir,
    )
    try {
      const contracts = app.ctx.get(TOOL_CONTRACTS)
      const contract = contracts.get('transfer_create')
      expect(contract).toBeDefined()
      // `toBe`（同一引用）而不是 `toEqual`：抄一份内容相同的新对象也算第二真相源
      expect(contract?.argsSchema).toBe(specOf('transfer_create').schema)
      expect(contract?.validateAt).toBe('pre-execute')
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未登记的工具名返回 undefined（不许拿空契约误拦别人）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-contract-'))
    const app = await bootWith({ demoUserId: 'u-1', seed: 7, datasetTier: 'demo' }, 's-c2', dir)
    try {
      expect(app.ctx.get(TOOL_CONTRACTS).get('no_such_tool')).toBeUndefined()
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('14 个工具的出参契约都来自单表（同一引用），不再有"未登记"的工具', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-contract-'))
    const app = await bootWith({ demoUserId: 'u-1', seed: 7, datasetTier: 'demo' }, 's-c3', dir)
    try {
      const contracts = app.ctx.get(TOOL_CONTRACTS)
      // 出参契约来自单表（`result-schemas.ts`），用同一引用钉住
      expect(contracts.get('transfer_create')?.resultSchema).toBe(
        BANK_RESULT_SCHEMAS.transfer_create,
      )
      expect(contracts.get('account_list')?.resultSchema).toBe(BANK_RESULT_SCHEMAS.account_list)
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * TC-W03-02：`amount` 的五类边界必须**在审批之前**被判非法。
 *
 * 走真实 boot（`bank:tools` 已通电契约），不是单测某个函数：
 * 这里要证明的是"模型传了这些值，端到端只会得到 tool-args-invalid"，
 * 且**不签票据、不进审批、不落转账事件**——错参数绝不能摸到钱。
 */
describe('TC-W03-02 amount 五类边界（端到端）', () => {
  const PAYEE = { name: '王建国', phone: '13900002222' }
  const CASES: readonly (readonly [string, unknown])[] = [
    ['① 字符串 "800"', '800'],
    ['② NaN', Number.NaN],
    ['② Infinity', Number.POSITIVE_INFINITY],
    ['③ 负数', -1],
    ['③ 零', 0],
    ['④ 三位小数 19.999', 19.999],
    ['⑤ 超 MAX_SAFE_INTEGER/100', Number.MAX_SAFE_INTEGER / 100 + 1],
  ]

  for (const [label, amount] of CASES) {
    it(`${label} → tool-args-invalid，不签票据/不进审批`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bah-bad-amount-'))
      const app = await bootWith(
        { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' },
        's-bad-amount',
        dir,
        [],
        [
          { tool: { id: 'c-bad', name: 'transfer_create', args: { amount, payee: PAYEE } } },
          { text: '参数不对，请重新确认。' },
        ],
      )
      try {
        const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
        agent.send('给王建国转 800 元')
        await agent.run()

        const events = app.ctx.get(SESSION_SERVICE).events()
        const types = events.map((event) => String(event.type))
        expect(types).toContain('tool/call')
        expect(types).not.toContain('approval/asked')
        expect(types).not.toContain('ticket/issued')
        expect(types).not.toContain('transfer/created')

        const result = payloads(events, 'tool/result')[0] as { isError?: boolean; code?: string }
        expect(result.isError).toBe(true)
        expect(result.code).toBe('tool-args-invalid')
      } finally {
        await app.dispose('test')
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  /** 正控：两位小数与最小分位必须放行，否则"收紧"就变成了"误杀"。 */
  for (const amount of [0.01, 19.99]) {
    it(`正控：transfer_preview amount=${String(amount)} 不被误拦`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bah-good-amount-'))
      const app = await bootWith(
        { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' },
        's-good-amount',
        dir,
        [],
        [
          { tool: { id: 'c-good', name: 'transfer_preview', args: { amount, payee: PAYEE } } },
          { text: '试算完成。' },
        ],
      )
      try {
        const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
        agent.send('试算一下')
        await agent.run()

        const result = payloads(app.ctx.get(SESSION_SERVICE).events(), 'tool/result')[0] as {
          isError?: boolean
        }
        expect(result.isError).toBe(false)
      } finally {
        await app.dispose('test')
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

describe('W12 执行 lease 配置（四件套：白名单 / 默认 / fail-loud / 文档）', () => {
  it('默认 lease 窗口 = 票据 TTL（默认行为与今日等价，快照不动）', () => {
    const settings = bankToolsPlugin.validate({})
    expect(settings.ticketLease).toEqual({ enforce: true, ttlSeconds: 120 })
  })

  it('未显式写 ttlSeconds 时跟随 ticketTtlSeconds（不写死常数）', () => {
    expect(bankToolsPlugin.validate({ ticketTtlSeconds: 60 }).ticketLease).toEqual({
      enforce: true,
      ttlSeconds: 60,
    })
  })

  it('显式更紧的窗口与回滚开关都生效', () => {
    const settings = bankToolsPlugin.validate({
      ticketTtlSeconds: 120,
      ticketLease: { enforce: false, ttlSeconds: 30 },
    })
    expect(settings.ticketLease).toEqual({ enforce: false, ttlSeconds: 30 })
  })

  it('TC-W12-09 lease TTL 大于票据 TTL → 启动即 fail-loud（不静默截断）', () => {
    expect(() =>
      bankToolsPlugin.validate({ ticketTtlSeconds: 60, ticketLease: { ttlSeconds: 61 } }),
    ).toThrowError(/ticketLease\.ttlSeconds/)
  })

  it('ticketLease 的未知键 / 非法类型 fail-loud', () => {
    expect(() => bankToolsPlugin.validate({ ticketLease: { ttlSeconds: 10, extra: 1 } })).toThrow(
      /extra/,
    )
    expect(() => bankToolsPlugin.validate({ ticketLease: { enforce: 'yes' } })).toThrow(/enforce/)
    expect(() => bankToolsPlugin.validate({ ticketLease: { ttlSeconds: 0 } })).toThrow(/ttlSeconds/)
  })
})
