/**
 * 补偿发射口的四类「绝不」判决（补 `compensation.test.ts` 未触及的分支）：
 *
 * 1. 未注入 `CompensationDeps` → `comp-transport-missing`，绝不把"没通道"说成"已补偿"；
 * 2. 治理平面在 `saga/comp-decided` 拥有判决 → 零外呼、零发射、补偿行不推进；
 * 3. `NO_OP` 模板 → 就地记 OK，不发 `comp-issued`、不打外部端点；
 * 4. COMP 幂等键被他人占住时的两种分岔：同载荷 → `lease-held` 留 UNKNOWN（等下一轮），
 *    异载荷 → `key-conflict` 直接 DLQ（防"换个请求把同一笔退两次"）。
 *
 * 与既有用例同口径：真实 `:memory:` store，只注入假审计/时钟/目标登记/补偿通道。
 */

import { createContext } from '@bah/core'
import { createSagaStore } from '@bah/persistence'
import { describe, expect, it } from 'vitest'

import { installIdempotency } from '../idempotency/index.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_IDEMPOTENCY, SAGA_STORE, TARGET_REGISTRY } from '../seams.ts'
import { parseSagaSettings } from '../settings.ts'
import { installTemplates, registerTemplate } from '../templates/index.ts'
import { issueComp, runCompensation } from './index.ts'

import type { Context } from '@bah/core'
import type { CallOutcome } from '../probe/settle.ts'
import type { ProbeObservation, ProbeTransport } from '../probe/index.ts'
import type { SagaAudit, TargetRegistry } from '../seams.ts'
import type { CompTemplate, SideEffectClass, StepState, TargetSystem } from '../types.ts'
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
}

const SETTINGS = parseSagaSettings({})

/** 只投影快照摘要面的一个字段：让两次发射的指纹差异**只**来自有没有快照。 */
const SNAP_PROJECTION = JSON.stringify({
  fields: [{ from: 'contextDigest', to: 'context' }],
})

function target(targetSystem: string, probeEndpoint: string | undefined): TargetSystem {
  return {
    targetSystem,
    idempotencySupport: 'STRONG',
    probeEndpoint,
    lagSeconds: 0,
    registeredAt: 1,
  }
}

function harness(targets: readonly TargetSystem[] = [target('pay.charge', '/probe/pay')]): Harness {
  let now = 10_000
  const store = createSagaStore({ dbPath: ':memory:', now: () => now })
  const ctx = createContext()
  const audits: AuditRow[] = []

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
  ctx.provide(SAGA_CLOCK, { now: () => now, sleep: async () => undefined })
  ctx.provide(TARGET_REGISTRY, registry)
  installIdempotency(ctx)
  installTemplates(ctx)

  return { ctx, store, audits }
}

interface StepSpec {
  readonly stepId: string
  readonly toolName?: string
  readonly state?: StepState
  readonly sideEffectClass?: SideEffectClass
  readonly seqNo?: number
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
        topologyDeps: [],
        toolName,
        endpoint: `/tool/${toolName}`,
        sideEffectClass: spec.sideEffectClass ?? 'EXTERNAL_UNDOABLE',
        idempotencyKey: `FWD:${sagaId}:${spec.stepId}`,
        idempotencyNonce: `nonce-${sagaId}-${spec.stepId}`,
        state: spec.state ?? 'EXECUTED',
        attempts: 1,
        maxAttempts: 3,
        deadlineMs: 5_000,
        requestDigest: `req-${sagaId}-${spec.stepId}`,
      })
    })
  })
}

