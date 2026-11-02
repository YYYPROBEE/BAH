/**
 * SA-12 收敛闭环 · T-SA12-001~010（批 5 验收）。
 *
 * 纪律：
 * - 外部域（对账单 / 投影）全部注入 mock；
 * - 时钟用手推 `SagaClock`，禁真实等待；
 * - job 一律**直调**，不依赖批 6 的 `saga/tick` 派发；
 * - 断言落在确定性状态 / 链 / 事件记录上。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext } from '@bah/core'
import { createSagaAudit, createSagaStore, SIGNED_TYPES } from '@bah/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { installIdempotency, makeKey } from './idempotency/index.ts'
import { forceClose, hardEscalationIds, runJanitor } from './janitor/index.ts'
import { isDrillWindow, reconcileBatch, reconPeriodOf, runReconJob } from './recon/index.ts'
import { dayEndResidualDiff, recordResidual } from './recon/residual.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE } from './seams.ts'
import { parseSagaSettings } from './settings.ts'
import { installTemplates, registerTemplate } from './templates/index.ts'
import { lastJobHeartbeat } from './tick/registry.ts'

import type { Context } from '@bah/core'
import type { AlertLevel, AlertSink } from './alert/sink.ts'
import type { ForceCloseManifest } from './janitor/index.ts'
import type { ExternalStatement, ReconDeps } from './recon/index.ts'
import type { CompTemplate, SagaSettings, SagaState } from './types.ts'

const cleanup: string[] = []
const closers: Array<{ close(): void }> = []

afterEach(() => {
  for (const store of closers.splice(0)) store.close()
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RecordedEvents {
  readonly manuallyClosed: Array<{ sagaId: string; operator: string; manifestRef: string; reason: string }>
  readonly dlqEscalated: Array<{ sagaId: string; dlqId: string; source: string; reason: string }>
  readonly reconciled: Array<{
    batchId: string
    sagaId?: string
    diffCount: number
    amendmentSagaId?: string
  }>
  readonly residualRecorded: Array<{ sagaId: string; compId: string; residualType: string; amount: number }>
}

interface Harness {
  readonly ctx: Context
  readonly store: ReturnType<typeof createSagaStore>
  readonly settings: SagaSettings
  readonly auditDir: string
  readonly alerts: Array<{ level: AlertLevel; message: string }>
  readonly sink: AlertSink
  readonly events: RecordedEvents
  now(): number
  advance(ms: number): void
}

/** 真存储 + 真审计链 + 手推时钟；阈值刻意调小，避免真实等待。 */
function harness(overrides: Readonly<Record<string, unknown>> = {}, initialNow = 1_000_000): Harness {
  const rootDir = mkdtempSync(join(tmpdir(), 'bah-saga-convergence-'))
  cleanup.push(rootDir)
  let now = initialNow

  const store = createSagaStore({ dbPath: join(rootDir, 'saga.sqlite'), now: () => now })
  closers.push(store)
  const ctx = createContext()
  ctx.provide(SAGA_STORE, store)
  ctx.provide(SAGA_CLOCK, {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  })
  installIdempotency(ctx)
  installTemplates(ctx)

  const auditDir = join(rootDir, 'audit')
  const { privateKey } = generateKeyPairSync('ed25519')
  const signingKeyPath = join(rootDir, 'saga-ed25519.pem')
  writeFileSync(signingKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  })
  const audit = createSagaAudit({
    ctx,
    now: () => now,
    rootDir: auditDir,
    fsync: false,
    signingKeyPath,
    signedTypes: [...SIGNED_TYPES],
  })
  ctx.provide(SAGA_AUDIT, audit)

  const settings = parseSagaSettings({
    softSlaMs: 1_000,
    hardSlaMs: 2_000,
    forceCloseMs: 3_000,
    reconBatchSize: 2,
    ...overrides,
  })

  const alerts: Array<{ level: AlertLevel; message: string }> = []
  const sink: AlertSink = (level, message) => {
    alerts.push({ level, message })
  }

  const events: RecordedEvents = {
    manuallyClosed: [],
    dlqEscalated: [],
    reconciled: [],
    residualRecorded: [],
  }
  ctx.events.on('saga/manually-closed', (payload) => events.manuallyClosed.push(payload))
  ctx.events.on('saga/dlq-escalated', (payload) => events.dlqEscalated.push(payload))
  ctx.events.on('saga/reconciled', (payload) => events.reconciled.push(payload))
  ctx.events.on('saga/residual-recorded', (payload) => events.residualRecorded.push(payload))

  return {
    ctx,
    store,
    settings,
    auditDir,
    alerts,
    sink,
    events,
    now: () => now,
    advance(ms) {
      now += ms
    },
  }
}

