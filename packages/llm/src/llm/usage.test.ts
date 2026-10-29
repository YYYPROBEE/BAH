import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { UsageLedger } from './usage.ts'

/** 取抛出物的 code（不引入额外测试依赖）。 */
function codeOf(run: () => void): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('UsageLedger（施工单 05 §3 成本账本）', () => {
  it('T-LLM-004 usage 记账：每 turn 汇总 input/output tokens', () => {
    const ledger = new UsageLedger()
    ledger.record(1, { input: 100, output: 20 })
    ledger.record(1, { input: 150, output: 40 })
    ledger.record(2, { input: 10, output: 5 })

    expect(ledger.get(1)).toEqual({
      turn: 1,
      input: 250,
      output: 60,
      calls: 2,
      cachedInput: 0,
      costMicroYuan: 0,
    })
    expect(ledger.get(2)).toEqual({
      turn: 2,
      input: 10,
      output: 5,
      calls: 1,
      cachedInput: 0,
      costMicroYuan: 0,
    })
    // 未调用过的 turn 是全零，不是抛错（"没调用"是合法状态）
    expect(ledger.get(3)).toEqual({
      turn: 3,
      input: 0,
      output: 0,
      calls: 0,
      cachedInput: 0,
      costMicroYuan: 0,
    })
    expect(ledger.size).toBe(2)
    expect(ledger.totals()).toEqual({
      input: 260,
      output: 65,
      cachedInput: 0,
      costMicroYuan: 0,
    })
  })

  it('缓存命中与费用按 turn 累加，totals 一并汇总', () => {
    const ledger = new UsageLedger()
    ledger.record(1, { input: 1_000, output: 100, cachedInput: 800, costMicroYuan: 42 })
    ledger.record(1, { input: 500, output: 50, cachedInput: 500, costMicroYuan: 8 })

    expect(ledger.get(1)).toEqual({
      turn: 1,
      input: 1_500,
      output: 150,
      calls: 2,
      cachedInput: 1_300,
      costMicroYuan: 50,
    })
    expect(ledger.totals()).toEqual({
      input: 1_500,
      output: 150,
      cachedInput: 1_300,
      costMicroYuan: 50,
    })
  })

  it('cachedInput 超出 input 不得报负数费用（计价层已 clamp，账本只校验非负）', () => {
    const ledger = new UsageLedger()
    expect(codeOf(() => ledger.record(1, { input: 1, output: 1, cachedInput: -1 }))).toBe(
      'llm-usage-invalid',
    )
  })

  it('一个 turn 只结一次账（防重复落账把审计数字翻倍）', () => {
    const ledger = new UsageLedger()
    ledger.record(1, { input: 7, output: 3 })

    expect(ledger.finishTurn(1)).toEqual({
      turn: 1,
      input: 7,
      output: 3,
      calls: 1,
      cachedInput: 0,
      costMicroYuan: 0,
    })
    expect(ledger.finishTurn(1)).toBeUndefined()
  })

  it('turn 必须是非负整数，其余一律 fail-loud', () => {
    const ledger = new UsageLedger()
    expect(() => ledger.record(-1, { input: 1, output: 1 })).toThrowError(BahError)
    expect(() => ledger.record(1.5, { input: 1, output: 1 })).toThrowError(/turn 必须是非负整数/)
  })

  it('usage 数值必须是有限非负数（NaN / 负数不得静默入账）', () => {
    const ledger = new UsageLedger()
    expect(codeOf(() => ledger.record(1, { input: Number.NaN, output: 1 }))).toBe(
      'llm-usage-invalid',
    )
    expect(codeOf(() => ledger.record(1, { input: 1, output: -1 }))).toBe('llm-usage-invalid')
  })
})
