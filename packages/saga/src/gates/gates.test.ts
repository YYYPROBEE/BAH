/**
 * T-SA10-009 / 010 / 011 / 012 / 016 / 018：审批 CAS、三道闸、工具面读写分离、DLQ 分级告警、注册可逆（批 4 闸门面）。
 *
 * 全部用例跑真实 in-memory store（`createSagaStore({ dbPath: ':memory:' })`）+ fake audit/clock，
 * 与 `probe.test.ts` 的夹具口径一致；runtime 只作类型面（`ToolRegistry` 为真实实现）。
 */

import { createContext } from '@bah/core'
import { createSagaStore } from '@bah/persistence'
import { ToolRegistry } from '@bah/runtime'
import { sha256Hex } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { escalateToDlq } from '../probe/settle.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STEP_CONTEXT, SAGA_STORE } from '../seams.ts'
import { parseSagaSettings } from '../settings.ts'
import {
  assertManualOnlyTail,
  assertNotModelVisible,
  buildTraceparent,
  compensationEndpointName,
  dlqDepthVerdict,
  installDlqAlerts,
  installGates,
  PARAM_GATES,
  provideParamGates,
  provideTraceparentInjection,
  RISK_THRESHOLD_CODE,
  spanIdOf,
  submitDecision,
  toW3cTraceId,
  traceparentOf,
  withTraceparent,
} from './index.ts'

import type { Context } from '@bah/core'
import type { ToolCallInput } from '@bah/runtime'

import type { DlqAlertSink } from './index.ts'
import type { SagaAudit, SagaStore } from '../seams.ts'
import type { CompKind, CompTemplate, SagaState, SideEffectClass } from '../types.ts'