interface SeedOptions {
  readonly sagaId: string
  readonly state?: SagaState
  readonly ageMs?: number
  readonly version?: number
  readonly businessType?: string
}

function seedSaga(h: Harness, options: SeedOptions): void {
  const at = h.now()
  const createdAt = at - (options.ageMs ?? 0)
  h.store.tx((tx) => {
    tx.insertTransaction({
      sagaId: options.sagaId,
      businessType: options.businessType ?? 'TRANSFER',
      traceId: `trace-${options.sagaId}`,
      state: options.state ?? 'RUNNING',
      version: options.version ?? 1,
      timeoutBudgetMs: 60_000,
      compStrategy: 'AUTO',
      initiator: '{}',
      frozen: false,
      createdAt,
      updatedAt: createdAt,
    })
  })
}

function template(overrides: Partial<CompTemplate> = {}): CompTemplate {
  return {
    templateId: 'refund',
    templateVersion: 1,
    targetTool: 'pay.refund',
    compKind: 'FULL_REFUND',
    compEndpoint: '/comp/refund',
    compIdempotent: true,
    residualRules: ['MIN_FEE'],
    approvalRequired: false,
    payloadProjection: JSON.stringify({ fields: [{ from: 'stepId', to: 'stepId' }] }),
    status: 'ACTIVE',
    ...overrides,
  }
}

function zeroDeps(): ReconDeps {
  return {
    projectionDiff: () => 0,
    readStream: () => [],
  }
}

const emptyStatement: ExternalStatement = async () => []

