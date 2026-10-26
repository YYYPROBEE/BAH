/**
 * 9 态状态机（方案 §3.4 + W11 的 `incident`）。
 *
 * 一张表定合法转移，`transition()` 是唯一入口。**不许引入第二个状态集**——
 * `PlanNodeState` 来自 `types.ts`，`TERMINAL_STATES` 也被本文件复用，三方同源。
 *
 * 三个容易写错的地方（方案 §3.4 明确点出 + W11 补一条）：
 * 1. `pending → blocked` **必须合法**：上游失败时下游从未 `ready` 就进 `blocked`；
 *    写成"只有 ready 才能 block"，失败传播永远跑不到。
 * 2. `skipped` 是终态但**算依赖满足**（判定在引擎的 `depsSatisfied`，不在本表）。
 * 3. `incident` **只可由 `running` 进入**，进表时是终态（后继为空）。
 *    它"可被 resume 重置"不是一条转移：`resume` 用 seed 直接覆盖初始状态，
 *    刻意不经过 `transition()`（seed 是"上次已发生的事实"，不是一次状态演进）。
 *    代价写清：**除 seed 外没有任何合法路径能离开 `incident`**——这正是要的。
 */

import { BahError } from '@bah/util'

import { TERMINAL_STATES } from './types.ts'

import type { PlanNodeState } from './types.ts'

/** 合法转移表（终态一律空数组）。 */
const ALLOWED: Readonly<Record<PlanNodeState, readonly PlanNodeState[]>> = {
  pending: ['ready', 'blocked', 'skipped', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'incident'],
  succeeded: [],
  failed: [],
  skipped: [],
  blocked: [],
  cancelled: [],
  incident: [],
}

/** 是否终态（与 `TERMINAL_STATES` 同源，供快照与统计复用）。 */
export function isTerminal(state: PlanNodeState): boolean {
  return TERMINAL_STATES.has(state)
}

/** 该转移是否合法（纯查表）。 */
export function canTransition(from: PlanNodeState, to: PlanNodeState): boolean {
  return ALLOWED[from].includes(to)
}

/**
 * 执行一次转移。
 *
 * @throws `BahError('plan-illegal-transition')` 非法转移
 */
export function transition(from: PlanNodeState, to: PlanNodeState): PlanNodeState {
  if (!canTransition(from, to)) {
    throw new BahError('plan-illegal-transition', `plan 节点状态非法转移：${from} → ${to}`, {
      from,
      to,
    })
  }
  return to
}

/** 合法转移表（只读视图，测试全矩阵用）。 */
export const PLAN_STATE_TRANSITIONS: Readonly<
  Record<PlanNodeState, readonly PlanNodeState[]>
> = ALLOWED
