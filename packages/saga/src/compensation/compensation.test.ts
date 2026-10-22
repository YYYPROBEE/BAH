/**
 * T-SA10-005~008 / 014 / 015 / 017：反向屏障补偿调度（SA-10 批 4 执行面）。
 *
 * 全部用例使用真实 `:memory:` store（不 mock 持久化），只注入假审计 / 时钟 /
 * 目标登记 / 补偿通道——补偿调用与探诊都不发起真实网络。
 */

import { createContext } from '@bah/core'
import { createSagaStore } from '@bah/persistence'
import { describe, expect, it } from 'vitest'

import { installIdempotency } from '../idempotency/index.ts'
import { mustDeadLetter } from '../probe/classify.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE, TARGET_REGISTRY } from '../seams.ts'
import { parseSagaSettings } from '../settings.ts'
import { installTemplates, registerTemplate } from '../templates/index.ts'
import {
  barrierCheck,
  compBackoffDelay,
  downstreamOf,
  issueComp,
  reverseLayers,
  runCompensation,
} from './index.ts'

import type { Context } from '@bah/core'
import type { CallOutcome } from '../probe/settle.ts'
import type { SagaAudit, TargetRegistry } from '../seams.ts'
import type {
  CompTemplate,
  SideEffectClass,
  StepState,
  TargetSystem,
} from '../types.ts'
import type { CompensationDeps } from './index.ts'

interface AuditRow {
  readonly sagaId: string
  readonly type: string
  readonly data: unknown
}

interface Harness {
  readonly ctx: Context
  readonly store: ReturnType<typeof createSagaStore>
  readonly audits: AuditRow[]
  readonly sleeps: number[]
}

const SETTINGS = parseSagaSettings({})

function target(targetSystem: string, probeEndpoint: string | undefined): TargetSystem {
  return {
    targetSystem,
    idempotencySupport: 'STRONG',
    probeEndpoint,
    lagSeconds: 0,
    registeredAt: 1,
  }
}

function harness(targets: readonly TargetSystem[] = []): Harness {
  let now = 10_000
  const store = createSagaStore({ dbPath: ':memory:', now: () => now })
  const ctx = createContext()
  const audits: AuditRow[] = []
  const sleeps: number[] = []

  const audit: SagaAudit = {
    append(sagaId, type, data) {
      audits.push({ sagaId, type, data })
      return { seqInSaga: audits.length, recordHash: `hash-${audits.length}` }
    },
    verify: () => ({ ok: true }),
    anchor: async () => ({ merkleRoot: 'root', targets: [] }),
  }
  const registry: TargetRegistry = {
    get: (name) => targets.find((item) => item.targetSystem === name),
    list: () => targets,
  }

  ctx.provide(SAGA_STORE, store)
  ctx.provide(SAGA_AUDIT, audit)
  ctx.provide(SAGA_CLOCK, {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  })
  ctx.provide(TARGET_REGISTRY, registry)
  installIdempotency(ctx)
  installTemplates(ctx)

  return { ctx, store, audits, sleeps }
}

interface StepSpec {
  readonly stepId: string
  readonly toolName?: string
  readonly topologyDeps?: readonly string[]
  readonly state?: StepState
  readonly sideEffectClass?: SideEffectClass
  readonly seqNo?: number
  readonly requestDigest?: string
}

function seedSaga(store: Harness['store'], sagaId: string, specs: readonly StepSpec[]): void {
  store.tx((tx) => {
    tx.insertTransaction({
      sagaId,
      businessType: 'TRANSFER',
      traceId: `trace-${sagaId}`,
      state: 'COMPENSATING',
      version: 2,
      timeoutBudgetMs: 60_000,
      compStrategy: 'AUTO',
      initiator: '{}',
      frozen: false,
      createdAt: 1,
      updatedAt: 1,
    })
    specs.forEach((spec, index) => {
      const toolName = spec.toolName ?? 'pay.charge'
      tx.insertStep({
        stepId: spec.stepId,
        sagaId,
        seqNo: spec.seqNo ?? index + 1,
        topologyDeps: spec.topologyDeps ?? [],
        toolName,
        endpoint: `/tool/${toolName}`,
        sideEffectClass: spec.sideEffectClass ?? 'EXTERNAL_UNDOABLE',
        idempotencyKey: `FWD:${sagaId}:${spec.stepId}`,
        idempotencyNonce: `nonce-${sagaId}-${spec.stepId}`,
        state: spec.state ?? 'EXECUTED',
        attempts: 1,
        maxAttempts: 3,
        deadlineMs: 5_000,
        requestDigest: spec.requestDigest ?? `req-${sagaId}-${spec.stepId}`,
      })
    })
  })
}

