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

    expect(ledger.get(1)).toEqual({ turn: 1, input: 250, output: 60, calls: 2 })
    expect(ledger.get(2)).toEqual({ turn: 2, input: 10, output: 5, calls: 1 })
    // 未调用过的 turn 是全零，不是抛错（"没调用"是合法状态）
    expect(ledger.get(3)).toEqual({ turn: 3, input: 0, output: 0, calls: 0 })
    expect(ledger.size).toBe(2)
    expect(ledger.totals()).toEqual({ input: 260, output: 65 })
  })

  it('一个 turn 只结一次账（防重复落账把审计数字翻倍）', () => {
    const ledger = new UsageLedger()
    ledger.record(1, { input: 7, output: 3 })

    expect(ledger.finishTurn(1)).toEqual({ turn: 1, input: 7, output: 3, calls: 1 })
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
