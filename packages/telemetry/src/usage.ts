/**
 * 用量账本（可观测性 02 / S2.5）。
 *
 * 允许"增量"是因为 `agent/pre-step` 每个 step 都查一次预算；全量扫事件是 O(n²)。
 * 但它**只是缓存，不是第二真相**：`rebuild(events)` 必须与逐步 `observe` 的结果逐字段相等
 * （`usage.test.ts` 用 100 条固定种子事件钉住这条）。
 *
 * 全部整数相加：`costMicroYuan` 是微元，禁止任何浮点参与。
 */

/** 全量口径。 */
export interface UsageTotals {
  readonly input: number
  readonly output: number
  readonly cachedInput: number
  readonly costMicroYuan: number
  /** 有 `usage/summary` 的 turn 数（不是 `turn/end` 数）。 */
  readonly turns: number
}

/** 单轮口径。 */
export interface TurnUsage {
  readonly input: number
  readonly output: number
  readonly cachedInput: number
  readonly costMicroYuan: number
}

/** 可重建的增量账本。 */
export interface UsageLedger {
  observe(event: { readonly type: string; readonly data: unknown }): void
  total(): UsageTotals
  ofTurn(turn: number): TurnUsage
  /** 最近一条 `usage/summary` 所属的 turn（预算闸在**下一轮**第一步查看上一轮用量）。 */
  lastTurn(): number | undefined
  rebuild(events: readonly { readonly type: string; readonly data: unknown }[]): void
}

/** 从 `usage/summary` 载荷取一个非负整数（缺省/非法按 0）。 */
function integerOf(data: unknown, key: string): number {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 0
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/** 造一个账本（初始为空）。 */
export function createUsageLedger(): UsageLedger {
  const byTurn = new Map<number, TurnUsage>()
  const turns = new Set<number>()
  let lastObservedTurn: number | undefined
  let total: UsageTotals = { input: 0, output: 0, cachedInput: 0, costMicroYuan: 0, turns: 0 }

  const observe = (event: { readonly type: string; readonly data: unknown }): void => {
    if (event.type !== 'usage/summary') return
    const input = integerOf(event.data, 'input')
    const output = integerOf(event.data, 'output')
    const cachedInput = integerOf(event.data, 'cachedInput')
    const costMicroYuan = integerOf(event.data, 'costMicroYuan')
    const turn = integerOf(event.data, 'turn')
    const previous = byTurn.get(turn) ?? { input: 0, output: 0, cachedInput: 0, costMicroYuan: 0 }
    byTurn.set(turn, {
      input: previous.input + input,
      output: previous.output + output,
      cachedInput: previous.cachedInput + cachedInput,
      costMicroYuan: previous.costMicroYuan + costMicroYuan,
    })
    turns.add(turn)
    lastObservedTurn = turn
    total = {
      input: total.input + input,
      output: total.output + output,
      cachedInput: total.cachedInput + cachedInput,
      costMicroYuan: total.costMicroYuan + costMicroYuan,
      turns: turns.size,
    }
  }

  return {
    observe,
    total: () => total,
    ofTurn: (turn) => byTurn.get(turn) ?? { input: 0, output: 0, cachedInput: 0, costMicroYuan: 0 },
    lastTurn: () => lastObservedTurn,
    rebuild(events) {
      byTurn.clear()
      turns.clear()
      lastObservedTurn = undefined
      total = { input: 0, output: 0, cachedInput: 0, costMicroYuan: 0, turns: 0 }
      for (const event of events) observe(event)
    },
  }
}
