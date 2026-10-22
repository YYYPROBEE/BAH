/**
 * SA-08 内核用例：CAS 并发、同提交段回滚、恢复不双发、链尾截断。
 */

import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext } from '@bah/core'
import { ChainFile, createSagaAudit, createSagaStore, rebuildSagaState } from '@bah/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { installIdempotency } from '../idempotency/index.ts'
import { makeKey, makeNonce } from '../idempotency/key.ts'
import { recoverAll } from '../recovery/index.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_IDEMPOTENCY, SAGA_STORE } from '../seams.ts'
import { parseSagaSettings } from '../settings.ts'
import { reduceSaga } from '../state-machine/index.ts'
import { commitSegment, planSaga, runSaga } from './index.ts'

import type { Context } from '@bah/core'
import type { SagaStep } from '../types.ts'

const cleanup: string[] = []
const closers: Array<{ close(): void }> = []

afterEach(() => {
  for (const store of closers.splice(0)) store.close()
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  readonly ctx: Context
  readonly store: ReturnType<typeof createSagaStore>
  readonly rootDir: string
  readonly auditDir: string
  readonly warnings: string[]
  advance(ms: number): void
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'bah-saga-'))
  cleanup.push(root)
  let now = 1_000_000
  const store = createSagaStore({ dbPath: join(root, 'saga.sqlite'), now: () => now })
  closers.push(store)
  const warnings: string[] = []
  const ctx = createContext()
  await ctx.start()
  ctx.provide(SAGA_STORE, store)
  ctx.provide(SAGA_CLOCK, { now: () => now, sleep: async () => undefined })
  installIdempotency(ctx)
  const auditDir = join(root, 'audit')
  ctx.provide(
    SAGA_AUDIT,
    createSagaAudit({
      ctx,
      now: () => now,
      rootDir: auditDir,
      fsync: false,
      warn: (message) => warnings.push(message),
    }),
  )
  return {
    ctx,
    store,
    rootDir: root,
    auditDir,
    warnings,
    advance(ms) {
      now += ms
    },
  }
}

function step(stepId: string, seqNo: number, topologyDeps: readonly string[] = []): {
  stepId: string
  seqNo: number
  toolName: string
  endpoint: string
  sideEffectClass: 'REVERSIBLE'
  idemKey: string
  nonce: string
  topologyDeps: readonly string[]
  deadlineMs: number
} {
  const nonce = makeNonce()
  return {
    stepId,
    seqNo,
    toolName: 'pay',
    endpoint: '/pay',
    sideEffectClass: 'REVERSIBLE',
    idemKey: makeKey('FWD', 'saga-a', stepId, nonce),
    nonce,
    topologyDeps,
    deadlineMs: 10_000,
  }
}

function plan(overrides: { readonly sagaId?: string; readonly stepIds?: readonly string[] } = {}): {
  sagaId: string
  businessType: string
  traceId: string
  timeoutBudgetMs: number
  initiator: string
  steps: readonly ReturnType<typeof step>[]
} {
  const sagaId = overrides.sagaId ?? 'saga-a'
  const ids = overrides.stepIds ?? ['s1']
  return {
    sagaId,
    businessType: 'TRANSFER',
    traceId: 'trace-1',
    timeoutBudgetMs: 60_000,
    initiator: 'user-1',
    steps: ids.map((id, index) => step(id, index + 1, index === 0 ? [] : [ids[index - 1] as string])),
  }
}

const settings = parseSagaSettings({ maxParallelBranches: 4 })