function chainOf(h: Harness, sagaId: string): Array<Record<string, unknown>> {
  try {
    const raw = readFileSync(join(h.auditDir, sagaId, 'audit.jsonl'), 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

const MANIFEST: ForceCloseManifest = {
  unfinishedEffects: ['step-1'],
  reconInstruction: '对账 operator 核对 step-1 的外部终态',
  preparedBy: 'operator-1',
}

describe('SA-12 收敛闭环', () => {
  it('T-SA12-001：无清单强制关闭被拒（manifest-required）', () => {
    const h = harness()
    seedSaga(h, { sagaId: 'force-1', ageMs: 5_000 })

    let missing: unknown
    try {
      forceClose(h.ctx, 'force-1', undefined)
    } catch (error) {
      missing = error
    }
    expect((missing as { code?: string }).code).toBe('manifest-required')
    expect(h.store.loadTransaction('force-1')?.state).toBe('RUNNING')
    expect(chainOf(h, 'force-1').some((row) => row['t'] === 'saga/manually-closed')).toBe(false)

    expect(() =>
      forceClose(h.ctx, 'force-1', { ...MANIFEST, reconInstruction: '   ' }),
    ).toThrow(/manifest-required/)
    expect(h.store.loadTransaction('force-1')?.state).toBe('RUNNING')
  })

  it('T-SA12-002：三级分流 soft→告警 / hard→冻结+工单 / force→MANUALLY_CLOSED', () => {
    const h = harness()
    seedSaga(h, { sagaId: 'soft-1', ageMs: 1_500 })
    seedSaga(h, { sagaId: 'hard-1', ageMs: 2_500 })
    seedSaga(h, { sagaId: 'force-1', ageMs: 3_500 })

    const counts = runJanitor(
      h.ctx,
      h.settings,
      (sagaId) => (sagaId === 'force-1' ? MANIFEST : undefined),
      h.sink,
    )

    expect(counts).toEqual({ alerted: 1, frozen: 1, closed: 1 })
    expect(h.alerts.filter((alert) => alert.level === 'P1' && alert.message.includes('sla-soft:soft-1'))).toHaveLength(1)

    const ids = hardEscalationIds('hard-1')
    const pending = h.store.tx((tx) => tx.listDlqPending())
    expect(pending).toHaveLength(1)
    expect(pending[0]?.sagaId).toBe('hard-1')
    expect(h.store.tx((tx) => tx.readTicket(ids.ticketId))?.reason).toBe('DLQ_ESCALATION')
    expect(h.store.loadTransaction('hard-1')?.frozen).toBe(true)
    expect(h.events.dlqEscalated).toHaveLength(1)

    expect(h.store.loadTransaction('force-1')?.state).toBe('MANUALLY_CLOSED')
    expect(h.events.manuallyClosed).toHaveLength(1)
    expect(h.events.manuallyClosed[0]?.manifestRef.length).toBeGreaterThan(0)
    expect(chainOf(h, 'force-1').some((row) => row['t'] === 'saga/manually-closed')).toBe(true)
  })

  it('T-SA12-003：清道夫每轮刷新心跳且单调不减', () => {
    const h = harness()
    seedSaga(h, { sagaId: 'soft-1', ageMs: 1_500 })

    runJanitor(h.ctx, h.settings, () => undefined, h.sink)
    expect(lastJobHeartbeat(h.ctx, 'janitor')).toBe(h.now())

    h.advance(500)
    const previous = lastJobHeartbeat(h.ctx, 'janitor')
    runJanitor(h.ctx, h.settings, () => undefined, h.sink)
    const current = lastJobHeartbeat(h.ctx, 'janitor')
    expect(current).toBe(h.now())
    expect(current ?? 0).toBeGreaterThanOrEqual(previous ?? 0)
  })

  it('T-SA12-004：状态漂移触发 P0 与 saga/reconciled(diff≥1)', async () => {
    const h = harness()
    seedSaga(h, { sagaId: 'drift-1' })

    const result = await reconcileBatch(
      h.ctx,
      h.settings,
      { fromIndex: 0, sagaIds: ['drift-1'] },
      emptyStatement,
      { projectionDiff: () => 1, readStream: () => [] },
      h.sink,
    )

    expect(result.diffCount).toBeGreaterThanOrEqual(1)
    expect(h.alerts.filter((alert) => alert.level === 'P0')).toHaveLength(1)
    expect(h.events.reconciled.at(-1)?.diffCount).toBeGreaterThanOrEqual(1)
  })

  it('T-SA12-005：修正 saga 的父链、模板版本与步骤真实值', async () => {
    const h = harness()
    const bound = template({ templateVersion: 3 })
    registerTemplate(h.ctx, bound)
    const at = h.now()

    h.store.tx((tx) => {
      tx.insertTransaction({
        sagaId: 'orig-1',
        businessType: 'TRANSFER',
        traceId: 'trace-orig-1',
        state: 'COMPENSATING',
        version: 2,
        timeoutBudgetMs: 60_000,
        compStrategy: 'AUTO',
        initiator: '{}',
        frozen: false,
        createdAt: at,
        updatedAt: at,
      })
      tx.insertStep({
        stepId: 'step-1',
        sagaId: 'orig-1',
        seqNo: 0,
        topologyDeps: [],
        toolName: 'pay.refund',
        endpoint: '/pay/refund',
        sideEffectClass: 'EXTERNAL_UNDOABLE',
        idempotencyKey: makeKey('FWD', 'orig-1', 'step-1', 'nonce-orig'),
        idempotencyNonce: 'nonce-orig',
        state: 'EXECUTED',
        attempts: 1,
        maxAttempts: 3,
        deadlineMs: 60_000,
      })
      tx.bindCompensation('orig-1', 'step-1', bound)
    })

    const statement: ExternalStatement = async () => [
      { sagaId: 'orig-1', externalState: 'EXECUTED', danglingEffects: ['step-1'] },
    ]
    const result = await reconcileBatch(
      h.ctx,
      h.settings,
      { fromIndex: 0, sagaIds: ['orig-1'] },
      statement,
      zeroDeps(),
      h.sink,
    )

    const amendmentId = result.amendmentSagaId
    expect(amendmentId).toBeDefined()
    const amendment = h.store.loadTransaction(amendmentId as string)
    expect(amendment?.businessType).toBe('AMENDMENT_COMPENSATION')
    expect(amendment?.parentSagaId).toBe('orig-1')

    const steps = h.store.listSteps(amendmentId as string)
    expect(steps).toHaveLength(1)
    expect(steps[0]?.toolName).toBe('pay.refund')
    expect(steps[0]?.endpoint).toBe('/pay/refund')
    expect(steps[0]?.idempotencyNonce.length).toBeGreaterThan(0)

    const comps = h.store.tx((tx) => tx.listCompensations(amendmentId as string))
    expect(comps).toHaveLength(1)
    expect(comps[0]?.templateId).toBe(bound.templateId)
    expect(comps[0]?.templateVersion).toBe(3)
    expect(h.events.reconciled.at(-1)?.amendmentSagaId).toBe(amendmentId)
  })

  it('T-SA12-006：分批上限、确定性 batchId、重入不重复处理', async () => {
    const h = harness()
    const seen: string[][] = []
    const statement: ExternalStatement = async (sagaIds) => {
      seen.push([...sagaIds])
      return []
    }
    const batch = { fromIndex: 7, sagaIds: ['a', 'b', 'c', 'd', 'e'] }

    const first = await reconcileBatch(h.ctx, h.settings, batch, statement, zeroDeps(), h.sink)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(['a', 'b'])
    expect(first.batchId).toBe(`recon:${reconPeriodOf(h.now())}:7`)

    const second = await reconcileBatch(h.ctx, h.settings, batch, statement, zeroDeps(), h.sink)
    expect(second.batchId).toBe(first.batchId)
    expect(seen).toHaveLength(1)
  })

  it('T-SA12-007：对账心跳 1 天告警 / 2 天 P0', async () => {
    const h = harness()

    await runReconJob(h.ctx, h.settings, emptyStatement, zeroDeps(), h.sink, { drill: false })
    expect(h.alerts).toHaveLength(0)

    h.advance(25 * 3_600_000)
    await runReconJob(h.ctx, h.settings, emptyStatement, zeroDeps(), h.sink, { drill: false })
    expect(h.alerts.filter((alert) => alert.level === 'P1')).toHaveLength(1)

    h.advance(49 * 3_600_000)
    await runReconJob(h.ctx, h.settings, emptyStatement, zeroDeps(), h.sink, { drill: false })
    expect(h.alerts.filter((alert) => alert.level === 'P0')).toHaveLength(1)
  })

  it('T-SA12-008：每周假差异演练闭环，非演练周不注入', async () => {
    const h = harness({ anchorIntervalMs: 1_000 }, 7_000)
    seedSaga(h, { sagaId: 'drill-1' })
    expect(isDrillWindow(h.now(), h.settings)).toBe(true)

    const drill = await runReconJob(h.ctx, h.settings, emptyStatement, zeroDeps(), h.sink, {
      drill: true,
    })
    expect(drill.drill).toBe(true)
    expect(h.alerts.filter((alert) => alert.level === 'P0' && alert.message.includes('recon-drill'))).toHaveLength(1)
    expect(h.events.reconciled.some((event) => event.diffCount >= 1)).toBe(true)

    const idle = harness({ anchorIntervalMs: 1_000 }, 8_000)
    seedSaga(idle, { sagaId: 'idle-1' })
    expect(isDrillWindow(idle.now(), idle.settings)).toBe(false)
    const silent = await runReconJob(idle.ctx, idle.settings, emptyStatement, zeroDeps(), idle.sink, {
      drill: false,
    })
    expect(silent.drill).toBe(false)
    expect(idle.alerts.filter((alert) => alert.level === 'P0')).toHaveLength(0)
    expect(idle.events.reconciled.some((event) => event.diffCount >= 1)).toBe(false)
  })

  it('T-SA12-009：非白名单残差拒绝入账，白名单入账且幂等', () => {
    const h = harness()
    seedSaga(h, { sagaId: 'res-1' })

    let rejected: unknown
    try {
      recordResidual(h.ctx, { sagaId: 'res-1', compId: 'comp-bad', residualType: 'FEE', amount: 1 })
    } catch (error) {
      rejected = error
    }
    expect((rejected as { code?: string }).code).toBe('residual-not-whitelisted')
    expect(h.store.tx((tx) => tx.listResiduals('res-1'))).toHaveLength(0)

    const residualId = recordResidual(h.ctx, {
      sagaId: 'res-1',
      compId: 'comp-1',
      residualType: 'TIMING_LAG',
      amount: 0.5,
    })
    expect(residualId).toBe('res:comp-1')
    expect(h.store.tx((tx) => tx.listResiduals('res-1'))).toHaveLength(1)
    expect(h.events.residualRecorded).toHaveLength(1)

    // 重复入账同一 compId：返回同一 id，不重复插行。
    expect(
      recordResidual(h.ctx, {
        sagaId: 'res-1',
        compId: 'comp-1',
        residualType: 'TIMING_LAG',
        amount: 0.5,
      }),
    ).toBe(residualId)
    expect(h.store.tx((tx) => tx.listResiduals('res-1'))).toHaveLength(1)
  })

  it('T-SA12-010：日终勾稽差异率 0.1% 告警 / 0.5% P0', async () => {
    const alertCase = harness()
    seedSaga(alertCase, { sagaId: 'res-1' })
    recordResidual(alertCase.ctx, {
      sagaId: 'res-1',
      compId: 'comp-1',
      residualType: 'MIN_FEE',
      amount: 1_002,
    })
    const alertRate = await dayEndResidualDiff(
      alertCase.ctx,
      async () => [{ residualId: 'res:comp-1', amount: 1_000 }],
      alertCase.sink,
    )
    expect(alertRate).toBeCloseTo(0.002, 6)
    expect(alertCase.alerts.map((alert) => alert.level)).toEqual(['P1'])

    const p0Case = harness()
    seedSaga(p0Case, { sagaId: 'res-2' })
    recordResidual(p0Case.ctx, {
      sagaId: 'res-2',
      compId: 'comp-2',
      residualType: 'MIN_FEE',
      amount: 1_010,
    })
    const p0Rate = await dayEndResidualDiff(
      p0Case.ctx,
      async () => [{ residualId: 'res:comp-2', amount: 1_000 }],
      p0Case.sink,
    )
    expect(p0Rate).toBeCloseTo(0.01, 6)
    expect(p0Case.alerts.map((alert) => alert.level)).toEqual(['P0'])

    const cleanCase = harness()
    seedSaga(cleanCase, { sagaId: 'res-3' })
    recordResidual(cleanCase.ctx, {
      sagaId: 'res-3',
      compId: 'comp-3',
      residualType: 'MIN_FEE',
      amount: 1_000,
    })
    expect(
      await dayEndResidualDiff(
        cleanCase.ctx,
        async () => [{ residualId: 'res:comp-3', amount: 1_000 }],
        cleanCase.sink,
      ),
    ).toBe(0)
    expect(cleanCase.alerts).toHaveLength(0)
  })
})