function defaultTemplate(overrides: Partial<CompTemplate> = {}): CompTemplate {
  return {
    templateId: 'refund-template',
    templateVersion: 1,
    targetTool: 'pay.charge',
    compKind: 'FULL_REFUND',
    compEndpoint: '/comp/refund',
    compIdempotent: true,
    residualRules: ['FEE'],
    approvalRequired: false,
    payloadProjection: JSON.stringify({
      fields: [{ from: 'requestDigest', to: 'refund.requestDigest', default: 'none' }],
    }),
    status: 'ACTIVE',
    ...overrides,
  }
}

/** 注册模板（版本冻结来源）并写入计划期绑定（`compensating_action` 行）。 */
function bindComps(
  harness: Harness,
  sagaId: string,
  stepIds: readonly string[],
  template: CompTemplate = defaultTemplate(),
): void {
  if (harness.store.readTemplate(template.templateId, template.templateVersion) === undefined) {
    registerTemplate(harness.ctx, template)
  }
  harness.store.tx((tx) => {
    for (const stepId of stepIds) tx.bindCompensation(sagaId, stepId, template)
  })
}

function stepOf(harness: Harness, sagaId: string, stepId: string) {
  return harness.store.tx((tx) => {
    const step = tx.readStep(stepId)
    if (step === undefined) throw new Error(`step missing: ${sagaId}/${stepId}`)
    return step
  })
}

function compOf(harness: Harness, sagaId: string, stepId: string) {
  return harness.store.tx((tx) =>
    tx.listCompensations(sagaId).find((comp) => comp.stepId === stepId),
  )
}

/** 记录发射与并发峰值的补偿通道。 */
function recordingDeps(
  outcomeFor: () => CallOutcome,
  waitMs = 0,
): { deps: CompensationDeps; invokes: () => number; peak: () => number } {
  let invokes = 0
  let active = 0
  let peak = 0
  return {
    deps: {
      invoke: async () => {
        invokes += 1
        active += 1
        peak = Math.max(peak, active)
        try {
          if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
          else await Promise.resolve()
          return outcomeFor()
        } finally {
          active -= 1
        }
      },
      probe: async () => ({ kind: 'not-executed' }),
    },
    invokes: () => invokes,
    peak: () => peak,
  }
}

