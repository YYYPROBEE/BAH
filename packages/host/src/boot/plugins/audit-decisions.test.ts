/**
 * W08 · 会话级证据链：`tool/call` + `sentry/decision` + `approval/decided`。
 *
 * 两条出口：
 * 1. 一次真实转账后，三类条目都在 `<session>/audit.jsonl`，判决条目是 v2 信封；
 * 2. 启动时发现断链 → `audit/chain-broken` 平台事件 + stderr + HALT（无开关）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSagaAudit } from '@bah/persistence'
import { HALT_SERVICE } from '@bah/safety'
import { AGENTS_SERVICE } from '@bah/runtime'
import { asSessionId } from '@bah/test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { boot, createCatalog, HOST_PLUGINS, type BootOptions, type BootedApp, type HostPlugin } from '@bah/host'

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
    { id: 'audit:decisions' },
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
}): Promise<BootedApp> {
  const bootOptions: BootOptions = {
    profile: { name: 'fx-audit-decisions', bundles: ['fx-audit-decisions'], hmr: false },
    bundles: [{ name: 'fx-audit-decisions', rows: rows(input) }],
    layers: [],
    catalog: createCatalog([...HOST_PLUGINS, spyPlugin(input.seen, input.spyThrows ?? false)]),
    run: {
      sessionId: asSessionId(input.sessionId),
      now: () => 1_792_000_000_000,
      jsonlDir: input.dir,
    },
  }
  return boot(bootOptions)
}

/** 读会话链（按 seq 升序；文件本身已是追加序）。 */
function chainOf(dir: string, sessionId: string): Record<string, unknown>[] {
  const path = join(dir, sessionId, 'audit.jsonl')
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('W08 · 会话级证据链', () => {
  it('TC-W08-01：一次转账后链中有 tool/call、sentry/decision、approval/decided', async () => {
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
      expect(types).toContain('sentry/decision')
      expect(types).toContain('approval/decided')

      const toolCall = rows.find((row) => row['t'] === 'tool/call')!
      expect(toolCall['version']).toBeUndefined()
      expect(toolCall['sub']).toBe('call-1')

      for (const row of rows.filter((candidate) => candidate['t'] !== 'tool/call')) {
        expect(row['version']).toBe(2)
        expect(row['subject']).toBe('session:s-w08-chain')
        expect(row['prevHash']).toBe(row['p'])
        expect(row['policyVersion']).toMatch(/^(sentry-policy\/2|approval-policy\/1)$/)
      }
      const sentryDecision = rows.find((row) => row['t'] === 'sentry/decision')!
      expect(sentryDecision['decision']).toBe('allow')
      expect(sentryDecision['policyVersion']).toBe('sentry-policy/2')
      const approval = rows.find((row) => row['t'] === 'approval/decided')!
      expect(approval['decision']).toBe('allow')
      expect(approval['policyVersion']).toBe('approval-policy/1')

      // 链是连续的（用审计器再验一遍，而不是只看文件）
      const audit = createSagaAudit({ now: () => 1, rootDir: dir, fsync: false })
      expect(audit.verifyContinuity('s-w08-chain')).toEqual({ ok: true })
      expect(seen).toEqual([])
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
    const chain = createSagaAudit({ now: () => 1, rootDir: dir, fsync: false })
    chain.append('s-broken', 'saga/created', { sagaId: 's-broken' })
    chain.append('s-broken', 'saga/call-result', { sagaId: 's-broken', stepId: 'st-1' })
    const path = join(dir, 's-broken', 'audit.jsonl')
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
})