interface AuditRow {
  readonly sagaId: string
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

interface Harness {
  readonly ctx: Context
  readonly store: SagaStore
  readonly audits: AuditRow[]
}

/** 真实 sqlite（`:memory:`）+ 假审计/时钟。 */
function harness(): Harness {
  let now = 10_000
  const store = createSagaStore({ dbPath: ':memory:', now: () => now })
  const ctx = createContext()
  const audits: AuditRow[] = []

  const audit: SagaAudit = {
    append(sagaId, type, data) {
      audits.push({ sagaId, type, data: (data ?? {}) as Readonly<Record<string, unknown>> })
      return { seqInSaga: audits.length, recordHash: `hash-${audits.length}` }
    },
    verify: () => ({ ok: true }),
    anchor: async () => ({ merkleRoot: 'root', targets: [] }),
  }

  ctx.provide(SAGA_STORE, store)
  ctx.provide(SAGA_AUDIT, audit)
  ctx.provide(SAGA_CLOCK, {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  })
  return { ctx, store, audits }
}

interface SeedOptions {
  readonly sagaId: string
  readonly state?: SagaState
  readonly version?: number
  readonly traceId?: string
  readonly ticketId?: string
}

/** 落一条 saga（可选带一张 `GATE_APPROVAL` 票据）。 */
function seedSaga(store: SagaStore, options: SeedOptions): void {
  const { sagaId, state = 'RUNNING', version = 1, traceId = 'trace-1', ticketId } = options
  store.tx((tx) => {
    tx.insertTransaction({
      sagaId,
      businessType: 'TRANSFER',
      traceId,
      state,
      version,
      timeoutBudgetMs: 60_000,
      compStrategy: 'AUTO',
      initiator: '{}',
      frozen: false,
      createdAt: 1,
      updatedAt: 1,
    })
    if (ticketId !== undefined) {
      tx.insertTicket({
        ticketId,
        sagaId,
        reason: 'GATE_APPROVAL',
        slaDeadline: 99_999,
      })
    }
  })
}

/** 落一条 step（`seqNo` 即计划期冻结的线性序）。 */
function seedStep(
  store: SagaStore,
  sagaId: string,
  stepId: string,
  seqNo: number,
  sideEffectClass: SideEffectClass,
): void {
  store.tx((tx) => {
    tx.insertStep({
      stepId,
      sagaId,
      seqNo,
      topologyDeps: [],
      toolName: `tool.${stepId}`,
      endpoint: `/tool/${stepId}`,
      sideEffectClass,
      idempotencyKey: `FWD:${sagaId}:${stepId}`,
      idempotencyNonce: `nonce-${stepId}`,
      state: sideEffectClass === 'IRREVERSIBLE' ? 'EXECUTED' : 'PLANNED',
      attempts: 1,
      maxAttempts: 3,
      deadlineMs: 5_000,
    })
  })
}

function template(compKind: CompKind): CompTemplate {
  return {
    templateId: `tpl-${compKind}`,
    templateVersion: 1,
    targetTool: 'tool.any',
    compKind,
    compEndpoint: `/comp/${compKind}`,
    compIdempotent: true,
    residualRules: [],
    approvalRequired: compKind === 'MANUAL_ONLY',
    payloadProjection: '{"fields":[]}',
    status: 'ACTIVE',
  }
}

/** 取结构化理由码（不依赖消息文案）。 */
function errorCodeOf(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('审批回执 CAS（SA-10 §3.3）', () => {
  it('T-SA10-009：两方同 version 提交 —— 恰一方 applied、另一方 stale，双方审计', () => {
    const test = harness()
    seedSaga(test.store, {
      sagaId: 'saga-cas',
      state: 'GATE_HOLDING',
      version: 7,
      ticketId: 'ticket-cas',
    })

    const first = submitDecision(test.ctx, 'ticket-cas', 'allowed-once', 'approver-a', 7)
    const second = submitDecision(test.ctx, 'ticket-cas', 'allowed-once', 'approver-b', 7)

    expect(first).toBe('applied')
    expect(second).toBe('stale')

    const rows = test.audits.filter((row) => row.type === 'approval/decided')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.data).toMatchObject({
      outcome: 'applied',
      approver: 'approver-a',
      sagaVersion: 7,
    })
    expect(rows[1]?.data).toMatchObject({
      outcome: 'stale',
      approver: 'approver-b',
      reason: 'version-conflict',
      detail: 'version-mismatch',
    })

    const saga = test.store.loadTransaction('saga-cas')
    expect(saga).toMatchObject({ state: 'RUNNING', version: 8 })
    // 只有生效方核销了票据；作废方不写回执。
    expect(test.store.tx((tx) => tx.readTicket('ticket-cas'))).toMatchObject({
      decision: 'allowed-once',
      approverId: 'approver-a',
      decidedAt: 10_000,
    })
  })

  it('T-SA10-010：状态已推进 / 票据不存在 —— 一律 stale，只审计，不改状态与回执', () => {
    const test = harness()
    // 版本相同但状态已不是 GATE_HOLDING（CAS 的另一半失败）。
    seedSaga(test.store, {
      sagaId: 'saga-advanced',
      state: 'RUNNING',
      version: 3,
      ticketId: 'ticket-advanced',
    })

    expect(submitDecision(test.ctx, 'ticket-advanced', 'allowed-once', 'approver', 3)).toBe('stale')

    const saga = test.store.loadTransaction('saga-advanced')
    expect(saga).toMatchObject({ state: 'RUNNING', version: 3 })
    expect(test.store.tx((tx) => tx.readTicket('ticket-advanced'))).toMatchObject({
      decision: undefined,
      approverId: undefined,
      decidedAt: undefined,
    })

    // 未知票据：同样只审计（无法归属到 saga 时 sagaId 记空串）。
    expect(submitDecision(test.ctx, 'ticket-unknown', 'rejected', 'approver', 3)).toBe('stale')

    const rows = test.audits.filter((row) => row.type === 'approval/decided')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.sagaId).toBe('saga-advanced')
    expect(rows[0]?.data).toMatchObject({
      outcome: 'stale',
      reason: 'version-conflict',
      detail: 'state-not-gate-holding',
    })
    expect(rows[1]?.sagaId).toBe('ticket:ticket-unknown')
    expect(rows[1]?.data).toMatchObject({ outcome: 'stale', detail: 'ticket-missing' })
  })
})

