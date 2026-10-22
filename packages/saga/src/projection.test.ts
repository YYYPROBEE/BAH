/**
 * T-SA11-011/012：投影重建等价与漂移检测（转移唯一取自 reduceSaga）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext } from '@bah/core'
import {
  ChainFile,
  createSagaAudit,
  createSagaStore,
  PROJECTION_STORE,
  projectionDiff,
  rebuildSagaState,
} from '@bah/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { installIdempotency } from './idempotency/index.ts'
import { makeKey, makeNonce } from './idempotency/key.ts'
import { planSaga, runSaga } from './coordinator/index.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE } from './seams.ts'
import { parseSagaSettings } from './settings.ts'
import { reduceSaga } from './state-machine/index.ts'

import type { Context } from '@bah/core'
import type { ProjectionReducer } from '@bah/persistence'

const cleanup: string[] = []
const closers: Array<{ close(): void }> = []
afterEach(() => {
  for (const store of closers.splice(0)) store.close()
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const settings = parseSagaSettings({})
const reduce = reduceSaga as unknown as ProjectionReducer

async function executedSaga(): Promise<{ ctx: Context; chain: ChainFile; rootDir: string }> {
  const rootDir = mkdtempSync(join(tmpdir(), 'bah-projection-'))
  cleanup.push(rootDir)
  const auditDir = join(rootDir, 'audit')
  const store = createSagaStore({ dbPath: join(rootDir, 'saga.sqlite') })
  closers.push(store)
  const ctx = createContext()
  await ctx.start()
  ctx.provide(SAGA_STORE, store)
  ctx.provide(SAGA_CLOCK, { now: () => 1_000, sleep: async () => undefined })
  installIdempotency(ctx)
  ctx.provide(SAGA_AUDIT, createSagaAudit({ ctx, now: () => 1_000, rootDir: auditDir, fsync: false }))

  const nonce = makeNonce()
  planSaga(
    ctx,
    {
      sagaId: 'saga-p',
      businessType: 'TRANSFER',
      traceId: 'trace-p',
      timeoutBudgetMs: 60_000,
      initiator: 'user-1',
      steps: [
        {
          stepId: 'p1',
          seqNo: 1,
          toolName: 'pay',
          endpoint: '/pay',
          sideEffectClass: 'REVERSIBLE',
          idemKey: makeKey('FWD', 'saga-p', 'p1', nonce),
          nonce,
          topologyDeps: [],
          deadlineMs: 10_000,
        },
      ],
    },
    settings,
  )
  await runSaga(ctx, 'saga-p', {
    settings,
    dispatch: async () => ({ kind: 'ok', responseDigest: 'resp-p1' }),
  })
  return { ctx, chain: new ChainFile({ rootDir: auditDir, fsync: false }), rootDir }
}

describe('投影重算', () => {
  it('T-SA11-011：运行时 = 链上全量折叠，diff=0', async () => {
    const { ctx, chain } = await executedSaga()
    expect(rebuildSagaState(chain, 'saga-p', reduce)).toBe('SUCCEEDED')
    expect(projectionDiff(ctx, chain, 'saga-p', reduce)).toBe(0)
  })

  it('T-SA11-012：人为漂移运行时状态 → diff=1', async () => {
    const { chain } = await executedSaga()
    const drifted = createContext()
    drifted.provide(PROJECTION_STORE, {
      loadTransaction: () => ({ state: 'COMPENSATING' }),
    })
    expect(projectionDiff(drifted, chain, 'saga-p', reduce)).toBe(1)
  })
})
