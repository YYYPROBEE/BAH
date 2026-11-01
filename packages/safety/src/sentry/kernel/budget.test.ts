/**
 * 内核·动作预算账本用例。
 * 源用例：`tests/kernel.test.js` 的 budget 段 1 条全量搬迁；另补 amount 兜底位、
 * 未登记维度的默认拒绝、快照副本与账本签发/复用。
 */

import { describe, expect, it } from 'vitest'

import { Budget, BudgetLedger } from './budget.ts'

describe('Budget·先记账再比对', () => {
  it('超限即 false（第三笔花到 3，上限 2）', () => {
    const budget = new Budget({ total_calls: 2 })
    expect(budget.tryConsume('total_calls', 1)).toEqual({ ok: true, spent: 1, limit: 2 })
    expect(budget.tryConsume('total_calls', 1)).toEqual({ ok: true, spent: 2, limit: 2 })
    expect(budget.tryConsume('total_calls', 1)).toEqual({ ok: false, spent: 3, limit: 2 })
    // 超限后继续花费仍按累加口径记账（不是"回滚"，账本要能对上实际发生量）
    expect(budget.tryConsume('total_calls', 5)).toEqual({ ok: false, spent: 8, limit: 2 })
  })

  it('金额维度恒有上限位：漏配即 0（默认拒绝）', () => {
    const budget = new Budget({ total_calls: 2 })
    expect(budget.limits).toEqual({ amount: 0, total_calls: 2 })
    expect(budget.tryConsume('amount', 1)).toEqual({ ok: false, spent: 1, limit: 0 })
    expect(new Budget({ amount: 1000 }).tryConsume('amount', 1000)).toEqual({ ok: true, spent: 1000, limit: 1000 })
  })

  it('未登记维度 = 上限 0（配置没给就不是可花的东西）', () => {
    expect(new Budget({ total_calls: 2 }).tryConsume('risky_calls', 1)).toEqual({
      ok: false,
      spent: 1,
      limit: 0,
    })
  })

  it('零花费不超限（边界：等于上限仍放行）', () => {
    const budget = new Budget({ total_calls: 0 })
    expect(budget.tryConsume('total_calls', 0)).toEqual({ ok: true, spent: 0, limit: 0 })
    expect(budget.tryConsume('total_calls', 1)).toEqual({ ok: false, spent: 1, limit: 0 })
  })

  it('快照是副本：外部改不动账本', () => {
    const budget = new Budget({ total_calls: 2 })
    budget.tryConsume('total_calls', 1)
    const snapshot = budget.snapshot()
    expect(snapshot).toEqual({ limits: { amount: 0, total_calls: 2 }, spent: { amount: 0, total_calls: 1 } })
    snapshot.spent.total_calls = 99
    snapshot.limits.total_calls = 99
    expect(budget.snapshot()).toEqual({ limits: { amount: 0, total_calls: 2 }, spent: { amount: 0, total_calls: 1 } })
  })
})

describe('BudgetLedger·会话级懒初始化', () => {
  it('get 未签发时按默认上限建预算，并复用同一实例', () => {
    const ledger = new BudgetLedger({ total_calls: 3 })
    const budget = ledger.get('s1')
    expect(budget.limits).toEqual({ amount: 0, total_calls: 3 })
    expect(ledger.get('s1')).toBe(budget)
    expect(ledger.get('s2')).not.toBe(budget)
  })

  it('issue 在默认之上浅合并覆盖项', () => {
    const ledger = new BudgetLedger({ total_calls: 3 })
    expect(ledger.issue('s1', { amount: 100 }).snapshot()).toEqual({
      limits: { amount: 100, total_calls: 3 },
      spent: { amount: 0, total_calls: 0 },
    })
    expect(ledger.issue('s2').limits).toEqual({ amount: 0, total_calls: 3 })
  })

  it('issue 覆盖即重置花费（模板切换不留旧账）', () => {
    const ledger = new BudgetLedger({ total_calls: 3 })
    ledger.get('s1').tryConsume('total_calls', 2)
    expect(ledger.issue('s1', { total_calls: 5 }).spent).toEqual({ amount: 0, total_calls: 0 })
    expect(ledger.get('s1').tryConsume('total_calls', 1)).toEqual({ ok: true, spent: 1, limit: 5 })
  })

  it('默认表缺省为空（不配置 = 只有 amount 的 0 兜底位）', () => {
    expect(new BudgetLedger().get('s1').limits).toEqual({ amount: 0 })
  })
})