describe('MANUAL_ONLY 终段（SA-10 §3.3 / M2）', () => {
  it('IRREVERSIBLE 之后的非 MANUAL_ONLY 绑定 → no-template + 审计（复核只读）', () => {
    const test = harness()
    seedSaga(test.store, { sagaId: 'saga-bad' })
    seedSaga(test.store, { sagaId: 'saga-good' })
    for (const sagaId of ['saga-bad', 'saga-good']) {
      const irreversible = `${sagaId}-irreversible-1`
      const reversible = `${sagaId}-reversible-2`
      seedStep(test.store, sagaId, irreversible, 1, 'IRREVERSIBLE')
      seedStep(test.store, sagaId, reversible, 2, 'EXTERNAL_UNDOABLE')
      test.store.tx((tx) => {
        tx.bindCompensation(sagaId, irreversible, template('MANUAL_ONLY'))
        tx.bindCompensation(
          sagaId,
          reversible,
          template(sagaId === 'saga-bad' ? 'FULL_REFUND' : 'MANUAL_ONLY'),
        )
      })
    }

    const before = test.store.tx((tx) => tx.listCompensations('saga-bad')).length
    expect(() => assertManualOnlyTail(test.ctx, 'saga-bad')).toThrowError(/no-template/)
    // 复核是只读的：补偿绑定一条不多、一条不少。
    expect(test.store.tx((tx) => tx.listCompensations('saga-bad'))).toHaveLength(before)

    const violation = test.audits.filter((row) => row.sagaId === 'saga-bad')
    expect(violation).toHaveLength(1)
    expect(violation[0]).toMatchObject({ type: 'saga/comp-decided' })
    expect(violation[0]?.data).toMatchObject({
      decide: 'manual',
      reason: 'manual-only-tail-violation',
      stepId: 'saga-bad-reversible-2',
      compKind: 'FULL_REFUND',
      irreversibleSeq: 1,
    })

    // 全量 MANUAL_ONLY 的 saga 复核通过，且不产生任何审计。
    expect(() => assertManualOnlyTail(test.ctx, 'saga-good')).not.toThrow()
    expect(test.audits.filter((row) => row.sagaId === 'saga-good')).toHaveLength(0)
  })
})

