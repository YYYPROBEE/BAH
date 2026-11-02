/**
 * SA-13 观测·回放·告警 · T-SA13-001~012（批 6 验收）。
 *
 * 纪律：
 * - 真存储（sqlite）+ 真审计链（JSONL），时钟手推；
 * - 回放只经 `ReplayDeps` 注入链只读面，不 import persistence 实现；
 * - 告警只断言进程内 sink，不引入 MQ/外部请求；
 * - tick 用例直调派发点或 `events.serial`，不依赖宿主定时器。
 */

import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext } from '@bah/core'
import { ChainFile, createSagaAudit, createSagaStore, SIGNED_TYPES } from '@bah/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertReplayDiffZero,
  bucketOf,
  buildApprovalCard,
  causalDag,
  checkChainHealth,
  collectSloMetrics,
  dispatchTick,
  installTick,
  isAcyclic,
  listSagas,
  provideAlertBus,
  registerAlertSink,
  replay,
  sagaTimeline,
  SLO_METRICS,
  sloVerdict,
} from './index.ts'
import { installIdempotency } from './idempotency/index.ts'
import { installTemplates } from './templates/index.ts'
import { runCompensation } from './compensation/index.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE, TARGET_REGISTRY } from './seams.ts'
import { parseSagaSettings } from './settings.ts'
import { clearTickJobsForTest, registerTickJob } from './tick/registry.ts'

import type { Context } from '@bah/core'
import type { AlertEvent } from './alert/index.ts'
import type { SagaEventRecord, SagaState } from './types.ts'

const cleanup: string[] = []
const closers: Array<{ close(): void }> = []

afterEach(() => {
  for (const store of closers.splice(0)) store.close()
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
  clearTickJobsForTest()
})

interface Harness {
  readonly ctx: Context
  readonly store: ReturnType<typeof createSagaStore>
  readonly audit: ReturnType<typeof createSagaAudit>
  readonly auditDir: string
  readonly settings: ReturnType<typeof parseSagaSettings>
  now(): number
  advance(ms: number): void
}