function template(overrides: Partial<CompTemplate> = {}): CompTemplate {
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

/** 注册模板并写入计划期冻结绑定（与既有用例同口径）。 */
function bindComps(
  h: Harness,
  sagaId: string,
  stepIds: readonly string[],
  comp: CompTemplate = template(),
): void {
  if (h.store.readTemplate(comp.templateId, comp.templateVersion) === undefined) {
    registerTemplate(h.ctx, comp)
  }
  h.store.tx((tx) => {
    for (const stepId of stepIds) tx.bindCompensation(sagaId, stepId, comp)
  })
}

function stepOf(h: Harness, sagaId: string, stepId: string) {
  return h.store.tx((tx) => {
    const step = tx.readStep(stepId)
    if (step === undefined) throw new Error(`step missing: ${sagaId}/${stepId}`)
    return step
  })
}

function compOf(h: Harness, sagaId: string, stepId: string) {
  return h.store.tx((tx) => tx.listCompensations(sagaId).find((item) => item.stepId === stepId))
}

function dlqOf(h: Harness, sagaId: string, stepId: string) {
  return h.store.tx((tx) => tx.readDlq(`dlq:${sagaId}:${stepId}`))
}

function depsFor(outcome: () => CallOutcome, probe?: ProbeTransport): { deps: CompensationDeps; invokes: () => number } {
  let invokes = 0
  const transport: ProbeTransport = probe ?? (async () => ({ kind: 'not-executed' }))
  return {
    deps: {
      invoke: async () => {
        invokes += 1
        return outcome()
      },
      probe: transport,
    },
    invokes: () => invokes,
  }
}

describe('补偿发射口的保险丝与并发分岔（SA-10 执行面补漏）', () => {
  it('未注入补偿通道 → comp-transport-missing，且绝不记成 OK、不落 DLQ', async () => {
    const h = harness()
    seedSaga(h.store, 'saga-no-deps', [{ stepId: 's1' }])
    bindComps(h, 'saga-no-deps', ['s1'])

    await expect(
      issueComp(h.ctx, 'saga-no-deps', stepOf(h, 'saga-no-deps', 's1'), SETTINGS),
    ).rejects.toMatchObject({ code: 'comp-transport-missing' })

    // 发射闸门已提交（ISSUED + comp-issued 审计），但收敛面没被伪造：
    // 既不是 OK（没退成功），也不是 DLQ（没人判定放弃），留给下一轮/人工。
    expect(compOf(h, 'saga-no-deps', 's1')?.state).toBe('ISSUED')
    expect(dlqOf(h, 'saga-no-deps', 's1')).toBeUndefined()
    expect(h.audits.some((row) => row.type === 'saga/comp-result')).toBe(false)
  })

  it('编排入口同样默认 fail-loud（runCompensation 省略 deps 不静默收敛）', async () => {
    const h = harness()
    seedSaga(h.store, 'saga-orch-no-deps', [{ stepId: 's1' }])
    bindComps(h, 'saga-orch-no-deps', ['s1'])

    await expect(runCompensation(h.ctx, 'saga-orch-no-deps', SETTINGS)).rejects.toMatchObject({
      code: 'comp-transport-missing',
    })
    // 终态收敛没有把这笔说成补偿完成。
    expect(h.store.loadTransaction('saga-orch-no-deps')?.state).toBe('COMPENSATING')
  })

  it('治理平面拥有 comp-decided 判决（非 compensate）→ 零外呼、零发射、补偿行不推进', async () => {
    const h = harness()
    seedSaga(h.store, 'saga-veto', [{ stepId: 's1' }])
    bindComps(h, 'saga-veto', ['s1'])

    // 不调 next() 即拥有判决（waterfall 的短路形态）。
    h.ctx.events.on('saga/comp-decided', (value) => ({ ...value, decide: 'hold' }))

    let issued = 0
    h.ctx.events.on('saga/comp-issued', () => {
      issued += 1
    })
    const recorder = depsFor(() => ({ kind: 'ok', responseDigest: 'must-not-happen' }))

    await issueComp(h.ctx, 'saga-veto', stepOf(h, 'saga-veto', 's1'), SETTINGS, recorder.deps)

    expect(recorder.invokes()).toBe(0)
    expect(issued).toBe(0)
    expect(compOf(h, 'saga-veto', 's1')?.state).toBe('PENDING')
    expect(dlqOf(h, 'saga-veto', 's1')).toBeUndefined()
    expect(h.audits.some((row) => row.type === 'saga/comp-issued')).toBe(false)
  })

  it('NO_OP 模板就地记 OK：不打外部端点，也不发 comp-issued', async () => {
    const h = harness()
    seedSaga(h.store, 'saga-noop', [{ stepId: 's1' }])
    bindComps(h, 'saga-noop', ['s1'], template({ templateId: 'noop-template', compKind: 'NO_OP' }))

    let issued = 0
    h.ctx.events.on('saga/comp-issued', () => {
      issued += 1
    })
    const recorder = depsFor(() => ({ kind: 'ok', responseDigest: 'must-not-happen' }))

    await issueComp(h.ctx, 'saga-noop', stepOf(h, 'saga-noop', 's1'), SETTINGS, recorder.deps)

    expect(recorder.invokes()).toBe(0)
    expect(issued).toBe(0)
    expect(compOf(h, 'saga-noop', 's1')?.state).toBe('OK')
    expect(h.audits.filter((row) => row.type === 'saga/comp-result')).toHaveLength(1)
  })

  it('COMP 键被他人以同载荷占住 → lease-held：留 UNKNOWN，不 DLQ、不硬抢', async () => {
    const h = harness()
    seedSaga(h.store, 'saga-lease', [{ stepId: 's1' }])
    bindComps(h, 'saga-lease', ['s1'])

    const idem = h.ctx.get(SAGA_IDEMPOTENCY)
    let preempted: { ok: boolean; reason?: string } = { ok: false }
    // 在 settleCall 占位之前插入"另一个 worker"的占位行：键与载荷都直接取生产自己算出来的值，
    // 因此这里同时钉住了 compKey / payloadDigest 的推导口径。
    h.ctx.events.on('saga/comp-issued', (value) => {
      preempted = idem.reserve(
        value.compKey,
        {
          idemKey: value.compKey,
          namespace: 'COMP',
          sagaId: value.sagaId,
          targetSystem: 'pay.charge',
          requestDigest: value.payloadDigest,
          status: 'RESERVED',
          leaseOwner: 'worker-b',
        },
        60_000,
      )
    })

    const recorder = depsFor(() => ({ kind: 'ok', responseDigest: 'must-not-double-refund' }))
    await issueComp(h.ctx, 'saga-lease', stepOf(h, 'saga-lease', 's1'), SETTINGS, recorder.deps)

    expect(preempted).toEqual({ ok: true })
    // 键确实与生产一致（否则这一路退化成 key-conflict，用例失去意义）。
    expect(dlqOf(h, 'saga-lease', 's1')).toBeUndefined()
    expect(recorder.invokes()).toBe(0)
    expect(compOf(h, 'saga-lease', 's1')?.state).toBe('UNKNOWN')
  })

  it('同一 COMP 键换了载荷 → key-conflict：直接 DLQ 并带上该归因', async () => {
    const h = harness()
    seedSaga(h.store, 'saga-conflict', [{ stepId: 's1' }])
    bindComps(h, 'saga-conflict', ['s1'])

    const idem = h.ctx.get(SAGA_IDEMPOTENCY)
    h.ctx.events.on('saga/comp-issued', (value) => {
      idem.reserve(
        value.compKey,
        {
          idemKey: value.compKey,
          namespace: 'COMP',
          sagaId: value.sagaId,
          targetSystem: 'pay.charge',
          requestDigest: `${value.payloadDigest}-tampered`,
          status: 'RESERVED',
          leaseOwner: 'worker-b',
        },
        60_000,
      )
    })

    const recorder = depsFor(() => ({ kind: 'ok', responseDigest: 'must-not-refund-again' }))
    await issueComp(h.ctx, 'saga-conflict', stepOf(h, 'saga-conflict', 's1'), SETTINGS, recorder.deps)

    expect(recorder.invokes()).toBe(0)
    expect(compOf(h, 'saga-conflict', 's1')?.state).toBe('DLQ')
    expect(dlqOf(h, 'saga-conflict', 's1')).toMatchObject({ source: 'COMP', reason: 'key-conflict' })
  })

  it('探诊阶梯消解不了（判未执行且无二次滞后）→ DLQ 归因 probe-unresolved 并挂起工单', async () => {
    // 注：这里的 `probe-unresolved` 走的是 `outcome.reason` 透传（probeStep 的 L1 兜底），
    // 不是 issueComp 里那个字面量兜底——`probeStep` 永不返回 `not-executed`，
    // 所以 `settle.ts` 的 NOT_EXECUTED 分支与 `index.ts` 的 `'probe-unresolved'` 字面量
    // 在当前装配下不可达（见本设计结论，未为凑行覆盖伪造触发）。
    const h = harness()
    seedSaga(h.store, 'saga-probe-unknown', [{ stepId: 's1' }])
    bindComps(h, 'saga-probe-unknown', ['s1'])

    const recorder = depsFor(() => ({ kind: 'unknown', code: 'HTTP_504' }))
    await issueComp(
      h.ctx,
      'saga-probe-unknown',
      stepOf(h, 'saga-probe-unknown', 's1'),
      SETTINGS,
      recorder.deps,
    )

    expect(recorder.invokes()).toBe(1)
    expect(compOf(h, 'saga-probe-unknown', 's1')?.state).toBe('DLQ')
    expect(dlqOf(h, 'saga-probe-unknown', 's1')).toMatchObject({
      source: 'COMP',
      reason: 'probe-unresolved',
    })
    expect(
      h.store.tx((tx) => tx.readTicket('ticket:dlq:saga-probe-unknown:s1')),
    ).toMatchObject({ sagaId: 'saga-probe-unknown', reason: 'UNRESOLVED' })
  })

  it('探诊端点异常 → 阶梯给出的具体 reason 原样入 DLQ，不被泛化成兜底值', async () => {
    const h = harness()
    seedSaga(h.store, 'saga-probe-failed', [{ stepId: 's1' }])
    bindComps(h, 'saga-probe-failed', ['s1'])

    const failed: ProbeTransport = async () => ({ kind: 'failed' } satisfies ProbeObservation)
    const recorder = depsFor(() => ({ kind: 'unknown', code: 'HTTP_504' }), failed)

    await issueComp(
      h.ctx,
      'saga-probe-failed',
      stepOf(h, 'saga-probe-failed', 's1'),
      SETTINGS,
      recorder.deps,
    )

    expect(compOf(h, 'saga-probe-failed', 's1')?.state).toBe('DLQ')
    expect(dlqOf(h, 'saga-probe-failed', 's1')?.reason).toBe('probe-endpoint-failed')
  })

  it('冻结快照的摘要面参与补偿载荷与指纹（没有快照时这两个键位不存在）', async () => {
    const h = harness()
    seedSaga(h.store, 'saga-snap', [{ stepId: 's1' }])
    bindComps(h, 'saga-snap', ['s1'], template({ payloadProjection: SNAP_PROJECTION }))

    const seen: { payload?: Readonly<Record<string, unknown>>; digest?: string } = {}
    const spy: CompensationDeps = {
      invoke: async (input) => {
        seen.payload = input.payload
        return { kind: 'ok', responseDigest: 'refund-ok' }
      },
      probe: async () => ({ kind: 'not-executed' }),
    }

    // 先在没有 `state_snapshot` 的情况下发射一次。
    await issueComp(h.ctx, 'saga-snap', stepOf(h, 'saga-snap', 's1'), SETTINGS, spy)
    const withoutSnapshot = { ...seen.payload }
    const digestWithout = compOf(h, 'saga-snap', 's1')?.payloadDigest

    // 写入冻结快照后，同一步骤重发（换 saga 避开 OK 短路）：
    // 快照的 contextDigest 必须进载荷，否则"按当时冻结的上下文退款"就落不了地。
    seedSaga(h.store, 'saga-snap-2', [{ stepId: 's2' }])
    bindComps(h, 'saga-snap-2', ['s2'], template({ payloadProjection: SNAP_PROJECTION }))
    h.store.tx((tx) => {
      tx.insertSnapshot({
        snapshotId: 'snap-1',
        sagaId: 'saga-snap-2',
        stepSeq: 1,
        contextDigest: 'ctx-digest-frozen',
      })
    })
    await issueComp(h.ctx, 'saga-snap-2', stepOf(h, 'saga-snap-2', 's2'), SETTINGS, spy)

    expect(withoutSnapshot).toEqual({})
    expect(seen.payload).toEqual({ context: 'ctx-digest-frozen' })
    expect(compOf(h, 'saga-snap-2', 's2')?.payloadDigest).not.toBe(digestWithout)
  })

  it('手动入口对"从未冻结绑定"的步骤直接抛 no-template：不补空气、不落 DLQ', async () => {
    // `runCompensation` 会把绑定缺口摘出调度（W12），但运营/手动路径是直接调 `issueComp` 的：
    // 这一步必须炸在发射之前，而不是把一笔从未绑定过补偿的开销说成已处置。
    const h = harness()
    seedSaga(h.store, 'saga-unbound', [{ stepId: 's1' }])

    let issued = 0
    h.ctx.events.on('saga/comp-issued', () => {
      issued += 1
    })
    const recorder = depsFor(() => ({ kind: 'ok', responseDigest: 'must-not-happen' }))

    await expect(
      issueComp(h.ctx, 'saga-unbound', stepOf(h, 'saga-unbound', 's1'), SETTINGS, recorder.deps),
    ).rejects.toMatchObject({ code: 'no-template' })

    expect(recorder.invokes()).toBe(0)
    expect(issued).toBe(0)
    expect(h.store.tx((tx) => tx.listCompensations('saga-unbound'))).toHaveLength(0)
    expect(dlqOf(h, 'saga-unbound', 's1')).toBeUndefined()
    expect(h.store.loadTransaction('saga-unbound')?.state).toBe('COMPENSATING')
  })
})
