/**
 * W08 · 会话级证据链：`tool/call` + `sentry/decision` + `approval/decided`。
 *
 * 两条出口：
 * 1. 一次真实转账后，三类条目都在 `<session>/audit.jsonl`，判决条目是 v2 信封；
 * 2. 启动时发现断链 → `audit/chain-broken` 平台事件 + stderr + HALT（无开关）。
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { generateKeyPairSync } from 'node:crypto'
import { dirname, join } from 'node:path'

import { createSagaAudit } from '@bah/persistence'
import { canonicalJson, sha256Hex } from '@bah/util'
import { HALT_SERVICE } from '@bah/safety'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import { asSessionId } from '@bah/test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { boot, createCatalog, HOST_PLUGINS, type BootOptions, type BootedApp, type HostPlugin , testRunContext } from '@bah/host'

import { DECISION_AUDIT, auditDecisionsPlugin } from './audit-decisions.ts'
import type { Context } from '@bah/core'

import type { PluginRow } from '../profile-plugins.ts'

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个临时会话根。 */
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-audit-decisions-'))
  roots.push(dir)
  return dir
}

/**
 * 观测 `audit/chain-broken` 的探针插件（必须在 sentry 之前 apply）。
 *
 * `throws` 用来验证告警扇出的隔离性：订阅者抛错不能挡住 HALT，也不能断启动。
 */
function spyPlugin(seen: unknown[], throws = false): HostPlugin<Record<string, never>> {
  return {
    id: 'fx:audit-spy',
    plugin: {
      name: 'fx:audit-spy',
      apply(ctx: Context) {
        ctx.events.on('audit/chain-broken', (payload) => {
          seen.push(payload)
          if (throws) throw new Error('sink-down')
        })
      },
    },
    validate() {
      return {}
    },
  }
}

/** 默认行：与 headless 演示同构（一笔 800 元转账走黄级审批）。 */
function rows(options: {
  readonly script: readonly unknown[]
  readonly sessionId: string
  readonly spyThrows?: boolean
  readonly auditConfig?: Record<string, unknown>
}): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    {
      id: 'core:model',
      config: { provider: 'mock', model: 'mock-chat', chunkSize: 8, script: options.script },
    },
    {
      id: 'core:agent',
      config: { channel: 'headless', loop: { model: 'mock:mock-chat', maxSteps: 8 } },
    },
    { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
    { id: 'audit:decisions', ...(options.auditConfig === undefined ? {} : { config: options.auditConfig }) },
    { id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' } },
    {
      id: 'interaction:approval',
      config: { responder: 'headless', autoDecision: 'allow', autoVerify: true },
    },
    { id: 'fx:audit-spy' },
    { id: 'safety:sentry', config: { trace: { sink: 'memory' } } },
  ]
}

/** 启动一个应用到指定会话根。 */
async function bootWith(input: {
  readonly dir: string
  readonly sessionId: string
  readonly script: readonly unknown[]
  readonly seen: unknown[]
  readonly spyThrows?: boolean
  readonly auditConfig?: Record<string, unknown>
}): Promise<BootedApp> {
  const bootOptions: BootOptions = {
    profile: { name: 'fx-audit-decisions', bundles: ['fx-audit-decisions'], hmr: false },
    bundles: [{ name: 'fx-audit-decisions', rows: rows(input) }],
    layers: [],
    catalog: createCatalog([...HOST_PLUGINS, spyPlugin(input.seen, input.spyThrows ?? false)]),
    run: testRunContext({
      sessionId: asSessionId(input.sessionId),
      now: () => 1_792_000_000_000,
      jsonlDir: input.dir,
    }),
  }
  return boot(bootOptions)
}

