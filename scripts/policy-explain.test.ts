/**
 * `policy:explain`（S3）：按记录版本复算、证据摘要、链哈希对应。
 *
 * 用临时 sessions 目录造会话/链，不改仓库里的快照或 policies/。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadBundle } from '../packages/policy/src/load.ts'
import { createSagaAudit } from '../packages/persistence/src/chain/index.ts'
import { canonicalJson, sha256Hex } from '../packages/util/src/index.ts'

import { adminPaths } from './policy-admin-lib.ts'
import { toolNames } from './policy-cli.ts'
import { explainDecision } from './policy-explain-lib.ts'

const roots: string[] = []
const SESSION = 's-explain'
const NOW = 1_761_700_000_000

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-policy-explain-'))
  roots.push(dir)
  return dir
}

/** 真实 bundle 的一次判决输入（与 S2 治理平面构造的字段一致）。 */
function tierInput(): Record<string, unknown> {
  return {
    subject: { userId: 'u-1', sessionId: SESSION },
    action: { name: 'transfer_create', declared: 'yellow' },
    preview: {
      amountCents: 80_000,
      dailyUsedCents: 0,
      dailyLimitCents: 100_000,
      payee: { binding: 'whitelist' },
    },
    state: { riskyCallsInTurn: 0, verifyLocked: false },
    limits: { dailyLimitCents: 100_000 },
    params: { riskyCallThreshold: 3 },
  }
}

interface Fixture {
  readonly dir: string
  readonly event: Record<string, unknown>
  readonly policyVersion: string
}

/** 造一条 bundle 判决 + 对应链行；`chain: false` 时只写会话。 */
function fixture(options: { readonly chain?: boolean; readonly mutate?: (data: Record<string, unknown>) => void } = {}): Fixture {
  const dir = sessionsDir()
  const compiled = loadBundle({ dir: 'policies/bank-tier/1.0.0', verifyLock: true, toolNames: toolNames() }).compiled
  const input = tierInput()
  const result = compiled.evaluate(compiled.validateInput(input))
  const data: Record<string, unknown> = {
    callId: 'c-1',
    name: 'transfer_create',
    level: result.level,
    reason: result.reason,
    verdict: 'ask',
    at: NOW,
    policyVersion: compiled.descriptor.policyVersion,
    ruleIds: result.ruleIds,
    paramsDigest: `sha256:${'0'.repeat(64)}`,
    engineSource: 'bundle',
    evidence: {
      inputDigest: `sha256:${sha256Hex(canonicalJson(input))}`,
      input,
    },
  }
  options.mutate?.(data)
  mkdirSync(join(dir, SESSION), { recursive: true })
  const path = join(dir, SESSION, 'session.jsonl')
  writeFileSync(
    path,
    `${JSON.stringify({ kind: 'bah-session-header', sessionId: SESSION, formatVersion: 1, createdAt: NOW })}\n` +
      `${JSON.stringify({ seq: 1, at: NOW, formatVersion: 1, type: 'tier/decided', data })}\n`,
    'utf8',
  )
  if (options.chain !== false) {
    const audit = createSagaAudit({ now: () => NOW, rootDir: dir, fsync: false, signedTypes: [] })
    audit.append(SESSION, 'policy/decision', data, undefined, {
      subject: `session:${SESSION}`,
      decision: 'ask',
      policyVersion: compiled.descriptor.policyVersion,
    })
  }
  return { dir, event: data, policyVersion: compiled.descriptor.policyVersion }
}

function explainAt(dir: string, extra: { requireChain?: boolean; requireEvidence?: boolean; callId?: string } = {}) {
  return explainDecision({
    session: SESSION,
    sessionsDir: dir,
    callId: extra.callId ?? 'c-1',
    paths: adminPaths(),
    requireChain: extra.requireChain ?? true,
    requireEvidence: extra.requireEvidence ?? true,
  })
}