describe('反向屏障补偿调度（SA-10 执行面）', () => {
  it('T-SA10-005：逆拓扑分层——下游汇点层先补偿、上游后补偿，层内无相互依赖', () => {
    const h = harness()
    seedSaga(h.store, 'saga-1', [
      { stepId: 'a', seqNo: 1, topologyDeps: [] },
      { stepId: 'b', seqNo: 2, topologyDeps: ['a'] },
      { stepId: 'c', seqNo: 3, topologyDeps: ['b'] },
      { stepId: 'd', seqNo: 4, topologyDeps: ['a'] },
      { stepId: 'e', seqNo: 5, topologyDeps: ['b'], state: 'FAILED' },
    ])
    const steps = h.store.listSteps('saga-1')
    const layers = reverseLayers(steps)

    // 补偿顺序 = 逆拓扑：c/d（汇点）→ b → a；FAILED 的 e 不参与。
    expect(layers.map((layer) => layer.map((step) => step.stepId))).toEqual([
      ['c', 'd'],
      ['b'],
      ['a'],
    ])

    // 同一层内不存在「谁依赖谁」（直接或传递）。
    for (const layer of layers) {
      const members = new Set(layer.map((step) => step.stepId))
      for (const step of layer) {
        const downstream = downstreamOf(steps, step.stepId)
        expect(downstream.some((id) => members.has(id))).toBe(false)
      }
    }

    // 任一依赖边两端必在不同层，且被依赖者（上游）在更后一层。
    const layerOf = new Map<string, number>()
    layers.forEach((layer, index) => {
      for (const step of layer) layerOf.set(step.stepId, index)
    })
    for (const step of steps) {
      for (const dep of step.topologyDeps) {
        if (!layerOf.has(dep) || !layerOf.has(step.stepId)) continue
        expect(layerOf.get(dep)!).toBeGreaterThan(layerOf.get(step.stepId)!)
      }
    }

    expect([...downstreamOf(steps, 'a')].sort()).toEqual(['b', 'c', 'd', 'e'])
  })

  it('T-SA10-006：自动路径下游未收敛 → barrier-violation，发射被拦并落审计', async () => {
    const h = harness([target('pay.charge', '/probe/pay')])
    seedSaga(h.store, 'saga-1', [
      { stepId: 's1', seqNo: 1, topologyDeps: [] },
      { stepId: 's2', seqNo: 2, topologyDeps: ['s1'] },
    ])
    bindComps(h, 'saga-1', ['s1', 's2'])

    const settings = parseSagaSettings({
      maxAttempts: 1,
      compBackoff: { baseMs: 10, maxMs: 20, jitter: 0 },
    })
    const recorder = recordingDeps(() => ({ kind: 'err', code: 'HTTP_400' }))

    await expect(runCompensation(h.ctx, 'saga-1', settings, recorder.deps)).rejects.toMatchObject({
      code: 'barrier-violation',
    })

    // 只发射过下游 s2（1 次），上游 s1 被屏障拦在 comp-issued 之前。
    expect(recorder.invokes()).toBe(1)
    const barrier = h.audits.find(
      (row) =>
        row.type === 'saga/comp-result' &&
        (row.data as { readonly reason?: string }).reason === 'barrier-violation',
    )
    expect(barrier?.data).toMatchObject({
      sagaId: 'saga-1',
      pending: ['comp:saga-1:s2'],
    })
    expect(compOf(h, 'saga-1', 's2')?.state).toBe('DLQ')
  })

  it('T-SA10-007：手动路径复用同一 issueComp/barrierCheck，无绕过口', async () => {
    const h = harness([target('pay.charge', '/probe/pay')])
    seedSaga(h.store, 'saga-1', [
      { stepId: 's1', seqNo: 1, topologyDeps: [] },
      { stepId: 's2', seqNo: 2, topologyDeps: ['s1'] },
    ])
    bindComps(h, 'saga-1', ['s1', 's2'])

    const recorder = recordingDeps(() => ({ kind: 'ok', responseDigest: 'manual-ok' }))
    let issued = 0
    h.ctx.events.on('saga/comp-issued', () => {
      issued += 1
    })

    // 手动入口就是同一个 barrierCheck：直接调用即被拒。
    expect(() => barrierCheck(h.ctx, 'saga-1', 's1')).toThrowError(/barrier-violation/)

    // 手动补偿 API 同样只经 issueComp，未推进 s2 之前不允许发射 s1。
    await expect(
      issueComp(h.ctx, 'saga-1', stepOf(h, 'saga-1', 's1'), SETTINGS, recorder.deps),
    ).rejects.toMatchObject({
      code: 'barrier-violation',
      detail: { pending: ['comp:saga-1:s2'] },
    })

    expect(issued).toBe(0)
    expect(recorder.invokes()).toBe(0)
    expect(compOf(h, 'saga-1', 's1')?.state).toBe('PENDING')
  })

  it('T-SA10-008：层内并行度不超过 maxParallelBranches', async () => {
    const h = harness([target('pay.charge', '/probe/pay')])
    seedSaga(
      h.store,
      'saga-1',
      ['s1', 's2', 's3', 's4'].map((stepId, index) => ({
        stepId,
        seqNo: index + 1,
        topologyDeps: [],
      })),
    )
    bindComps(h, 'saga-1', ['s1', 's2', 's3', 's4'])

    const settings = parseSagaSettings({ maxParallelBranches: 2 })
    const recorder = recordingDeps(() => ({ kind: 'ok', responseDigest: 'ok' }), 5)

    await runCompensation(h.ctx, 'saga-1', settings, recorder.deps)

    expect(recorder.peak()).toBe(2)
    expect(recorder.peak()).toBeLessThanOrEqual(settings.maxParallelBranches)
    expect(recorder.invokes()).toBe(4)
    for (const stepId of ['s1', 's2', 's3', 's4']) {
      expect(compOf(h, 'saga-1', stepId)?.state).toBe('OK')
    }
  })

  it('T-SA10-014：退避序列确定性、含 seeded 抖动、增长后封顶 maxMs', () => {
    const backoff = { baseMs: 1_000, maxMs: 8_000, jitter: 0.5 }
    const attempts = [0, 1, 2, 3, 4, 5, 6]

    const first = attempts.map((attempt) => compBackoffDelay(backoff, attempt, 42))
    const replay = attempts.map((attempt) => compBackoffDelay(backoff, attempt, 42))
    const otherSeed = attempts.map((attempt) => compBackoffDelay(backoff, attempt, 43))

    // 同种子逐位一致；换种子只改变抖动。
    expect(first).toEqual(replay)
    expect(otherSeed).not.toEqual(first)

    // attempts ≤ 0 无退避；序列单调不减；到顶后严格等于 maxMs。
    expect(first[0]).toBe(0)
    for (let index = 1; index < first.length - 1; index += 1) {
      expect(first[index]!).toBeLessThanOrEqual(first[index + 1]!)
    }
    expect(first[first.length - 1]).toBe(backoff.maxMs)
    expect(first[1]!).toBeGreaterThanOrEqual(backoff.baseMs)
    expect(first[1]!).toBeLessThanOrEqual(backoff.maxMs)

    // 含 jitter：至少一个非封顶值与无抖动的指数值不同。
    const raw = [0, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]
    expect(first.some((delay, index) => index > 0 && delay !== raw[index])).toBe(true)

    // 无抖动时严格等于指数值（可复核的确定性）。
    expect(compBackoffDelay({ baseMs: 1_000, maxMs: 8_000, jitter: 0 }, 3, 7)).toBe(4_000)
  })

  it('T-SA10-015：attempts ≥ maxAttempts 强制 DLQ，invoke 零调用且不可配置关闭', async () => {
    const h = harness([target('pay.charge', '/probe/pay')])
    seedSaga(h.store, 'saga-1', [{ stepId: 's1', seqNo: 1, topologyDeps: [] }])
    bindComps(h, 'saga-1', ['s1'])

    const settings = parseSagaSettings({ maxAttempts: 3 })
    const bound = compOf(h, 'saga-1', 's1')
    expect(bound).toBeDefined()
    h.store.tx((tx) => tx.updateCompensation({ ...bound!, attempts: 3, maxAttempts: 3 }))

    const recorder = recordingDeps(() => ({ kind: 'ok', responseDigest: 'must-not-happen' }))
    let issued = 0
    h.ctx.events.on('saga/comp-issued', () => {
      issued += 1
    })

    await issueComp(h.ctx, 'saga-1', stepOf(h, 'saga-1', 's1'), settings, recorder.deps)

    expect(recorder.invokes()).toBe(0)
    expect(issued).toBe(0)
    expect(compOf(h, 'saga-1', 's1')?.state).toBe('DLQ')
    expect(h.store.tx((tx) => tx.readDlq('dlq:saga-1:s1'))).toMatchObject({
      source: 'COMP',
      reason: 'max-attempts',
    })

    // 硬停不可配置关闭：载入期拒绝 0 / 负数，纯函数熔断不受开关影响。
    expect(() => parseSagaSettings({ maxAttempts: 0 })).toThrowError(/maxAttempts/)
    expect(() => parseSagaSettings({ maxAttempts: -1 })).toThrowError(/maxAttempts/)
    expect(mustDeadLetter(3, 3)).toBe(true)
    expect(mustDeadLetter(2, 3)).toBe(false)
  })

  it('T-SA10-017：未登记目标 / 空探诊端点 → unknown-target DLQ，禁止自动补偿', async () => {
    // 情形一：目标完全未登记。
    const unknown = harness()
    seedSaga(unknown.store, 'saga-1', [{ stepId: 's1', seqNo: 1, topologyDeps: [] }])
    bindComps(unknown, 'saga-1', ['s1'])
    const first = recordingDeps(() => ({ kind: 'ok', responseDigest: 'must-not-happen' }))

    await issueComp(
      unknown.ctx,
      'saga-1',
      stepOf(unknown, 'saga-1', 's1'),
      parseSagaSettings({}),
      first.deps,
    )

    expect(first.invokes()).toBe(0)
    expect(compOf(unknown, 'saga-1', 's1')?.state).toBe('DLQ')
    expect(unknown.store.tx((tx) => tx.readDlq('dlq:saga-1:s1'))).toMatchObject({
      source: 'COMP',
      reason: 'unknown-target',
    })

    // 情形二：已登记但 probeEndpoint 为空字符串（等价于禁止自动补偿）。
    const empty = harness([target('pay.charge', '')])
    seedSaga(empty.store, 'saga-2', [{ stepId: 's1', seqNo: 1, topologyDeps: [] }])
    bindComps(empty, 'saga-2', ['s1'])
    const second = recordingDeps(() => ({ kind: 'ok', responseDigest: 'must-not-happen' }))

    await issueComp(
      empty.ctx,
      'saga-2',
      stepOf(empty, 'saga-2', 's1'),
      parseSagaSettings({}),
      second.deps,
    )

    expect(second.invokes()).toBe(0)
    expect(compOf(empty, 'saga-2', 's1')?.state).toBe('DLQ')
    expect(empty.store.tx((tx) => tx.readDlq('dlq:saga-2:s1'))).toMatchObject({
      source: 'COMP',
      reason: 'unknown-target',
    })
  })
})