/** 读会话链（按 seq 升序；文件本身已是追加序）。 */
function chainOf(dir: string, sessionId: string): Record<string, unknown>[] {
  const path = join(dir, 'demo', sessionId, 'audit.jsonl')
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 读会话事件（`type` + `data`；用于重算链上的 `d`）。 */
function sessionOf(dir: string, sessionId: string): Record<string, unknown>[] {
  return readFileSync(join(dir, 'demo', sessionId, 'session.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('W08 · 会话级证据链', () => {
  it('TC-W08-01：一次转账后链中有 tool/call、tool/result、sentry/decision、approval/decided', async () => {
    const dir = root()
    const seen: unknown[] = []
    const app = await bootWith({
      dir,
      sessionId: 's-w08-chain',
      seen,
      script: [
        {
          tool: {
            id: 'call-1',
            name: 'transfer_create',
            args: { amount: 800, payee: { name: '王建国' } },
          },
        },
        { text: '已完成 800 元转账。' },
      ],
    })
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('给王建国转 800 元')
      await agent.run()

      const rows = chainOf(dir, 's-w08-chain')
      const types = rows.map((row) => row['t'])
      expect(types).toContain('tool/call')
      // B4：结果以摘要形式上链（与调用一一对应）
      expect(types).toContain('tool/result')
      expect(types).toContain('sentry/decision')
      expect(types).toContain('approval/decided')
      // 策略外置 S3：每条 tier/decided 都有一条 policy/decision 摘要行
      expect(types).toContain('policy/decision')

      const toolCall = rows.find((row) => row['t'] === 'tool/call')!
      expect(toolCall['version']).toBeUndefined()
      expect(toolCall['sub']).toBe('call-1')

      // B4：tool/result 摘要行——sub 仍是 callId，v1 形状，摘要数与调用数一致
      const resultRows = rows.filter((row) => row['t'] === 'tool/result')
      expect(resultRows).toHaveLength(rows.filter((row) => row['t'] === 'tool/call').length)
      expect(resultRows[0]!['sub']).toBe('call-1')
      expect(resultRows[0]!['version']).toBeUndefined()
      // 摘要不含 content/reason：链行本来就不存 data，这里钉住"不上原文"的纪律
      expect(JSON.stringify(resultRows[0])).not.toContain('content')

      for (const row of rows.filter(
        (candidate) => candidate['t'] !== 'tool/call' && candidate['t'] !== 'tool/result',
      )) {
        expect(row['version']).toBe(2)
        expect(row['subject']).toBe('session:s-w08-chain')
        expect(row['prevHash']).toBe(row['p'])
        expect(String(row['policyVersion'])).toMatch(
          /^(sentry-policy\/2|approval-policy\/1|legacy|bank-tier\/\d+\.\d+\.\d+\+sha256:[0-9a-f]{16})$/,
        )
      }
      const sentryDecision = rows.find((row) => row['t'] === 'sentry/decision')!
      expect(sentryDecision['decision']).toBe('allow')
      expect(sentryDecision['policyVersion']).toBe('sentry-policy/2')
      const approval = rows.find((row) => row['t'] === 'approval/decided')!
      expect(approval['decision']).toBe('allow')
      expect(approval['policyVersion']).toBe('approval-policy/1')

      // S3：policy/decision 的 `d` 必须覆盖 tier/decided 全量载荷（含 evidence）
      const policyRow = rows.find((row) => row['t'] === 'policy/decision')!
      expect(policyRow['decision']).toBe('ask')
      expect(policyRow['policyVersion']).toBe('legacy')
      const decided = sessionOf(dir, 's-w08-chain').find(
        (event) => event['type'] === 'tier/decided',
      )!
      expect(policyRow['d']).toBe(sha256Hex(canonicalJson(decided['data'])))

      // 链是连续的（用审计器再验一遍，而不是只看文件）
      const audit = createSagaAudit({ now: () => 1, rootDir: join(dir, 'demo'), fsync: false })
      expect(audit.verifyContinuity('s-w08-chain')).toEqual({ ok: true })
      expect(seen).toEqual([])
    } finally {
      await app.dispose('test')
    }
  })

  it('policy/decision 写链失败只告警（I17：已做出的判决不被翻转）', async () => {
    const dir = root()
    const sessionId = 's-policy-chain-fail'
    const app = await boot({
      profile: { name: 'fx-audit-fail', bundles: ['fx-audit-fail'], hmr: false },
      bundles: [
        {
          name: 'fx-audit-fail',
          rows: [
            { id: 'core:session' },
            { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
            { id: 'audit:decisions' },
          ],
        },
      ],
      layers: [],
      catalog: createCatalog(),
      run: testRunContext({
        sessionId: asSessionId(sessionId),
        now: () => 1_792_000_000_000,
        jsonlDir: dir,
      }),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 把链文件的位置占成目录：append 必然失败（EISDIR），模拟磁盘故障。
      // 判决落账（session.jsonl）与写链是两个出口，前者的成功不受后者影响。
      mkdirSync(join(dir, 'demo', sessionId, 'audit.jsonl'), { recursive: true })
      const session = app.ctx.get(SESSION_SERVICE)
      session.appendDomain('tier/decided', {
        callId: 'call-chain-fail',
        name: 'transfer_create',
        level: 'red',
        reason: 'daily-limit',
        verdict: 'deny',
        code: 'daily-limit',
        at: 1_792_000_000_000,
        policyVersion: 'bank-tier/1.0.0+sha256:0123456789abcdef',
        ruleIds: ['TR-001-over-daily-limit'],
      })

      expect(
        warn.mock.calls.some((args) =>
          String(args[0]).includes('policy/decision 写入失败（判决不变）'),
        ),
      ).toBe(true)
      // 判决本体仍在会话日志里（写链失败只是旁路证据缺失）
      expect(
        session.events().some((event) => String(event.type) === 'tier/decided'),
      ).toBe(true)
    } finally {
      warn.mockRestore()
      await app.dispose('test')
    }
  })

  it('B4：缺钥 → unsigned 启动不失败，且显式提示（不静默）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const dir = root()
      const app = await bootWith({
        dir,
        sessionId: 's-w08-unsigned',
        seen: [],
        script: [{ tool: { id: 'call-1', name: 'account_balance', args: {} } }, { text: '查询完成。' }],
      })
      try {
        const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
        agent.send('查余额')
        await agent.run()

        const rows = chainOf(dir, 's-w08-unsigned')
        expect(rows.length).toBeGreaterThan(0)
        // unsigned：链行不带签名
        for (const row of rows) expect(row['sig']).toBeUndefined()
        // 提示必须说出来（B4：不能静默降级）
        const notices = warn.mock.calls.map((call) => String(call[0])).join('\n')
        expect(notices).toContain('unsigned')
      } finally {
        await app.dispose('test')
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('B4：有钥 → tool/call、tool/result、sentry/decision、approval/decided 全部签名且可验', async () => {
    const dir = root()
    const keyPath = join(dir, 'keys', 'test-ed25519.pem')
    mkdirSync(dirname(keyPath), { recursive: true })
    writeFileSync(
      keyPath,
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    )
    const seen: unknown[] = []
    const app = await bootWith({
      dir,
      sessionId: 's-w08-signed',
      seen,
      script: [
        {
          tool: {
            id: 'call-1',
            name: 'transfer_create',
            args: { amount: 800, payee: { name: '王建国' } },
          },
        },
        { text: '已完成 800 元转账。' },
      ],
      auditConfig: { signingKeyPath: keyPath },
    })
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('给王建国转 800 元')
      await agent.run()

      const rows = chainOf(dir, 's-w08-signed')
      const signedTypes = new Set(
        rows.filter((row) => row['sig'] !== undefined).map((row) => row['t']),
      )
      for (const type of ['tool/call', 'tool/result', 'sentry/decision', 'approval/decided']) {
        expect(signedTypes.has(type)).toBe(true)
      }
      // 验签由同一密钥通过（不是只看 sig 存在）
      const audit = createSagaAudit({
        now: () => 1,
        rootDir: dir,
        fsync: false,
        signingKeyPath: keyPath,
      })
      expect(audit.verifySignatures('s-w08-signed')).toMatchObject({ ok: true })
      expect(audit.verifyContinuity('s-w08-signed')).toEqual({ ok: true })
    } finally {
      await app.dispose('test')
    }
  })

  it('会话 ID 不得占用编排链命名空间（saga-* / system-startup）', async () => {
    for (const sessionId of ['saga-collision', 'system-startup']) {
      await expect(
        bootWith({ dir: root(), sessionId, seen: [], script: [{ text: '你好' }] }),
      ).rejects.toThrow(/audit-chain-id-reserved/)
    }
  })

  it('TC-W08-04（运行时）：启动发现断链 → audit/chain-broken + stderr + HALT', async () => {
    const dir = root()
    // 造一条两行的链，再篡改第一条的 data 摘要
    const chain = createSagaAudit({ now: () => 1, rootDir: join(dir, 'demo'), fsync: false })
    chain.append('s-broken', 'saga/created', { sagaId: 's-broken' })
    chain.append('s-broken', 'saga/call-result', { sagaId: 's-broken', stepId: 'st-1' })
    const path = join(dir, 'demo', 's-broken', 'audit.jsonl')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>
    lines[0] = JSON.stringify({ ...first, d: 'tampered' })
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')

    const seen: unknown[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const app = await bootWith({
        dir,
        sessionId: 's-w08-broken',
        seen,
        // 订阅者故意抛错：HALT 已先落，告警失败只进 stderr，不阻断启动
        spyThrows: true,
        script: [{ text: '你好' }],
      })
      try {
        const halt = app.ctx.get(HALT_SERVICE)
        expect(halt.halted).toBe(true)
        expect(halt.reason).toBe('chain-broken')
        expect(halt.view().detail).toContain('s-broken')
        expect(seen).toEqual([
          { chainId: 's-broken', brokenAt: 1, at: 1_792_000_000_000 },
        ])
        const stderr = write.mock.calls.map((call) => String(call[0])).join('')
        expect(stderr).toContain('audit/chain-broken')
        expect(stderr).toContain('s-broken')
        // 告警订阅者抛错被隔离，且明确记在 stderr
        expect(stderr).toContain('sink-failed')
        expect(stderr).toContain('sink-down')
      } finally {
        await app.dispose('test')
      }
    } finally {
      write.mockRestore()
    }
  })

  it('verifyAll：链文件中段损坏读不出来 → 记为 brokenAt=0 并带 error（不能静默跳过）', async () => {
    const dir = root()
    const app = await bootWith({
      dir,
      sessionId: 's-w08-unreadable',
      seen: [],
      script: [
        {
          tool: { id: 'call-1', name: 'account_balance', args: {} },
        },
        { text: '查询完成。' },
      ],
    })
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('查余额')
      await agent.run()

      const path = join(dir, 'demo', 's-w08-unreadable', 'audit.jsonl')
      const lines = readFileSync(path, 'utf8').trim().split('\n')
      // 至少要两行：末行半写会被容忍，只有中段损坏才进入"读不出来"分支
      expect(lines.length).toBeGreaterThan(1)
      writeFileSync(path, `${['{ 坏行', ...lines.slice(1)].join('\n')}\n`, 'utf8')

      const breaks = app.ctx.get(DECISION_AUDIT).verifyAll()
      expect(breaks).toHaveLength(1)
      expect(breaks[0]).toMatchObject({ chainId: 's-w08-unreadable', brokenAt: 0 })
      expect(breaks[0]?.error).toBeTruthy()
    } finally {
      await app.dispose('test')
    }
  })
})

describe('audit:decisions 配置（签名私钥路径）', () => {
  /**
   * 为什么补：`signingKeyPath` 是唯一能改变"哪些条目会被签名"的配置。
   * 传空串/数字此前没有任何用例，而空串会让链上的签名集合与"未配置"看起来一样，
   * 排障时无法区分"忘了配"与"配错了"。这里钉住：非法值必须在 boot 期拒，
   * 未配置才落到默认路径。
   */
  it('非法 signingKeyPath（空串 / 非字符串）→ invalid-config；未写则落默认', () => {
    expect(() => auditDecisionsPlugin.validate({ signingKeyPath: '' })).toThrowError(
      /signingKeyPath/,
    )
    expect(() => auditDecisionsPlugin.validate({ signingKeyPath: 123 })).toThrowError(
      /signingKeyPath/,
    )
    expect(auditDecisionsPlugin.validate({}).signingKeyPath).toBe('keys/saga-ed25519.pem')
    expect(auditDecisionsPlugin.validate({ signingKeyPath: 'keys/a.pem' }).signingKeyPath).toBe(
      'keys/a.pem',
    )
  })
})
