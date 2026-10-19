/**
 * 时间旅行回放（SA-13 §3.3 / O10 / A3）。
 *
 * 纪律：
 * - **一律从 `CREATED` 全量折叠**，不用 `state_snapshot` 加速（该表只作定位/展示）；
 * - 转移语义**唯一**来自 `reduceSaga`（与运行时 `advance` 同源），本文件不写映射表；
 * - **零 LLM、零外部调用**：只读装配位注入的链记录；
 * - 不 import `@bah/persistence`（链读面由 `ReplayDeps` 注入）。
 */

import { page } from '../alert/index.ts'
import { SAGA_STORE } from '../seams.ts'
import { initialProjection as defaultInitialProjection } from '../state-machine/index.ts'
import { reduceSaga } from '../state-machine/reduce.ts'

import type { Context } from '@bah/core'

import type { SagaEventRecord, SagaProjection, SagaState } from '../types.ts'

/** 回放依赖：链只读面 + 初始投影（装配位注入）。 */
export interface ReplayDeps {
  /** `audit.jsonl` 只读面；返回**含转移所需最小面**的链记录。 */
  readonly readStream: (sagaId: string) => readonly SagaEventRecord[]
  /** 该 saga 的初始投影；缺省即 `CREATED` 空投影。 */
  readonly initialProjection?: (sagaId: string) => SagaProjection
}

/** 回放结果：逐事件状态序列 + 终态。 */
export interface ReplayResult {
  readonly states: readonly SagaState[]
  readonly finalState: SagaState
}

/**
 * 时间旅行回放：给定 `sagaId`（可 `upto` 截断到前 N 条事件），离线全量重建状态序列。
 *
 * @param upto 事件**条数**截断；`undefined` = 全量
 */
export function replay(
  _ctx: Context,
  sagaId: string,
  upto: number | undefined,
  deps: ReplayDeps,
): ReplayResult {
  const rows = deps.readStream(sagaId)
  const events = upto === undefined ? rows : rows.slice(0, Math.max(0, upto))
  const initial = (deps.initialProjection ?? defaultInitialProjection)(sagaId)
  let projection = initial
  const states: SagaState[] = [projection.state]
  for (const event of events) {
    projection = reduceSaga(projection, event)
    states.push(projection.state)
  }
  return { states, finalState: projection.state }
}

/** 回放终态 vs 运行时终态（diff 只取 0/1）。 */
export function replayDiff(ctx: Context, sagaId: string, deps: ReplayDeps): number {
  const runtime = ctx.get(SAGA_STORE).loadTransaction(sagaId)?.state
  const replayed = replay(ctx, sagaId, undefined, deps).finalState
  return replayed === runtime ? 0 : 1
}

/**
 * 确定性断言：`replay` 终态 == 运行时终态；不等 → P0 进告警汇（不 throw，便于验收统计）。
 *
 * @returns `true` = diff=0
 */
export function assertReplayDiffZero(ctx: Context, sagaId: string, deps: ReplayDeps): boolean {
  const runtime = ctx.get(SAGA_STORE).loadTransaction(sagaId)?.state
  const replayed = replay(ctx, sagaId, undefined, deps).finalState
  if (replayed === runtime) return true
  page(ctx, 'P0', `回放 diff≠0：${sagaId} replay=${replayed} runtime=${String(runtime)}`)
  return false
}