describe('policy:explain', () => {
  it('正常：按 digest 复算逐字段一致，链 d 命中，证据摘要自洽', () => {
    const f = fixture()
    const result = explainAt(f.dir)
    expect(result.ok).toBe(true)
    expect(result.reproduced).toBe(true)
    expect(result.policyVersion).toBe(f.policyVersion)
    expect(result.decision).toEqual({ level: 'yellow', reason: 'declared' })
    expect(result.ruleIds).toEqual(['TR-003-default', 'RC-002-default'])
    expect(result.rules?.find((rule) => rule.id === 'TR-003-default')?.line).toBeGreaterThan(0)
    expect(result.chain.status).toBe('verified')
    expect(result.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('证据被改 → input-digest-mismatch（不静默复算）', () => {
    const f = fixture({
      mutate: (data) => {
        const evidence = data['evidence'] as { input: Record<string, unknown> }
        ;(evidence.input['preview'] as Record<string, unknown>)['amountCents'] = 80_001
      },
    })
    const result = explainAt(f.dir)
    expect(result.ok).toBe(false)
    expect(result.diffs).toContain('input-digest-mismatch')
  })

  it('链缺失：默认可用但 chain=missing；--require-chain 时失败', () => {
    const f = fixture({ chain: false })
    const relaxed = explainAt(f.dir, { requireChain: false })
    expect(relaxed.ok).toBe(true)
    expect(relaxed.chain.status).toBe('missing')
    const strict = explainAt(f.dir, { requireChain: true })
    expect(strict.ok).toBe(false)
  })

  it('legacy 判决没有 evidence：默认 exit 0；--require-evidence 失败', () => {
    const dir = sessionsDir()
    mkdirSync(join(dir, SESSION), { recursive: true })
    writeFileSync(
      join(dir, SESSION, 'session.jsonl'),
      `${JSON.stringify({ kind: 'bah-session-header', sessionId: SESSION, formatVersion: 1, createdAt: NOW })}\n` +
        `${JSON.stringify({ seq: 1, at: NOW, formatVersion: 1, type: 'tier/decided', data: { callId: 'c-1', name: 'transfer_create', level: 'yellow', reason: 'declared', verdict: 'ask', at: NOW, policyVersion: 'legacy', ruleIds: [] } })}\n`,
      'utf8',
    )
    const relaxed = explainAt(dir, { callId: 'c-1', requireChain: false, requireEvidence: false })
    expect(relaxed.ok).toBe(true)
    expect(relaxed.evidence).toBe('missing')
    const strict = explainAt(dir, { callId: 'c-1', requireChain: false, requireEvidence: true })
    expect(strict.ok).toBe(false)
  })

  it('归档版本不存在 → policy-archive-missing（不拿当前 active 重算）', () => {
    const f = fixture({
      mutate: (data) => {
        data['policyVersion'] = 'bank-tier/9.9.9+sha256:0000000000000000'
      },
    })
    let code = 'no-throw'
    try {
      explainAt(f.dir)
    } catch (error) {
      code = (error as { code?: string }).code ?? 'unknown'
    }
    expect(code).toBe('policy-archive-missing')
    expect(readFileSync(join(f.dir, SESSION, 'session.jsonl'), 'utf8')).toContain('9.9.9')
  })
})

describe('policy:shadow（真实证据重放）', () => {
  it('单笔 5000 元：demo 的 TR-004 让判决从黄变红，差异逐字段列出', async () => {
    const f = fixture({
      mutate: (data) => {
        const evidence = data['evidence'] as { input: Record<string, unknown> }
        const preview = evidence.input['preview'] as Record<string, unknown>
        preview['amountCents'] = 500_000
        preview['dailyLimitCents'] = 1_000_000
        ;(evidence.input['limits'] as Record<string, unknown>)['dailyLimitCents'] = 1_000_000
      },
    })
    const { compareShadow } = await import('./policy-admin-lib.ts')
    const report = compareShadow({
      paths: adminPaths(),
      from: 'bank-tier/1.0.0',
      to: 'bank-tier-demo/1.0.0',
      sessionsDir: f.dir,
    })
    expect(report.total).toBe(1)
    expect(report.changed).toBe(1)
    expect(report.diffs[0]?.fields).toEqual(['level', 'reason', 'ruleIds'])
    expect(report.diffs[0]?.from.level).toBe('yellow')
    expect(report.diffs[0]?.to.level).toBe('red')
  })

  it('legacy 判决没有 evidence → 跳过并计数（不静默当 0 条）', async () => {
    const dir = sessionsDir()
    mkdirSync(join(dir, SESSION), { recursive: true })
    writeFileSync(
      join(dir, SESSION, 'session.jsonl'),
      `${JSON.stringify({ kind: 'bah-session-header', sessionId: SESSION, formatVersion: 1, createdAt: NOW })}\n` +
        `${JSON.stringify({ seq: 1, at: NOW, formatVersion: 1, type: 'tier/decided', data: { callId: 'c-1', policyVersion: 'legacy', ruleIds: [] } })}\n`,
      'utf8',
    )
    const { compareShadow } = await import('./policy-admin-lib.ts')
    const report = compareShadow({
      paths: adminPaths(),
      from: 'bank-tier/1.0.0',
      to: 'bank-tier-demo/1.0.0',
      sessionsDir: dir,
    })
    expect(report.total).toBe(0)
    expect(report.changed).toBe(0)
    expect(report.skipped).toBe(1)
  })
})

describe('policy:explain · 真实 host 会话（S3 闭环）', () => {
  it('bundle 判决 → tier/decided.evidence → policy/decision 链 → explain 复现', async () => {
    const { boot, createCatalog } = await import('../packages/host/src/index.ts')
    const { asSessionId } = await import('../packages/test-support/src/index.ts')
    const { AGENTS_SERVICE, SESSION_SERVICE } = await import('../packages/runtime/src/index.ts')

    const sessions = mkdtempSync(join(tmpdir(), 'bah-explain-live-'))
    roots.push(sessions)
    const app = await boot({
      profile: { name: 'explain-live', bundles: ['explain-live'], hmr: false },
      bundles: [
        {
          name: 'explain-live',
          rows: [
            { id: 'core:session' },
            { id: 'core:tools' },
            { id: 'core:prompt' },
            {
              id: 'core:model',
              config: {
                provider: 'mock',
                model: 'mock-chat',
                script: [
                  {
                    tool: {
                      id: 'call-transfer',
                      name: 'transfer_create',
                      args: {
                        amount: 800,
                        payee: { name: '王建国', phone: '13900002222' },
                        remark: '房租',
                      },
                    },
                  },
                  { text: '已发起转账。' },
                ],
              },
            },
            {
              id: 'core:agent',
              config: { channel: 'headless', loop: { model: 'mock:mock-chat' } },
            },
            { id: 'core:persistence', config: { root: sessions, fsync: false } },
            { id: 'audit:decisions' },
            { id: 'policy:rules', config: { root: 'policies' } },
            {
              id: 'bank:tools',
              config: { demoUserId: 'u-1', policy: { engine: 'bundle' } },
            },
            {
              id: 'interaction:approval',
              config: { responder: 'headless', autoDecision: 'allow', autoVerify: true },
            },
          ],
        },
      ],
      layers: [],
      catalog: createCatalog(),
      run: {
        sessionId: asSessionId(SESSION),
        now: () => NOW,
        probe: true,
        jsonlDir: sessions,
      },
    })
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('转账 800 元给王建国')
      await agent.run()
      expect(
        app.ctx
          .get(SESSION_SERVICE)
          .events()
          .some((event) => String(event.type) === 'tier/decided'),
      ).toBe(true)

      const result = explainDecision({
        session: SESSION,
        sessionsDir: sessions,
        callId: 'call-transfer',
        paths: adminPaths(),
        requireChain: true,
        requireEvidence: true,
      })
      expect(result.ok).toBe(true)
      expect(result.reproduced).toBe(true)
      expect(result.evidence).toBe('present')
      expect(result.chain.status).toBe('verified')
      expect(result.policyVersion).toMatch(/^bank-tier\/1\.0\.0\+sha256:/)
    } finally {
      await app.dispose('test')
    }
  })
})
