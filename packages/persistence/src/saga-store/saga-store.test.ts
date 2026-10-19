/**
 * T-SA07-003 / T-SA07-004 + L6 冒烟：迁移、版本拒绝、CAS 与全部 `SagaTx` 行级原语。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { createSagaStore } from './index.ts'
import { applyV0, CURRENT_SCHEMA_VERSION, V0_BUSINESS_TABLES } from './migrations/index.ts'
import type {
  CompTemplate,
  IdempotencyRecord,
  SagaStep,
  SagaTransaction,
} from './types.ts'

function transaction(overrides: Partial<SagaTransaction> = {}): SagaTransaction {
  return {
    sagaId: 's1',
    businessType: 'TRANSFER',
    traceId: 'trace-1',
    state: 'CREATED',
    version: 1,
    timeoutBudgetMs: 600_000,
    compStrategy: 'AUTO',
    initiator: '{"masked":true}',
    frozen: false,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

function step(overrides: Partial<SagaStep> = {}): SagaStep {
  return {
    stepId: 'step-1',
    sagaId: 's1',
    seqNo: 1,
    topologyDeps: [],
    toolName: 'transfer',
    endpoint: 'mock://transfer',
    sideEffectClass: 'EXTERNAL_UNDOABLE',
    idempotencyKey: 'FWD:s1:step-1:nonce',
    idempotencyNonce: 'nonce',
    state: 'PLANNED',
    attempts: 0,
    maxAttempts: 3,
    deadlineMs: 200,
    ...overrides,
  }
}

const template: CompTemplate = {
  templateId: 'tpl-refund',
  templateVersion: 2,
  targetTool: 'transfer',
  compKind: 'FULL_REFUND',
  compEndpoint: 'mock://refund',
  compIdempotent: true,
  residualRules: ['fee'],
  approvalRequired: false,
  payloadProjection: '{"fields":[]}',
  status: 'ACTIVE',
}

function idem(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    idemKey: 'FWD:s1:step-1:nonce',
    namespace: 'FWD',
    sagaId: 's1',
    targetSystem: 'mock-gateway',
    requestDigest: 'req-digest',
    status: 'RESERVED',
    leaseOwner: 'worker-1',
    leaseExpiry: 100,
    ...overrides,
  }
}

describe('v0 迁移', () => {
  it('T-SA07-003：空库建 11 张业务表 + schema_migrations；重复执行抛 schema-exists', () => {
    const db = new DatabaseSync(':memory:')
    try {
      applyV0(db)
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
      const names = tables.map((row) => row.name).sort()
      expect(names).toEqual([...V0_BUSINESS_TABLES, 'schema_migrations'].sort())
      expect(names).toHaveLength(12)

      const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }
      expect(version.v).toBe(CURRENT_SCHEMA_VERSION)

      expect(() => applyV0(db)).toThrow(/schema-exists/)
    } finally {
      db.close()
    }
  })

  it('T-SA07-004：库版本高于当前代码 → 拒绝打开并明确报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saga-store-'))
    const dbPath = join(dir, 'future.sqlite')
    try {
      createSagaStore({ dbPath }).close()

      const raw = new DatabaseSync(dbPath)
      raw.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, 0)
      raw.close()

      expect(() => createSagaStore({ dbPath })).toThrow(/schema-version-too-new/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('已有当前版本库可重复打开（不重复执行 v0）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saga-store-'))
    const dbPath = join(dir, 'reopen.sqlite')
    try {
      const first = createSagaStore({ dbPath })
      first.tx((tx) => tx.insertTransaction(transaction()))
      first.close()

      const second = createSagaStore({ dbPath })
      expect(second.loadTransaction('s1')?.state).toBe('CREATED')
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('SagaStore / SagaTx', () => {
  it('L6 冒烟：空库迁移 + 一次 casState；并发失败方返回 false', () => {
    const store = createSagaStore({ dbPath: ':memory:' })
    try {
      store.tx((tx) => tx.insertTransaction(transaction()))

      const at = 200
      expect(store.tx((tx) => tx.casState('s1', 'CREATED', 'RUNNING', 1, at))).toBe(true)
      expect(store.loadTransaction('s1')).toMatchObject({ state: 'RUNNING', version: 2, updatedAt: at })

      // 第二个写入者仍拿着旧版本：CAS 必须失败且不改状态
      expect(store.tx((tx) => tx.casState('s1', 'CREATED', 'RUNNING', 1, at + 1))).toBe(false)
      expect(store.loadTransaction('s1')).toMatchObject({ state: 'RUNNING', version: 2 })
    } finally {
      store.close()
    }
  })

  it('activeSagas 只返回非终态；listAllSagas 支持过滤', () => {
    const store = createSagaStore({ dbPath: ':memory:' })
    try {
      store.tx((tx) => {
        tx.insertTransaction(transaction({ sagaId: 'a', businessType: 'TRANSFER' }))
        tx.insertTransaction(transaction({ sagaId: 'b', businessType: 'TRANSFER' }))
        tx.insertTransaction(transaction({ sagaId: 'c', businessType: 'WEALTH', state: 'SUCCEEDED' }))
      })
      expect(store.activeSagas()).toEqual(['a', 'b'])
      expect(store.listAllSagas({ state: 'SUCCEEDED' }).map((row) => row.sagaId)).toEqual(['c'])
      expect(store.listAllSagas({ businessType: 'TRANSFER' }).map((row) => row.sagaId)).toEqual(['a', 'b'])
    } finally {
      store.close()
    }
  })

  it('步骤：insert / read / list / update / upsert', () => {
    const store = createSagaStore({ dbPath: ':memory:' })
    try {
      store.tx((tx) => {
        tx.insertTransaction(transaction())
        tx.insertStep(step({ topologyDeps: [] }))
        tx.insertStep(step({ stepId: 'step-2', seqNo: 2, topologyDeps: ['step-1'], idempotencyKey: 'FWD:s1:step-2:nonce' }))
      })

      expect(store.listSteps('s1').map((row) => row.stepId)).toEqual(['step-1', 'step-2'])
      expect(store.listSteps('s1')[1]?.topologyDeps).toEqual(['step-1'])

      store.tx((tx) => tx.updateStep(step({ state: 'EXECUTED', attempts: 1, responseDigest: 'r1' })))
      expect(store.listSteps('s1')[0]).toMatchObject({ state: 'EXECUTED', attempts: 1, responseDigest: 'r1' })

      store.upsertStep(step({ state: 'FAILED', toolName: 'transfer-v2' }))
      expect(store.listSteps('s1')[0]).toMatchObject({ state: 'FAILED', toolName: 'transfer-v2' })
    } finally {
      store.close()
    }
  })

  it('补偿绑定：版本冻结写入 + 读回 + 状态更新', () => {
    const store = createSagaStore({ dbPath: ':memory:' })
    try {
      store.tx((tx) => {
        tx.insertTransaction(transaction())
        tx.insertStep(step())
        tx.bindCompensation('s1', 'step-1', template)
      })

      const [bound] = store.tx((tx) => tx.listCompensations('s1'))
      expect(bound).toMatchObject({
        compId: 'comp:s1:step-1',
        templateId: 'tpl-refund',
        templateVersion: 2,
        compKind: 'FULL_REFUND',
        state: 'PENDING',
      })

      store.tx((tx) => tx.updateCompensation({ ...bound!, state: 'OK', residualAmount: 12.5 }))
      expect(store.tx((tx) => tx.listCompensations('s1'))[0]).toMatchObject({ state: 'OK', residualAmount: 12.5 })
    } finally {
      store.close()
    }
  })

  it('幂等：插入恰一方成功；租约过期可接管；完成后状态 DONE', () => {
    let now = 1000
    const store = createSagaStore({ dbPath: ':memory:', now: () => now })
    try {
      store.tx((tx) => {
        expect(tx.insertIdempotency(idem())).toBe(true)
        expect(tx.insertIdempotency(idem({ requestDigest: 'other' }))).toBe(false)
        expect(tx.takeoverIdempotency('FWD:s1:step-1:nonce', 'worker-2', 2000)).toBe(true)
        expect(tx.takeoverIdempotency('FWD:s1:step-1:nonce', 'worker-3', 3000)).toBe(false)
        tx.completeIdempotency('FWD:s1:step-1:nonce', 'resp', 'fp')
      })

      expect(store.tx((tx) => tx.readIdempotency('FWD:s1:step-1:nonce'))).toMatchObject({
        status: 'DONE',
        leaseOwner: 'worker-2',
        responseDigest: 'resp',
        fingerprint: 'fp',
      })

      now = 5000
      expect(store.tx((tx) => tx.takeoverIdempotency('FWD:s1:step-1:nonce', 'worker-4', 6000))).toBe(false)
    } finally {
      store.close()
    }
  })

  it('DLQ / 工单 / 票据决策 / 残差 / 快照 / 金库 / 冻结', () => {
    const store = createSagaStore({ dbPath: ':memory:' })
    try {
      store.tx((tx) => {
        tx.insertTransaction(transaction())
        tx.insertDlq({
          dlqId: 'dlq-1',
          sagaId: 's1',
          source: 'STEP',
          reason: 'probe-unresolved',
          enteredAt: 300,
          slaDeadline: 400,
        })
        tx.insertTicket({
          ticketId: 'ticket-1',
          sagaId: 's1',
          reason: 'UNRESOLVED',
          slaDeadline: 500,
        })
        tx.insertResidual({
          residualId: 'res-1',
          sagaId: 's1',
          compId: 'comp:s1:step-1',
          residualType: 'fee',
          amount: 1.5,
          reconciled: false,
        })
        tx.insertSnapshot({
          snapshotId: 'snap-1',
          sagaId: 's1',
          stepSeq: 1,
          contextDigest: 'ctx-digest',
        })
        tx.putVault('vault-1', new Uint8Array([1, 2, 3]), 1, 'PII')
        tx.freezeSaga('s1', true, 600)
      })

      expect(store.tx((tx) => tx.dlqDepth())).toBe(1)
      expect(store.tx((tx) => tx.listDlqPending()).map((row) => row.dlqId)).toEqual(['dlq-1'])
      expect(store.tx((tx) => tx.readDlq('dlq-1'))?.reason).toBe('probe-unresolved')

      expect(store.tx((tx) => tx.loadTransactionByTicket('ticket-1'))?.sagaId).toBe('s1')
      expect(store.tx((tx) => tx.readTicket('ticket-1'))?.decision).toBeUndefined()

      store.tx((tx) => tx.recordTicketDecision('ticket-1', 'approved', 'approver-1', 700))
      expect(store.tx((tx) => tx.readTicket('ticket-1'))).toMatchObject({
        decision: 'approved',
        approverId: 'approver-1',
        decidedAt: 700,
      })

      expect(store.tx((tx) => tx.listResiduals('s1'))[0]).toMatchObject({
        residualType: 'fee',
        amount: 1.5,
        reconciled: false,
      })
      expect(store.tx((tx) => tx.readLatestSnapshot('s1'))?.contextDigest).toBe('ctx-digest')

      const vault = store.tx((tx) => tx.readVault('vault-1'))
      expect(vault?.keyVersion).toBe(1)
      expect(vault?.classification).toBe('PII')
      expect(Array.from(vault?.cipherText ?? [])).toEqual([1, 2, 3])

      expect(store.loadTransaction('s1')).toMatchObject({ frozen: true, updatedAt: 600 })
    } finally {
      store.close()
    }
  })

  it('嵌套 tx 抛 transaction-nested（不自开第二次 BEGIN）', () => {
    const store = createSagaStore({ dbPath: ':memory:' })
    try {
      expect(() =>
        store.tx(() => {
          store.tx(() => undefined)
        }),
      ).toThrow(/transaction-nested/)
    } finally {
      store.close()
    }
  })
})