describe('SA-08 内核', () => {
  it('T-SA08-002：并发两次 casState 同一版本恰一方生效，version 恰 +1', async () => {
    const test = await harness()
    planSaga(test.ctx, plan(), settings)

    const first = test.store.casState('saga-a', 'RUNNING', 'COMPENSATING', 2, 2_000)
    const second = test.store.casState('saga-a', 'RUNNING', 'SUCCEEDED', 2, 2_000)

    expect([first, second].sort()).toEqual([false, true])
    expect(test.store.loadTransaction('saga-a')?.version).toBe(3)
  })

  it('T-SA08-005：提交段内 throw → 步骤、审计、幂等三者全回滚', async () => {
    const test = await harness()
    const saga = plan()
    planSaga(test.ctx, saga, settings)
    const before = new ChainFile({ rootDir: test.auditDir, fsync: false }).read('saga-a')
    const stepBefore = test.store.listSteps('saga-a')[0] as SagaStep
    const idemKey = stepBefore.idempotencyKey

    expect(() =>
      commitSegment(test.ctx, (tx) => {
        tx.updateStep({ ...stepBefore, state: 'CALLING', attempts: 1 })
        test.ctx.get(SAGA_AUDIT).append('saga-a', 'saga/param-validated', {
          sagaId: 'saga-a',
          stepId: 's1',
          verdict: 'pass',
          gate: 'schema',
        })
        test.ctx.get(SAGA_IDEMPOTENCY).reserveIn(
          tx,
          idemKey,
          {
            idemKey,
            namespace: 'FWD',
            sagaId: 'saga-a',
            targetSystem: 'pay',
            requestDigest: 'req-1',
            status: 'RESERVED',
          },
          60_000,
        )
        throw new Error('injected-failure')
      }),
    ).toThrow(/commit-failed/)

    const after = new ChainFile({ rootDir: test.auditDir, fsync: false }).read('saga-a')
    expect(test.store.listSteps('saga-a')[0]?.state).toBe('PLANNED')
    expect(test.store.tx((tx) => tx.readIdempotency(idemKey))).toBeUndefined()
    expect(after).toHaveLength(before.length)
  })

  it('T-SA08-006：恢复不双发——EXECUTED 步零重发，PLANNED 步交回调度器', async () => {
    const test = await harness()
    const at = 3_000
    test.store.tx((tx) => {
      tx.insertTransaction({
        sagaId: 'saga-r',
        businessType: 'TRANSFER',
        traceId: 'trace-r',
        state: 'RUNNING',
        version: 1,
        timeoutBudgetMs: 60_000,
        compStrategy: 'AUTO',
        initiator: '{}',
        frozen: false,
        createdAt: at,
        updatedAt: at,
      })
      tx.insertStep({
        stepId: 'r1',
        sagaId: 'saga-r',
        seqNo: 1,
        topologyDeps: [],
        toolName: 'pay',
        endpoint: '/pay',
        sideEffectClass: 'REVERSIBLE',
        idempotencyKey: 'FWD:r1',
        idempotencyNonce: 'n1',
        state: 'EXECUTED',
        attempts: 1,
        maxAttempts: 3,
        deadlineMs: 10_000,
      })
      tx.insertStep({
        stepId: 'r2',
        sagaId: 'saga-r',
        seqNo: 2,
        topologyDeps: ['r1'],
        toolName: 'pay',
        endpoint: '/pay',
        sideEffectClass: 'REVERSIBLE',
        idempotencyKey: 'FWD:r2',
        idempotencyNonce: 'n2',
        state: 'PLANNED',
        attempts: 0,
        maxAttempts: 3,
        deadlineMs: 10_000,
      })
    })

    const recovered: Array<{ stepId: string; action: string }> = []
    test.ctx.events.on('saga/recovered', (payload) => {
      recovered.push({ stepId: payload.stepId, action: payload.action })
    })

    const report = recoverAll(test.ctx, settings)
    expect(report.scanned).toBe(1)
    expect(report.dispatched['skip-executed']).toBe(1)
    expect(report.dispatched.reissue).toBe(1)
    expect(recovered).toEqual([{ stepId: 'r1', action: 'skip-executed' }])

    const calls: string[] = []
    await runSaga(test.ctx, 'saga-r', {
      settings,
      dispatch: async (current) => {
        calls.push(current.stepId)
        return { kind: 'ok', responseDigest: `resp-${current.stepId}` }
      },
    })

    expect(calls).toEqual(['r2'])
    expect(test.store.loadTransaction('saga-r')?.state).toBe('SUCCEEDED')
    expect(test.store.listSteps('saga-r').find((item) => item.stepId === 'r1')?.state).toBe('EXECUTED')
  })

  it('T-SA08-008：链尾半行被丢弃并告警，状态仍可重建（diff=0）', async () => {
    const test = await harness()
    planSaga(test.ctx, plan(), settings)
    await runSaga(test.ctx, 'saga-a', {
      settings,
      dispatch: async () => ({ kind: 'ok', responseDigest: 'resp-1' }),
    })

    const file = join(test.auditDir, 'saga-a', 'audit.jsonl')
    const before = readFileSync(file, 'utf8')
    appendFileSync(file, '{"s":"saga-a","q":99', 'utf8')

    const reopened = createSagaAudit({
      now: () => 1,
      rootDir: test.auditDir,
      fsync: false,
      warn: (message) => test.warnings.push(message),
    })
    expect(reopened.verify('saga-a')).toEqual({ ok: true })
    expect(test.warnings.some((message) => message.includes('截断'))).toBe(true)

    const chain = new ChainFile({ rootDir: test.auditDir, fsync: false, warn: () => undefined })
    const state = rebuildSagaState(chain, 'saga-a', reduceSaga as never)
    expect(state).toBe(test.store.loadTransaction('saga-a')?.state)
    expect(state).toBe('SUCCEEDED')
    expect(readFileSync(file, 'utf8').startsWith(before)).toBe(true)
  })
})
