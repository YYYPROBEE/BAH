/**
 * T-SA10-001~004：模板注册期校验、计划期绑定、版本冻结、载荷投影确定性（批 3 数据面）。
 */

import { createContext } from '@bah/core'
import { createSagaStore } from '@bah/persistence'
import { describe, expect, it } from 'vitest'

import { SAGA_STORE, SAGA_TEMPLATES } from '../seams.ts'
import { bindAtPlan, installTemplates, projectPayload, registerTemplate } from './index.ts'

import type { Context } from '@bah/core'
import type { PlannedStep } from '../coordinator/plan.ts'
import type { CompKind, CompTemplate, SideEffectClass } from '../types.ts'

interface Harness {
  readonly ctx: Context
  readonly store: ReturnType<typeof createSagaStore>
}

function harness(): Harness {
  const store = createSagaStore({ dbPath: ':memory:' })
  const ctx = createContext()
  ctx.provide(SAGA_STORE, store)
  installTemplates(ctx)
  return { ctx, store }
}

function seedSaga(store: Harness['store'], sagaId: string, steps: readonly PlannedStep[]): void {
  store.tx((tx) => {
    tx.insertTransaction({
      sagaId,
      businessType: 'TRANSFER',
      traceId: 'trace-1',
      state: 'RUNNING',
      version: 1,
      timeoutBudgetMs: 60_000,
      compStrategy: 'AUTO',
      initiator: '{}',
      frozen: false,
      createdAt: 1,
      updatedAt: 1,
    })
    steps.forEach((step, index) => {
      tx.insertStep({
        stepId: step.stepId,
        sagaId,
        seqNo: index + 1,
        topologyDeps: [],
        toolName: step.toolName,
        endpoint: `/tool/${step.toolName}`,
        sideEffectClass: step.sideEffectClass,
        idempotencyKey: step.idemKey,
        idempotencyNonce: step.nonce,
        state: 'PLANNED',
        attempts: 0,
        maxAttempts: 3,
        deadlineMs: 5_000,
      })
    })
  })
}

function planStep(
  stepId: string,
  toolName: string,
  sideEffectClass: SideEffectClass = 'EXTERNAL_UNDOABLE',
): PlannedStep {
  return {
    stepId,
    seqNo: 1,
    toolName,
    endpoint: `/tool/${toolName}`,
    sideEffectClass,
    idemKey: `FWD:${stepId}`,
    nonce: `nonce-${stepId}`,
    topologyDeps: [],
    deadlineMs: 5_000,
  }
}

function template(overrides: Partial<CompTemplate> = {}): CompTemplate {
  return {
    templateId: 'refund-template',
    templateVersion: 1,
    targetTool: 'payment.charge',
    compKind: 'FULL_REFUND',
    compEndpoint: '/comp/refund',
    compIdempotent: true,
    residualRules: ['FEE'],
    approvalRequired: false,
    payloadProjection: JSON.stringify({
      fields: [
        { from: 'payment.amount', to: 'amount' },
        { from: 'payment.currency', to: 'currency', default: 'CNY' },
        { from: 'payment.note', to: 'memo' },
      ],
    }),
    status: 'ACTIVE',
    ...overrides,
  }
}

