import { describe, expect, it } from 'vitest'

import { createUsageLedger } from './usage.ts'

/** 固定种子的 LCG：100 条事件的可复现生成器。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state
  }
}

describe('usage · 增量与全量重建', () => {
  it('100 条固定种子事件：增量 == 全量', () => {
    const random = seeded(0xba11)
    const events = Array.from({ length: 100 }, () => ({
      type: 'usage/summary',
      data: {
        turn: random() % 7,
        input: random() % 1000,
        output: random() % 500,
        cachedInput: random() % 200,
        costMicroYuan: random() % 10000,
      },
    }))

    const incremental = createUsageLedger()
    for (const event of events) incremental.observe(event)

    const rebuilt = createUsageLedger()
    rebuilt.rebuild(events)

    expect(incremental.total()).toEqual(rebuilt.total())
    for (let turn = 0; turn < 7; turn += 1) {
      expect(incremental.ofTurn(turn)).toEqual(rebuilt.ofTurn(turn))
    }
  })

  it('非 usage/summary 事件直接忽略；重复 observe 是累加不是覆盖', () => {
    const ledger = createUsageLedger()
    ledger.observe({ type: 'turn/end', data: { turn: 1 } })
    expect(ledger.total()).toEqual({ input: 0, output: 0, cachedInput: 0, costMicroYuan: 0, turns: 0 })

    ledger.observe({ type: 'usage/summary', data: { turn: 1, input: 10, output: 5, cachedInput: 1, costMicroYuan: 100 } })
    ledger.observe({ type: 'usage/summary', data: { turn: 1, input: 10, output: 5, cachedInput: 1, costMicroYuan: 100 } })
    expect(ledger.ofTurn(1)).toEqual({ input: 20, output: 10, cachedInput: 2, costMicroYuan: 200 })
    expect(ledger.total().turns).toBe(1)
  })

  it('非法/负数/小数一律按 0（金额不做浮点猜测）', () => {
    const ledger = createUsageLedger()
    ledger.observe({
      type: 'usage/summary',
      data: { turn: 1, input: -1, output: 1.5, cachedInput: 'x', costMicroYuan: Number.NaN },
    })
    expect(ledger.ofTurn(1)).toEqual({ input: 0, output: 0, cachedInput: 0, costMicroYuan: 0 })
  })

  it('rebuild 清空旧账（重启后重建不会叠加）', () => {
    const ledger = createUsageLedger()
    ledger.observe({ type: 'usage/summary', data: { turn: 1, input: 100, output: 0, cachedInput: 0, costMicroYuan: 0 } })
    ledger.rebuild([{ type: 'usage/summary', data: { turn: 2, input: 1, output: 1, cachedInput: 0, costMicroYuan: 0 } }])
    expect(ledger.ofTurn(1)).toEqual({ input: 0, output: 0, cachedInput: 0, costMicroYuan: 0 })
    expect(ledger.total().input).toBe(1)
    expect(ledger.total().turns).toBe(1)
  })
})