describe('三道闸（SA-10 §3.4 / tools/pre-execute）', () => {
  it('T-SA10-011：schema / rule / risk 逐闸拒绝并 emit saga/param-validated；通过时恰调用一次 next', async () => {
    const test = gateHarness()

    const schema = await test.run({ callId: 'call-schema', name: '', args: {} })
    expect(schema.verdict).toMatchObject({ kind: 'deny', code: 'schema-tool-name' })
    expect(test.events.at(-1)).toMatchObject({
      verdict: 'reject',
      gate: 'schema',
      code: 'schema-tool-name',
    })

    const shape = await test.run({
      callId: 'call-shape',
      name: 'pay.charge',
      args: [] as unknown as Record<string, unknown>,
    })
    expect(shape.verdict).toMatchObject({ kind: 'deny', code: 'schema-args-not-object' })
    expect(test.events.at(-1)).toMatchObject({ verdict: 'reject', gate: 'schema' })

    const rule = await test.run({ callId: 'call-rule', name: 'pay.transfer', args: { amount: 100 } })
    expect(rule.verdict).toMatchObject({ kind: 'deny', code: 'rule-missing-arg' })
    expect(test.events.at(-1)).toMatchObject({ verdict: 'reject', gate: 'rule' })

    const deniedArg = await test.run({
      callId: 'call-denied',
      name: 'pay.charge',
      args: { amount: 1, skipApproval: true },
    })
    expect(deniedArg.verdict).toMatchObject({ kind: 'deny', code: 'rule-denied-arg' })
    expect(test.events.at(-1)).toMatchObject({ verdict: 'reject', gate: 'rule', code: 'rule-denied-arg' })

    const risk = await test.run({
      callId: 'call-risk',
      name: 'pay.charge',
      args: { amount: 500_000 },
    })
    expect(risk.verdict).toMatchObject({ kind: 'deny', code: RISK_THRESHOLD_CODE })
    expect(test.events.at(-1)).toMatchObject({
      verdict: 'reject',
      gate: 'risk',
      code: RISK_THRESHOLD_CODE,
    })

    // 拒绝一律短路：下游监听器一次都没被调用。
    expect(test.downstreamCalls()).toBe(0)

    const pass = await test.run({ callId: 'call-pass', name: 'pay.charge', args: { amount: 100 } })
    expect(pass.verdict).toEqual({ kind: 'allow' })
    expect(test.downstreamCalls()).toBe(1)
    expect(test.events.at(-1)).toMatchObject({ verdict: 'pass', gate: 'risk' })

    // 判决顺序钉死（不可重排）。
    expect(PARAM_GATES.map((gate) => gate.gate)).toEqual(['schema', 'rule', 'risk'])

    // 无 saga 上下文：跳过 saga/param-validated，但仍交还 next。
    test.unbind()
    const unbound = await test.run({ callId: 'call-unbound', name: 'pay.charge', args: { amount: 100 } })
    expect(unbound.verdict).toEqual({ kind: 'allow' })
    expect(test.downstreamCalls()).toBe(2)
    expect(test.events).toHaveLength(6)
    expect(test.ctx.scope.get(SAGA_STEP_CONTEXT)).toBeUndefined()
  })
})

/** 闸门夹具：真实 store + 闸监听 + 下游计数器 + saga 作用域绑定。 */
function gateHarness() {
  const test = harness()
  const events: { verdict: string; gate: string; code?: string }[] = []
  test.ctx.events.on('saga/param-validated', (payload) => {
    events.push(payload)
  })
  const disposeGates = provideParamGates(test.ctx)
  let downstream = 0
  test.ctx.events.on('tools/pre-execute', (input) => {
    downstream += 1
    return input
  })
  const unbind = test.ctx.scope.set(SAGA_STEP_CONTEXT, { sagaId: 'saga-g', stepId: 'step-g' })
  const run = (call: ToolCallInput) =>
    test.ctx.events.waterfall('tools/pre-execute', { call, verdict: { kind: 'allow' } })
  return {
    ctx: test.ctx,
    events,
    run,
    disposeGates,
    unbind,
    downstreamCalls: () => downstream,
  }
}

describe('工具面读写分离（SA-10 §3.4 / M1）', () => {
  it('T-SA10-012：补偿端点名经 ToolRegistry.get → tool-missing（不可达）', () => {
    const registry = new ToolRegistry()
    const disposeForward = registry.register({
      name: 'pay.refund',
      description: '正向退款（模型可见）',
      schema: { type: 'object' },
      tier: { level: 'yellow', amountPath: 'amount' },
      execute: async () => ({ ok: true }),
    })

    const endpoint = compensationEndpointName('pay.refund')
    expect(endpoint).toBe('saga.compensate.pay.refund')
    expect(registry.has(endpoint)).toBe(false)
    expect(registry.names()).toEqual(['pay.refund'])
    // 契约是理由码 `tool-missing`（`ToolRegistry` 的消息文案不含码本身）。
    expect(errorCodeOf(() => registry.get(endpoint))).toBe('tool-missing')
    expect(() => assertNotModelVisible(registry, endpoint)).not.toThrow()

    // 若有人把补偿端点注册进模型可见工具面 → 守卫必须 fail-loud（同一理由码）。
    const disposeComp = registry.register({
      name: endpoint,
      description: '补偿端点（误注册）',
      schema: { type: 'object' },
      tier: { level: 'red' },
      execute: async () => ({ ok: true }),
    })
    expect(errorCodeOf(() => assertNotModelVisible(registry, endpoint))).toBe('tool-missing')

    disposeComp()
    disposeForward()
    expect(registry.names()).toEqual([])
  })
})

