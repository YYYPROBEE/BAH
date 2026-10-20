/**
 * `advance` 的 CAS 失败路径（状态机唯一的写入口）。
 *
 * 为什么值得单独一条：`advance` 的 happy path 在很多用例里被顺带覆盖，
 * 但"版本已被别人推进"这条分支几乎不会被顺带走到。它是资金补偿状态机的
 * 并发防线——CAS 失败若被当成成功，两个协调者会各自补偿一次。
 */

import { createSagaStore } from '@bah/persistence'
import { describe, expect, it } from 'vitest'

import { advance } from './index.ts'

import type { SagaTransaction } from '@bah/persistence'

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

describe('advance · CAS 版本冲突', () => {
  it('落后版本推进必须抛 version-conflict，且不改状态', () => {
    const store = createSagaStore({ dbPath: ':memory:' })
    try {
      store.tx((tx) => tx.insertTransaction(transaction()))

      // 第一个推进者拿到 v1 → 成功，库里版本变为 v2。
      expect(() => advance(store, 's1', 'CREATED', 'RUNNING', 1, 200)).not.toThrow()
      expect(store.loadTransaction('s1')).toMatchObject({ state: 'RUNNING', version: 2 })

      // 第二个推进者仍拿着 v1：必须 fail-loud，而不是静默覆盖。
      let caught: unknown
      try {
        advance(store, 's1', 'RUNNING', 'COMPENSATING', 1, 300)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeDefined()
      const failure = caught as { code?: string; detail?: unknown }
      expect(failure.code).toBe('version-conflict')
      // 结构化失败要带上足够的定位信息（谁、什么版本、哪条边）。
      expect(failure.detail).toMatchObject({
        sagaId: 's1',
        version: 1,
        from: 'RUNNING',
        to: 'COMPENSATING',
      })

      // 状态不变：失败方没有写进去。
      expect(store.loadTransaction('s1')).toMatchObject({ state: 'RUNNING', version: 2 })
    } finally {
      store.close()
    }
  })

  it('非法出边先于 CAS 被拒（不消耗版本）', () => {
    const store = createSagaStore({ dbPath: ':memory:' })
    try {
      store.tx((tx) => tx.insertTransaction(transaction()))
      expect(() => advance(store, 's1', 'CREATED', 'SUCCEEDED', 1, 200)).toThrow(
        /illegal-transition/,
      )
      expect(store.loadTransaction('s1')).toMatchObject({ state: 'CREATED', version: 1 })
    } finally {
      store.close()
    }
  })
})
