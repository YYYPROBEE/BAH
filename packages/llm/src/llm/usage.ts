/**
 * 成本账本（施工单 05 §3「按 turn 汇总 input/output tokens，进入审计导出」）。
 *
 * 分工明确：
 * - 本类**只做记账**（纯内存、可单测），不碰会话日志、不认识 session——落账由主循环在
 *   turn 边界把 `finishTurn()` 的返回值写成 `usage/summary` 事件（阶段 5 接线）；
 * - 一个 turn 只结一次：`finishTurn` 二次调用返回 `undefined`，防止重复落账把审计数字翻倍。
 */

import { BahError } from '@bah/util'

import type { CallUsage, TurnUsage } from './types.ts'

interface TurnSlot {
  input: number
  output: number
  calls: number
  cachedInput: number
  costMicroYuan: number
}

export class UsageLedger {
  /** turn → 累计用量（`Map` 保插入顺序，便于按 turn 导出）。 */
  private readonly turns = new Map<number, TurnSlot>()

  /** 已结账的 turn（防重复落账）。 */
  private readonly finished = new Set<number>()

  /**
   * 记一次调用的用量。
   *
   * @throws `BahError('llm-usage-turn-invalid')` `turn` 不是非负整数
   * @throws `BahError('llm-usage-invalid')` usage 不是有限非负数（NaN / 负数静默入账会污染成本审计）
   */
  record(turn: number, usage: CallUsage): void {
    if (!Number.isInteger(turn) || turn < 0) {
      throw new BahError('llm-usage-turn-invalid', `llm: turn 必须是非负整数（收到 ${turn}）`, {
        turn,
      })
    }
    for (const key of ['input', 'output', 'cachedInput', 'costMicroYuan'] as const) {
      const value = usage[key]
      if (value === undefined) continue
      if (!Number.isFinite(value) || value < 0) {
        throw new BahError('llm-usage-invalid', `llm: usage.${key} 必须是有限非负数（收到 ${String(value)}）`, {
          turn,
          field: key,
          value,
        })
      }
    }
    const slot = this.turns.get(turn) ?? {
      input: 0,
      output: 0,
      calls: 0,
      cachedInput: 0,
      costMicroYuan: 0,
    }
    slot.input += usage.input
    slot.output += usage.output
    slot.cachedInput += usage.cachedInput ?? 0
    slot.costMicroYuan += usage.costMicroYuan ?? 0
    slot.calls += 1
    this.turns.set(turn, slot)
  }

  /** 读某 turn 的累计（未记录过则全零，不抛错——"没调用过"是合法状态）。 */
  get(turn: number): TurnUsage {
    const slot = this.turns.get(turn) ?? {
      input: 0,
      output: 0,
      calls: 0,
      cachedInput: 0,
      costMicroYuan: 0,
    }
    return {
      turn,
      input: slot.input,
      output: slot.output,
      calls: slot.calls,
      cachedInput: slot.cachedInput,
      costMicroYuan: slot.costMicroYuan,
    }
  }

  /**
   * 结账：返回该 turn 的汇总并标记已结。
   *
   * @returns 首次调用返回汇总；重复调用返回 `undefined`（调用方据此跳过重复落账）
   */
  finishTurn(turn: number): TurnUsage | undefined {
    if (this.finished.has(turn)) return undefined
    this.finished.add(turn)
    return this.get(turn)
  }

  /** 全量汇总（跨 turn；用于"本次会话总共花了多少"）。 */
  totals(): Required<CallUsage> {
    let input = 0
    let output = 0
    let cachedInput = 0
    let costMicroYuan = 0
    for (const slot of this.turns.values()) {
      input += slot.input
      output += slot.output
      cachedInput += slot.cachedInput
      costMicroYuan += slot.costMicroYuan
    }
    return { input, output, cachedInput, costMicroYuan }
  }

  /** 已记录的 turn 数（调试/断言用）。 */
  get size(): number {
    return this.turns.size
  }
}