describe('出站 traceparent（SA-10 §3.4 / tools/execute）', () => {
  it('saga 绑定 → 注入非枚举 traceparent；无绑定原样透传', async () => {
    const test = harness()
    seedSaga(test.store, { sagaId: 'saga-tp', traceId: 'trace-abc' })
    const dispose = provideTraceparentInjection(test.ctx)

    const captured: ToolCallInput[] = []
    const innermost = async (call: ToolCallInput): Promise<string> => {
      captured.push(call)
      return 'ok'
    }
    const executor = await test.ctx.events.waterfall('tools/execute', innermost)
    const call: ToolCallInput = { callId: 'call-1', name: 'pay.charge', args: { amount: 100 } }

    const unbind = test.ctx.scope.set(SAGA_STEP_CONTEXT, { sagaId: 'saga-tp', stepId: 'step-1' })
    await executor(call)
    const traced = captured[0] as ToolCallInput
    const traceId = sha256Hex('trace-abc').slice(0, 32)
    expect(traceparentOf(traced)).toBe(`00-${traceId}-${spanIdOf('call-1')}-01`)
    expect(traceparentOf(traced)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    // 非枚举：指纹 / 模型可见参数都不被污染。
    expect(Object.prototype.propertyIsEnumerable.call(traced, 'traceparent')).toBe(false)
    expect(JSON.stringify(traced)).not.toContain('traceparent')
    expect(traced.args).toEqual({ amount: 100 })
    expect(traceparentOf(call)).toBeUndefined()
    unbind()

    // 无 saga 上下文 → 原样透传（同一个对象，无新属性）。
    await executor(call)
    expect(captured[1]).toBe(call)
    expect(traceparentOf(captured[1] as ToolCallInput)).toBeUndefined()

    dispose()
  })

  it('traceparent 归一与构造确定性（合规 32-hex 原样、其余走 sha256）', () => {
    const hex = 'a'.repeat(32)
    expect(toW3cTraceId(hex.toUpperCase())).toBe(hex)
    expect(toW3cTraceId('trace-abc')).toBe(sha256Hex('trace-abc').slice(0, 32))
    expect(toW3cTraceId('0'.repeat(32))).toBe(sha256Hex('0'.repeat(32)).slice(0, 32))
    expect(buildTraceparent(hex, 'b'.repeat(16))).toBe(`00-${hex}-${'b'.repeat(16)}-01`)
    expect(() => buildTraceparent(hex, 'xyz')).toThrowError(/invalid-traceparent/)
    expect(spanIdOf('call-1')).toMatch(/^[0-9a-f]{16}$/)

    const original: ToolCallInput = { callId: 'call-2', name: 'pay.charge', args: {} }
    const traced = withTraceparent(original, buildTraceparent(hex, spanIdOf('call-2')))
    expect(traceparentOf(traced)).toBeDefined()
    expect(traceparentOf(original)).toBeUndefined()
  })
})

describe('DLQ 分级告警（SA-10 §3.5 / M10）', () => {
  it('T-SA10-016：深度 ≥ dlqAlertDepth 告警、≥ dlqPhoneDepth 电话升级（fake sink）', () => {
    const test = harness()
    const settings = parseSagaSettings({ dlqAlertDepth: 2, dlqPhoneDepth: 3 })
    const alerts: { message: string; depth: number }[] = []
    const phones: { message: string; depth: number }[] = []
    const sink: DlqAlertSink = {
      alert: (message, signal) => alerts.push({ message, depth: signal.depth }),
      phone: (message, signal) => phones.push({ message, depth: signal.depth }),
    }
    const dispose = installDlqAlerts(test.ctx, settings, sink)

    // 阈值判决（纯函数）：alert < phone 由载入期校验保证。
    expect(dlqDepthVerdict(1, settings)).toEqual({ alert: false, phone: false })
    expect(dlqDepthVerdict(2, settings)).toEqual({ alert: true, phone: false })
    expect(dlqDepthVerdict(3, settings)).toEqual({ alert: true, phone: true })

    const escalate = (stepId: string): string =>
      escalateToDlq(test.ctx, {
        sagaId: 'saga-dlq',
        stepId,
        source: 'step',
        reason: 'unknown-target',
        slaDeadline: 99_999,
      })

    escalate('step-1')
    expect(test.store.tx((tx) => tx.dlqDepth())).toBe(1)
    expect([alerts.length, phones.length]).toEqual([0, 0])

    escalate('step-2')
    expect(test.store.tx((tx) => tx.dlqDepth())).toBe(2)
    expect([alerts.length, phones.length]).toEqual([1, 0])
    expect(alerts[0]).toMatchObject({ depth: 2 })

    escalate('step-3')
    expect(test.store.tx((tx) => tx.dlqDepth())).toBe(3)
    expect([alerts.length, phones.length]).toEqual([2, 1])
    expect(phones[0]).toMatchObject({ depth: 3 })

    // 撤销后不再有任何出口被调用（深度继续增长也不告警）。
    dispose()
    escalate('step-4')
    expect(test.store.tx((tx) => tx.dlqDepth())).toBe(4)
    expect([alerts.length, phones.length]).toEqual([2, 1])
  })
})

describe('注册可逆（SA-10 T-SA10-018）', () => {
  it('T-SA10-018：provideParamGates / installGates 返回 disposer；dispose 后挂点消失', async () => {
    const test = harness()
    seedSaga(test.store, { sagaId: 'saga-dispose', traceId: 'trace-dispose' })
    const verdicts: string[] = []
    test.ctx.events.on('saga/param-validated', (payload) => {
      verdicts.push(payload.verdict)
    })

    // 单独装配的三道闸同样是可逆贡献。
    const disposeParamGates = provideParamGates(test.ctx)
    expect(typeof disposeParamGates).toBe('function')
    disposeParamGates()

    const dispose = installGates(test.ctx)
    expect(typeof dispose).toBe('function')
    const unbind = test.ctx.scope.set(SAGA_STEP_CONTEXT, {
      sagaId: 'saga-dispose',
      stepId: 'step-1',
    })

    const call: ToolCallInput = { callId: 'call-1', name: 'pay.charge', args: { amount: 10 } }
    await test.ctx.events.waterfall('tools/pre-execute', { call, verdict: { kind: 'allow' } })
    expect(verdicts).toEqual(['pass'])

    const captured: ToolCallInput[] = []
    const innermost = async (target: ToolCallInput): Promise<string> => {
      captured.push(target)
      return 'ok'
    }
    const executor = await test.ctx.events.waterfall('tools/execute', innermost)
    await executor(call)
    expect(traceparentOf(captured[0] as ToolCallInput)).toBeDefined()

    // 幂等 dispose：两个挂点同时撤销。
    dispose()
    dispose()

    // 仍绑定 saga → 挂点已消失：无 param 事件、无 traceparent。
    await test.ctx.events.waterfall('tools/pre-execute', { call, verdict: { kind: 'allow' } })
    expect(verdicts).toEqual(['pass'])

    // 环绕在 `waterfall` 解析时成型，因此撤销后必须重新解析执行器。
    const executorAfterDispose = await test.ctx.events.waterfall('tools/execute', innermost)
    await executorAfterDispose(call)
    expect(captured[1]).toBe(call)
    expect(traceparentOf(captured[1] as ToolCallInput)).toBeUndefined()
    unbind()
  })
})