describe('模板注册表（SA-10 数据面）', () => {
  it('T-SA10-001：副作用步骤无 ACTIVE 模板 → no-template，计划期拒绝且零绑定', () => {
    const test = harness()
    const steps = [planStep('s1', 'payment.charge')]
    seedSaga(test.store, 'saga-1', steps)

    // 有模板但 targetTool 不匹配，等同于无模板。
    registerTemplate(test.ctx, template({ targetTool: 'other.tool' }))

    expect(() => bindAtPlan(test.ctx, 'saga-1', steps)).toThrowError(/no-template/)
    expect(test.store.tx((tx) => tx.listCompensations('saga-1'))).toHaveLength(0)
  })

  it('T-SA10-002：IRREVERSIBLE 只接受 MANUAL_ONLY；NONE 步骤跳过绑定', () => {
    const test = harness()
    const irreversible = [planStep('irr-1', 'payment.charge', 'IRREVERSIBLE')]
    seedSaga(test.store, 'saga-1', irreversible)
    registerTemplate(test.ctx, template({ compKind: 'FULL_REFUND' }))

    expect(() => bindAtPlan(test.ctx, 'saga-1', irreversible)).toThrowError(/MANUAL_ONLY/)
    expect(test.store.tx((tx) => tx.listCompensations('saga-1'))).toHaveLength(0)

    const manual = harness()
    const manualSteps = [planStep('irr-2', 'payment.charge', 'IRREVERSIBLE')]
    seedSaga(manual.store, 'saga-2', manualSteps)
    registerTemplate(manual.ctx, template({ compKind: 'MANUAL_ONLY', approvalRequired: true }))
    bindAtPlan(manual.ctx, 'saga-2', manualSteps)
    expect(manual.store.tx((tx) => tx.listCompensations('saga-2'))).toHaveLength(1)

    // NONE 步骤不需要模板，也不产生绑定。
    const none = [planStep('none-1', 'account.query', 'NONE')]
    seedSaga(test.store, 'saga-3', none)
    bindAtPlan(test.ctx, 'saga-3', none)
    expect(test.store.tx((tx) => tx.listCompensations('saga-3'))).toHaveLength(0)
  })

  it('T-SA10-003：绑定后注册 v2，compensating_action 仍记 v1，boundFor 读回 v1', () => {
    const test = harness()
    const steps = [planStep('s1', 'payment.charge')]
    seedSaga(test.store, 'saga-1', steps)
    registerTemplate(test.ctx, template({ templateVersion: 1, compEndpoint: '/comp/refund-v1' }))

    bindAtPlan(test.ctx, 'saga-1', steps)
    registerTemplate(test.ctx, template({ templateVersion: 2, compEndpoint: '/comp/refund-v2' }))

    const bound = test.store.tx((tx) => tx.listCompensations('saga-1'))
    expect(bound).toHaveLength(1)
    expect(bound[0]).toMatchObject({ templateId: 'refund-template', templateVersion: 1 })

    expect(test.ctx.get(SAGA_TEMPLATES).findActive('payment.charge')?.templateVersion).toBe(2)
    const frozen = test.ctx.get(SAGA_TEMPLATES).boundFor('saga-1', 's1')
    expect(frozen?.templateVersion).toBe(1)
    expect(frozen?.compEndpoint).toBe('/comp/refund-v1')
  })

  it('T-SA10-004：载荷投影确定、缺失取默认、嵌套路径、无副作用', () => {
    const test = harness()
    const compiled = template()
    const snapshot = { payment: { amount: 100, currency: 'USD', note: '订单 A' } }
    const before = JSON.stringify(snapshot)

    const first = projectPayload(compiled, snapshot)
    const second = projectPayload(compiled, snapshot)

    expect(first).toEqual({ amount: 100, currency: 'USD', memo: '订单 A' })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(Object.keys(first)).toEqual(['amount', 'currency', 'memo'])

    // 缺失字段取默认值；默认值也缺失时保留 undefined（键位仍在，投影完备）。
    const partial = projectPayload(compiled, { payment: { amount: 1 } })
    expect(partial).toEqual({ amount: 1, currency: 'CNY' })
    expect(Object.keys(partial)).toEqual(['amount', 'currency', 'memo'])

    // 纯函数：不改写入参，也不依赖任何外部服务（`test` 只用来提供 store）。
    expect(JSON.stringify(snapshot)).toBe(before)
    void test
  })

  it('计划期同一提交段内绑定不嵌套事务（传 tx）', () => {
    const test = harness()
    registerTemplate(test.ctx, template())
    const steps = [planStep('tx-1', 'payment.charge')]

    test.store.tx((tx) => {
      tx.insertTransaction({
        sagaId: 'saga-tx',
        businessType: 'TRANSFER',
        traceId: 'trace-tx',
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
        stepId: 'tx-1',
        sagaId: 'saga-tx',
        seqNo: 1,
        topologyDeps: [],
        toolName: 'payment.charge',
        endpoint: '/tool/payment.charge',
        sideEffectClass: 'EXTERNAL_UNDOABLE',
        idempotencyKey: 'FWD:tx-1',
        idempotencyNonce: 'nonce-tx-1',
        state: 'PLANNED',
        attempts: 0,
        maxAttempts: 3,
        deadlineMs: 5_000,
      })
      bindAtPlan(test.ctx, 'saga-tx', steps, tx)
      expect(tx.listCompensations('saga-tx')).toHaveLength(1)
    })

    expect(test.store.tx((tx) => tx.listCompensations('saga-tx'))[0]?.stepId).toBe('tx-1')
  })

  it('注册期校验：非法 JSON / MANUAL_ONLY 配金额 / 版本覆盖 → 拒绝且不落库', () => {
    const test = harness()
    const badJson = template({ templateId: 'bad-json', payloadProjection: '{oops' })
    expect(() => registerTemplate(test.ctx, badJson)).toThrowError(/invalid-template/)
    expect(test.store.findActiveTemplate('payment.charge')).toBeUndefined()

    const manualWithAmount = template({
      templateId: 'bad-manual',
      compKind: 'MANUAL_ONLY' as CompKind,
      amountThreshold: 10,
    })
    expect(() => registerTemplate(test.ctx, manualWithAmount)).toThrowError(/MANUAL_ONLY/)

    const emptyFields = template({
      templateId: 'bad-fields',
      payloadProjection: JSON.stringify({ fields: [] }),
    })
    expect(() => registerTemplate(test.ctx, emptyFields)).toThrowError(/fields/)

    registerTemplate(test.ctx, template())
    expect(() => registerTemplate(test.ctx, template())).toThrowError(/禁止覆盖/)
  })
})