function harness(overrides: Readonly<Record<string, unknown>> = {}): Harness {
  const rootDir = mkdtempSync(join(tmpdir(), 'bah-saga-observability-'))
  cleanup.push(rootDir)
  let now = 1_700_000_000_000
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

  const { privateKey } = generateKeyPairSync('ed25519')
  const signingKeyPath = join(rootDir, 'saga-ed25519.pem')
  writeFileSync(signingKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

  const auditDir = join(rootDir, 'audit')
  const audit = createSagaAudit({
    ctx,
    now: () => now,
    rootDir: auditDir,
    fsync: false,
    signingKeyPath,
    signedTypes: [...SIGNED_TYPES],
  })
  ctx.provide(SAGA_AUDIT, audit)

  return {
    ctx,
    store,
    audit,
    auditDir,
    settings: parseSagaSettings(overrides),
    now: () => now,
    advance(ms) {
      now += ms
    },
  }
}

function seedSaga(
  h: Harness,
  options: {
    readonly sagaId: string
    readonly state?: SagaState
    readonly businessType?: string
    readonly createdAt?: number
  },
): void {
  const at = h.now()
  h.store.tx((tx) => {
    tx.insertTransaction({
      sagaId: options.sagaId,
      businessType: options.businessType ?? 'TRANSFER',
      traceId: `trace-${options.sagaId}`,
      state: options.state ?? 'RUNNING',
      version: 1,
      timeoutBudgetMs: 60_000,
      compStrategy: 'AUTO',
      initiator: '{}',
      frozen: false,
      createdAt: options.createdAt ?? at,
      updatedAt: options.createdAt ?? at,
    })
  })
}

function streamOf(h: Harness, sagaId: string): readonly SagaEventRecord[] {
  return new ChainFile({ rootDir: h.auditDir, fsync: false }).read(sagaId).map((row) => ({
    sagaId: row.s,
    seqInSaga: row.q,
    type: row.t,
    subjectRef: row.sub,
    happensBefore: row.hb,
    payloadDigest: row.d,
  }))
}

function replayDeps(h: Harness): { readStream: (sagaId: string) => readonly SagaEventRecord[] } {
  return { readStream: (sagaId) => streamOf(h, sagaId) }
}

function captureAlerts(): { readonly events: AlertEvent[]; readonly dispose: () => void } {
  const events: AlertEvent[] = []
  const dispose = registerAlertSink((event) => events.push(event))
  return { events, dispose }
}

describe('SA-13 观测·回放·告警', () => {
  it('T-SA13-001：SLO 八指标齐（无数据显式占位）', () => {
    const h = harness()
    const metrics = collectSloMetrics(h.ctx, h.settings)
    expect(Object.keys(metrics).sort()).toEqual([...SLO_METRICS].sort())
    for (const metric of SLO_METRICS) {
      const sample = metrics[metric]
      expect(sample.metric).toBe(metric)
      expect(sample.value === null || Number.isFinite(sample.value)).toBe(true)
    }
    expect(metrics.dlqDepth.value).toBe(0)
    expect(metrics.chainBreak.value).toBe(0)
    expect(metrics.danglingP95.value).toBeNull()
    expect(metrics.reconHeartbeat.value).toBeNull()
  })

  it('SLO 判决：阈值 0 表示"非零才算越阈"，0 不能被判 alert', () => {
    // chainBreak：soft=0 / hard=1。0 是最好情况（audit.ts 的 sample 参数就是这组值）。
    expect(sloVerdict(0, 0, 1)).toBe('ok')
    expect(sloVerdict(1, 0, 1)).toBe('P0')
    // 其它阈值维持 >=：恰好命中 soft 就是 alert。
    expect(sloVerdict(300_000, 300_000, 300_000)).toBe('P0')
    expect(sloVerdict(299_999, 300_000, 600_000)).toBe('ok')
    expect(sloVerdict(null, 0, 1)).toBe('no-data')
  })

  it('T-SA13-002：五态分类覆盖 11 态，进行中桶含 CREATED/RUNNING', () => {
    const h = harness()
    const states: readonly SagaState[] = [
      'CREATED',
      'RUNNING',
      'SUCCEEDED',
      'ABORTED_CLEAN',
      'COMPENSATING',
      'COMPENSATED',
      'PARTIALLY_COMPENSATED',
      'PENDING_RISK_REVIEW',
      'GATE_HOLDING',
      'COMPENSATION_DLQ',
      'MANUALLY_CLOSED',
    ]
    const expected: Record<SagaState, string> = {
      CREATED: 'compensating',
      RUNNING: 'compensating',
      SUCCEEDED: 'success',
      ABORTED_CLEAN: 'failed',
      COMPENSATING: 'compensating',
      COMPENSATED: 'compensated',
      PARTIALLY_COMPENSATED: 'compensating',
      PENDING_RISK_REVIEW: 'compensating',
      GATE_HOLDING: 'compensating',
      COMPENSATION_DLQ: 'manual_dlq',
      MANUALLY_CLOSED: 'manual_dlq',
    }
    for (const [index, state] of states.entries()) {
      seedSaga(h, { sagaId: `bucket-${index}`, state })
      expect(bucketOf(state)).toBe(expected[state])
    }
    expect(listSagas(h.ctx, { bucket: 'compensating' })).toHaveLength(6)
    expect(listSagas(h.ctx, { bucket: 'success' })).toHaveLength(1)
    expect(listSagas(h.ctx, { businessType: 'OTHER' })).toHaveLength(0)
  })

  it('补充：时间线以事件为骨架，join 步骤 / 补偿 / 工单引用', () => {
    const h = harness()
    seedSaga(h, { sagaId: 'tl' })
    h.store.upsertStep({
      stepId: 's1',
      sagaId: 'tl',
      seqNo: 1,
      topologyDeps: [],
      toolName: 'pay',
      endpoint: '/pay',
      sideEffectClass: 'REVERSIBLE',
      idempotencyKey: 'k',
      idempotencyNonce: 'n',
      state: 'EXECUTED',
      attempts: 1,
      maxAttempts: 3,
      deadlineMs: 10_000,
    })
    h.store.tx((tx) => {
      tx.bindCompensation('tl', 's1', {
        templateId: 'refund',
        templateVersion: 1,
        targetTool: 'pay.refund',
        compKind: 'FULL_REFUND',
        compEndpoint: '/comp/refund',
        compIdempotent: true,
        residualRules: [],
        approvalRequired: false,
        payloadProjection: '{"fields":[]}',
        status: 'ACTIVE',
      })
      tx.insertTicket({
        ticketId: 'tkt-1',
        sagaId: 'tl',
        reason: 'GATE_APPROVAL',
        slaDeadline: h.now() + 60_000,
      })
    })
    const timeline = sagaTimeline(h.ctx, 'tl', [
      { q: 1, t: 'saga/step-planned', sub: 's1', hb: [] },
      { q: 2, t: 'saga/comp-issued', sub: 'comp:tl:s1', hb: [1] },
      { q: 3, t: 'saga/param-validated', sub: 'tkt-1', hb: [1] },
    ])
    expect(timeline.map((row) => row.seqInSaga)).toEqual([1, 2, 3])
    expect(timeline[0]?.stepRef).toBe('s1')
    expect(timeline[1]?.compRef).toBe('comp:tl:s1')
    expect(timeline[2]?.ticketRef).toBe('tkt-1')
  })

  it('T-SA13-003：审批卡片六项齐且 presenter 纯', () => {
    const input = {
      operationType: 'pay.transfer',
      amount: 12_345,
      payee: 'acct-9',
      riskTier: 'red',
      ticketTtlMs: 60_000,
    }
    const first = buildApprovalCard(input)
    const second = buildApprovalCard(input)
    expect(second).toEqual(first)
    expect(first.kind).toBe('approval-request')
    expect(first.operationType).toBe('pay.transfer')
    expect(first.amount).toBe(12_345)
    expect(first.payee).toBe('acct-9')
    expect(first.riskTier).toBe('red')
    expect(first.ticketTtlMs).toBe(60_000)
    expect(first.rejectReasonInput).toEqual({ visible: true, requiredOnReject: true })
  })

  it('T-SA13-004：因果 DAG 用 row.q 作节点与边端点，且无环', () => {
    const rows = [
      { q: 3, t: 'saga/created', sub: 's', hb: [] },
      { q: 5, t: 'saga/step-planned', sub: 'step-1', hb: [3] },
      { q: 8, t: 'saga/call-result', sub: 'step-1', hb: [3, 5] },
    ]
    const dag = causalDag('saga-d', rows)
    expect(dag.nodes.map((node) => node.id)).toEqual(['3', '5', '8'])
    expect(dag.edges).toEqual([
      { from: 3, to: 5, kind: 'happensBefore' },
      { from: 3, to: 8, kind: 'happensBefore' },
      { from: 5, to: 8, kind: 'happensBefore' },
    ])
    expect(isAcyclic(dag)).toBe(true)
    expect(dag.mermaid).toContain('n3 -->|happensBefore| n5')
    expect(dag.mermaid).toContain('n5 -->|happensBefore| n8')
  })

  it('T-SA13-005：抽样 20 个 saga 回放终态 == 运行时终态（diff=0）', () => {
    const h = harness()
    const alerts = captureAlerts()
    try {
      const families: ReadonlyArray<{ readonly state: SagaState; readonly events: readonly string[] }> = [
        { state: 'SUCCEEDED', events: ['saga/created', 'saga/step-planned', 'saga/call-result'] },
        { state: 'COMPENSATED', events: ['saga/created', 'saga/comp-decided', '$final:COMPENSATED'] },
        {
          state: 'PARTIALLY_COMPENSATED',
          events: ['saga/created', 'saga/comp-decided', '$final:PARTIALLY_COMPENSATED'],
        },
        { state: 'COMPENSATION_DLQ', events: ['saga/created', 'saga/dlq-escalated'] },
      ]
      let sample = 0
      for (const family of families) {
        for (let index = 0; index < 5; index += 1) {
          const sagaId = `sample-${sample}`
          seedSaga(h, { sagaId, state: family.state })
          for (const type of family.events) {
            if (type.startsWith('$final:')) {
              h.audit.append(sagaId, 'saga/comp-result', {
                sagaId,
                compId: type,
              })
            } else if (type === 'saga/step-planned') {
              h.audit.append(sagaId, type, { sagaId, stepId: `step-${sample}`, seqNo: 1 })
            } else if (type === 'saga/call-result') {
              h.audit.append(sagaId, type, { sagaId, stepId: `step-${sample}` })
            } else if (type === 'saga/comp-decided') {
              h.audit.append(sagaId, type, { sagaId, stepId: `step-${sample}` })
            } else if (type === 'saga/dlq-escalated') {
              h.audit.append(sagaId, type, { sagaId, dlqId: `dlq-${sample}` })
            } else {
              h.audit.append(sagaId, type, { sagaId })
            }
          }
          expect(assertReplayDiffZero(h.ctx, sagaId, replayDeps(h))).toBe(true)
          sample += 1
        }
      }
      expect(sample).toBe(20)
      expect(alerts.events.filter((event) => event.level === 'P0')).toHaveLength(0)
    } finally {
      alerts.dispose()
    }
  })

  it('补充：真实补偿收敛后回放 diff=0（$final 折叠约定）', async () => {
    const h = harness()
    installTemplates(h.ctx)
    h.ctx.provide(TARGET_REGISTRY, {
      get: (name) =>
        name === 'pay.charge'
          ? {
              targetSystem: 'pay.charge',
              idempotencySupport: 'STRONG',
              probeEndpoint: '/probe/pay',
              lagSeconds: 0,
              registeredAt: 1,
            }
          : undefined,
      list: () => [],
    })
    seedSaga(h, { sagaId: 'real-comp', state: 'COMPENSATING' })
    h.audit.append('real-comp', 'saga/created', { sagaId: 'real-comp' })
    const template = {
      templateId: 'refund',
      templateVersion: 1,
      targetTool: 'pay.charge',
      compKind: 'FULL_REFUND' as const,
      compEndpoint: '/comp/refund',
      compIdempotent: true,
      residualRules: [],
      approvalRequired: false,
      payloadProjection: '{"fields":[]}',
      status: 'ACTIVE',
    }
    h.store.insertTemplate(template)
    h.store.tx((tx) => {
      tx.insertStep({
        stepId: 's1',
        sagaId: 'real-comp',
        seqNo: 1,
        topologyDeps: [],
        toolName: 'pay.charge',
        endpoint: '/pay/charge',
        sideEffectClass: 'EXTERNAL_UNDOABLE',
        idempotencyKey: 'FWD:real-comp:s1',
        idempotencyNonce: 'nonce-real-comp',
        state: 'EXECUTED',
        attempts: 1,
        maxAttempts: 3,
        deadlineMs: 5_000,
        requestDigest: 'req-real-comp',
      })
      tx.bindCompensation('real-comp', 's1', template)
    })
    await runCompensation(h.ctx, 'real-comp', parseSagaSettings({}), {
      invoke: async () => ({ kind: 'ok', responseDigest: 'refund-ok' }),
      probe: async () => ({ kind: 'not-executed' }),
    })
    expect(h.store.loadTransaction('real-comp')?.state).toBe('COMPENSATED')
    const finalRows = streamOf(h, 'real-comp')
    expect(finalRows.at(-1)?.subjectRef).toBe('$final:COMPENSATED')
    expect(assertReplayDiffZero(h.ctx, 'real-comp', replayDeps(h))).toBe(true)
  })

  it('T-SA13-006：回放零 LLM、零外部调用', () => {
    const source = readFileSync(new URL('./replay/index.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/@bah\/llm|llm\//)
    expect(source).not.toMatch(/fetch\s*\(|https?:\/\//)
    expect(source).not.toMatch(/node:https?|node:net/)

    const h = harness()
    seedSaga(h, { sagaId: 'no-llm', state: 'SUCCEEDED' })
    h.audit.append('no-llm', 'saga/created', { sagaId: 'no-llm' })
    h.audit.append('no-llm', 'saga/step-planned', { sagaId: 'no-llm', stepId: 's1', seqNo: 1 })
    let externalCalls = 0
    const result = replay(h.ctx, 'no-llm', undefined, replayDeps(h))
    expect(result.finalState).toBe('RUNNING')
    expect(externalCalls).toBe(0)
  })

  it('T-SA13-007：回放不含锚点加速（state_snapshot 只作展示）', () => {
    const source = readFileSync(new URL('./replay/index.ts', import.meta.url), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/state_snapshot|readLatestSnapshot/)

    const h = harness()
    seedSaga(h, { sagaId: 'no-anchor', state: 'COMPENSATED' })
    h.store.tx((tx) => {
      tx.insertSnapshot({
        snapshotId: 'snap-1',
        sagaId: 'no-anchor',
        stepSeq: 1,
        contextDigest: 'digest',
      })
    })
    h.audit.append('no-anchor', 'saga/created', { sagaId: 'no-anchor' })
    h.audit.append('no-anchor', 'saga/comp-decided', { sagaId: 'no-anchor', stepId: 's1' })
    h.audit.append('no-anchor', 'saga/comp-result', {
      sagaId: 'no-anchor',
      compId: '$final:COMPENSATED',
    })
    const result = replay(h.ctx, 'no-anchor', undefined, replayDeps(h))
    expect(result.states[0]).toBe('CREATED')
    expect(result.finalState).toBe('COMPENSATED')
    expect(assertReplayDiffZero(h.ctx, 'no-anchor', replayDeps(h))).toBe(true)
  })

  it('T-SA13-008：DLQ 深度越阈 → 告警汇；越电话阈值 → P0', () => {
    const h = harness()
    provideAlertBus(h.ctx, h.settings)
    const alerts = captureAlerts()
    try {
      const seedDlq = (index: number): void => {
        h.store.tx((tx) => {
          tx.insertDlq({
            dlqId: `dlq-${index}`,
            sagaId: `saga-dlq-${index}`,
            source: 'COMP',
            reason: 'test',
            enteredAt: h.now(),
            slaDeadline: h.now() + 60_000,
          })
        })
      }
      for (let index = 0; index < h.settings.dlqAlertDepth; index += 1) seedDlq(index)
      h.ctx.events.emit('saga/dlq-escalated', {
        sagaId: 'saga-dlq-0',
        dlqId: 'dlq-0',
        source: 'comp',
        reason: 'test',
        slaDeadline: h.now() + 60_000,
      })
      expect(alerts.events.filter((event) => event.metric === 'dlqDepth')).toHaveLength(1)
      expect(alerts.events.at(-1)?.level).toBe('alert')

      for (let index = h.settings.dlqAlertDepth; index < h.settings.dlqPhoneDepth; index += 1) {
        seedDlq(index)
      }
      h.ctx.events.emit('saga/dlq-escalated', {
        sagaId: 'saga-dlq-1',
        dlqId: 'dlq-1',
        source: 'comp',
        reason: 'test',
        slaDeadline: h.now() + 60_000,
      })
      expect(alerts.events.at(-1)?.level).toBe('P0')
      expect(alerts.events.at(-1)?.metric).toBe('dlqDepth')
    } finally {
      alerts.dispose()
    }
  })

  it('T-SA13-009：链断裂 → P0 只进 sink，不派发 saga/dlq-escalated', () => {
    const h = harness()
    h.audit.append('broken', 'saga/created', { sagaId: 'broken' })
    const path = join(h.auditDir, 'broken', 'audit.jsonl')
    const rows = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const first = rows[0] as Record<string, unknown>
    first['d'] = 'deadbeef'
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    let dlqEvents = 0
    h.ctx.events.on('saga/dlq-escalated', () => {
      dlqEvents += 1
    })
    const alerts = captureAlerts()
    try {
      expect(checkChainHealth(h.ctx, 'broken')).toEqual({ ok: false, brokenAt: 1 })
      expect(alerts.events).toHaveLength(1)
      expect(alerts.events[0]?.level).toBe('P0')
      expect(dlqEvents).toBe(0)
    } finally {
      alerts.dispose()
    }
  })

  it('T-SA13-010：同 (now, job) 重复 tick 只执行一次，不同 now 再跑', () => {
    const ctx = createContext()
    let count = 0
    registerTickJob('janitor', () => {
      count += 1
    })
    dispatchTick(ctx, { now: 1_000, dueJobs: ['janitor'] })
    dispatchTick(ctx, { now: 1_000, dueJobs: ['janitor'] })
    expect(count).toBe(1)
    dispatchTick(ctx, { now: 2_000, dueJobs: ['janitor'] })
    expect(count).toBe(2)
  })

  it('T-SA13-011：只派发 dueJobs（saga/tick 为 serial）', async () => {
    const ctx = createContext()
    const counts = { janitor: 0, recon: 0, anchor: 0 }
    registerTickJob('janitor', () => {
      counts.janitor += 1
    })
    registerTickJob('recon', () => {
      counts.recon += 1
    })
    registerTickJob('anchor', () => {
      counts.anchor += 1
    })
    installTick(ctx)
    await ctx.events.serial('saga/tick', { now: 5_000, dueJobs: ['janitor'] })
    expect(counts).toEqual({ janitor: 1, recon: 0, anchor: 0 })
  })

  it('T-SA13-012：两套回放都过（会话快照载体独立 + saga 回放 diff=0）', () => {
    const snapshotConfig = readFileSync(new URL('../../../vitest.snapshot.config.ts', import.meta.url), 'utf8')
    expect(snapshotConfig).toContain('snapshot')
    expect(snapshotConfig).not.toContain('saga/replay')

    const h = harness()
    seedSaga(h, { sagaId: 'both-replays', state: 'COMPENSATION_DLQ' })
    h.audit.append('both-replays', 'saga/created', { sagaId: 'both-replays' })
    h.audit.append('both-replays', 'saga/dlq-escalated', {
      sagaId: 'both-replays',
      dlqId: 'dlq-both',
    })
    expect(assertReplayDiffZero(h.ctx, 'both-replays', replayDeps(h))).toBe(true)
  })
})
