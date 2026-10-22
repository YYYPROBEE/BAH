/**
 * T-SA08-007 的子进程夹具：执行一步后卡在第二步的派发中，等待父进程 SIGKILL。
 *
 * 用法（由测试 spawn）：
 *   node --import tsx kill-child.ts <dbPath> <auditRoot>
 *
 * 与生产装配同构：sqlite store + JSONL 审计链 + 幂等信封 + 协调器。
 */

import { createContext } from '@bah/core'
import { createSagaAudit, createSagaStore } from '@bah/persistence'

import {
  installIdempotency,
  makeKey,
  makeNonce,
  parseSagaSettings,
  planSaga,
  runSaga,
  SAGA_AUDIT,
  SAGA_CLOCK,
  SAGA_STORE,
} from '../../index.ts'

import type { PlannedStep } from '../../index.ts'

const [dbPath, auditRoot] = process.argv.slice(2)
if (dbPath === undefined || auditRoot === undefined) {
  throw new Error('kill-child: 需要 <dbPath> <auditRoot>')
}

const sagaId = 'kill-saga'
const settings = parseSagaSettings({})
const now = (): number => Date.now()

const ctx = createContext()
const store = createSagaStore({ dbPath, now })
ctx.provide(SAGA_STORE, store)
ctx.provide(SAGA_CLOCK, { now, sleep: async () => undefined })
installIdempotency(ctx)
ctx.provide(SAGA_AUDIT, createSagaAudit({ ctx, now, rootDir: auditRoot, fsync: true }))

function planned(stepId: string, seqNo: number, deps: readonly string[]): PlannedStep {
  const nonce = makeNonce()
  return {
    stepId,
    seqNo,
    toolName: 'pay',
    endpoint: '/pay',
    sideEffectClass: 'REVERSIBLE',
    idemKey: makeKey('FWD', sagaId, stepId, nonce),
    nonce,
    topologyDeps: deps,
    deadlineMs: 60_000,
  }
}

planSaga(
  ctx,
  {
    sagaId,
    businessType: 'TRANSFER',
    traceId: 'trace-kill',
    timeoutBudgetMs: 120_000,
    initiator: 'user-1',
    steps: [planned('k1', 1, []), planned('k2', 2, ['k1']), planned('k3', 3, ['k2'])],
  },
  settings,
)

await runSaga(ctx, sagaId, {
  settings,
  dispatch: async (step) => {
    if (step.stepId === 'k1') {
      process.send?.({ kind: 'executed', stepId: 'k1' })
      return { kind: 'ok', responseDigest: 'resp-k1' }
    }
    process.send?.({ kind: 'calling', stepId: step.stepId })
    // 永不返回：等待父进程 SIGKILL（CALLING 已提交，幂等已预占）。
    await new Promise<never>(() => undefined)
    return { kind: 'unknown', code: 'unreachable' }
  },
})
