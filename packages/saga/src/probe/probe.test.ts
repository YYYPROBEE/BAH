/**
 * T-SA09-005~008：补偿对称收敛、LAG 二次探诊、无探诊端点禁自动补偿、重试硬停（批 3 探诊段）。
 */

import { createContext } from '@bah/core'
import { createSagaStore } from '@bah/persistence'
import { describe, expect, it } from 'vitest'

import { installIdempotency, makeKey, makeNonce } from '../idempotency/index.ts'
import { runSaga } from '../coordinator/index.ts'
import {
  SAGA_AUDIT,
  SAGA_CLOCK,
  SAGA_STORE,
  TARGET_REGISTRY,
} from '../seams.ts'
import { parseSagaSettings } from '../settings.ts'
import { classify, mustDeadLetter } from './classify.ts'
import { probeStep, type ProbeTransport, type StepRef } from './index.ts'
import { escalateToDlq, settleCall } from './settle.ts'

import type { Context } from '@bah/core'
import type { SagaAudit, TargetRegistry } from '../seams.ts'
import type { TargetSystem } from '../types.ts'

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

function target(
  targetSystem: string,
  probeEndpoint: string | undefined,
  lagSeconds = 0,
): TargetSystem {
  return {
    targetSystem,
    idempotencySupport: 'STRONG',
    probeEndpoint,
    lagSeconds,
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

  return { ctx, store, audits, sleeps }
}

const SETTINGS = parseSagaSettings({})

function refFor(toolName: string, stepId = 'step-1'): StepRef {
  return { sagaId: 'saga-1', stepId, toolName }
}

describe('探诊与对称收敛（SA-09 探诊段）', () => {
  it('T-SA09-005：补偿读超时经探诊判 executed，退款恰一次；同键重放不再调用', async () => {
    const test = harness([target('pay.refund', '/probe/refund')])
    const nonce = makeNonce()
    const ref = refFor('pay.refund', 'refund-1')
    let refunds = 0

    const transport: ProbeTransport = async () => ({
      kind: 'executed',
      responseDigest: 'refund-ok',
    })
    const input = {
      namespace: 'COMP' as const,
      ref,
      nonce,
      requestDigest: 'req-refund',
      invoke: async () => {
        refunds += 1
        return { kind: 'unknown' as const, code: 'READ_TIMEOUT' }
      },
    }

    const outcome = await settleCall(test.ctx, input, transport, SETTINGS)
    expect(outcome).toEqual({ kind: 'ok', responseDigest: 'refund-ok' })
    expect(refunds).toBe(1)

    const key = makeKey('COMP', ref.sagaId, ref.stepId, nonce)
    expect(test.store.tx((tx) => tx.readIdempotency(key))?.status).toBe('DONE')

    // 同补偿键重放：幂等行已持有，不再触发第二次退款。
    const replay = await settleCall(test.ctx, input, transport, SETTINGS)
    expect(replay.kind).toBe('unknown')
    expect(refunds).toBe(1)
  })

  it('T-SA09-006：lagSeconds=120、factor=0.5 → 等 60s 后 L2 命中 executed', async () => {
    const test = harness([target('pay.charge', '/probe/charge', 120)])
    const settings = parseSagaSettings({ probeLagFactor: 0.5 })
    let calls = 0
    const transport: ProbeTransport = async () => {
      calls += 1
      return calls === 1
        ? { kind: 'not-executed' }
        : { kind: 'executed', responseDigest: 'charge-ok' }
    }

    const verdict = await probeStep(test.ctx, refFor('pay.charge'), transport, settings)
    expect(verdict).toEqual({ kind: 'executed', responseDigest: 'charge-ok' })
    expect(calls).toBe(2)
    expect(test.sleeps).toEqual([60_000])

    const probes = test.audits.filter((row) => row.type === 'saga/unknown-probe')
    expect(probes).toHaveLength(2)
    expect(probes[0]?.data).toMatchObject({ ladder: 'L1', verdict: 'not-executed' })
    expect(probes[1]?.data).toMatchObject({
      ladder: 'L2',
      verdict: 'executed',
      lagWaitMs: 60_000,
    })
  })

  it('T-SA09-007：无登记 / 无探诊端点 → UNRESOLVED + DLQ，自动补偿零调用', async () => {
    const test = harness([target('pay.no-endpoint', undefined)])
    let compIssued = 0
    test.ctx.events.on('saga/comp-issued', () => {
      compIssued += 1
    })

    let transportCalls = 0
    const transport: ProbeTransport = async () => {
      transportCalls += 1
      return { kind: 'executed', responseDigest: 'should-not-be-reached' }
    }

    const unknown = await probeStep(test.ctx, refFor('pay.unregistered'), transport, SETTINGS)
    expect(unknown).toEqual({ kind: 'unresolved', reason: 'unknown-target' })

    const noEndpoint = await probeStep(test.ctx, refFor('pay.no-endpoint'), transport, SETTINGS)
    expect(noEndpoint).toEqual({ kind: 'unresolved', reason: 'probe-unresolved' })
    expect(transportCalls).toBe(0)
    expect(compIssued).toBe(0)

    const dlqId = escalateToDlq(test.ctx, {
      sagaId: 'saga-1',
      stepId: 'step-1',
      source: 'probe',
      reason: 'unknown-target',
      slaDeadline: 99_999,
    })
    expect(test.store.tx((tx) => tx.readDlq(dlqId))).toMatchObject({
      source: 'PROBE',
      reason: 'unknown-target',
    })
    expect(test.store.tx((tx) => tx.readTicket(`ticket:${dlqId}`))?.reason).toBe('UNRESOLVED')
    expect(test.store.tx((tx) => tx.dlqDepth())).toBe(1)
    expect(test.audits.some((row) => row.type === 'saga/dlq-escalated')).toBe(true)

    // 重复升级幂等：不产生第二条 DLQ。
    expect(
      escalateToDlq(test.ctx, {
        sagaId: 'saga-1',
        stepId: 'step-1',
        source: 'probe',
        reason: 'unknown-target',
        slaDeadline: 99_999,
      }),
    ).toBe(dlqId)
    expect(test.store.tx((tx) => tx.dlqDepth())).toBe(1)
  })

  it('T-SA09-008：attempts ≥ maxAttempts 强制 DLQ，不再 invoke；maxAttempts=0 载入即抛', async () => {
    const test = harness()
    expect(() => parseSagaSettings({ maxAttempts: 0 })).toThrowError(/maxAttempts/)
    expect(mustDeadLetter(3, 3)).toBe(true)
    expect(mustDeadLetter(2, 3)).toBe(false)

    test.store.tx((tx) => {
      tx.insertTransaction({
        sagaId: 'saga-stop',
        businessType: 'TRANSFER',
        traceId: 'trace-stop',
        state: 'RUNNING',
        version: 1,
        timeoutBudgetMs: 60_000,
        compStrategy: 'AUTO',
        initiator: '{}',
        frozen: false,
        createdAt: 1,
        updatedAt: 1,
      })
      tx.insertStep({
        stepId: 'stop-1',
        sagaId: 'saga-stop',
        seqNo: 1,
        topologyDeps: [],
        toolName: 'pay.charge',
        endpoint: '/tool/pay.charge',
        sideEffectClass: 'EXTERNAL_UNDOABLE',
        idempotencyKey: 'FWD:stop-1',
        idempotencyNonce: 'nonce-stop',
        state: 'PLANNED',
        attempts: 3,
        maxAttempts: 3,
        deadlineMs: 5_000,
      })
    })

    let dispatches = 0
    await runSaga(test.ctx, 'saga-stop', {
      settings: SETTINGS,
      dispatch: async () => {
        dispatches += 1
        return { kind: 'ok', responseDigest: 'must-not-happen' }
      },
    })

    expect(dispatches).toBe(0)
    expect(test.store.tx((tx) => tx.readStep('stop-1'))?.state).toBe('UNRESOLVED')
    expect(test.store.tx((tx) => tx.dlqDepth())).toBe(1)
  })

  it('错误分类白名单：仅明确可重试 / 含糊探诊 / 其余补偿', () => {
    expect(classify('CONN_TIMEOUT')).toEqual({ kind: 'retryable' })
    expect(classify('GATEWAY_503')).toEqual({ kind: 'retryable' })
    expect(classify('READ_TIMEOUT')).toEqual({ kind: 'unresolved' })
    expect(classify('STREAM_RESET')).toEqual({ kind: 'unresolved' })
    expect(classify('AMBIGUOUS_DB_COMMIT')).toEqual({ kind: 'unresolved' })
    expect(classify('HTTP_400')).toEqual({ kind: 'compensate' })
    expect(classify('READ_TIMEOUT_STRANGE')).toEqual({ kind: 'compensate' })
  })
})
