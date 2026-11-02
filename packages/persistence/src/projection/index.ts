/**
 * Saga 投影重算（SA-11 §3.5 / O10）。
 *
 * 由链/事件流**离线**重建 saga 状态，与运行时状态比对；`diff=0` 是验收断言。
 * 转移语义**只**来自调用方注入的 `reduceSaga`（`@bah/saga` 的唯一实现）——
 * 本模块不另写映射表，也不运行时 import `@bah/saga`（包边界 SA-07 §2.1）。
 *
 * 零 LLM、零外部调用（A3）。
 */

import { defineService } from '@bah/core'

import type { Context } from '@bah/core'

import type { ChainRecord } from '../chain/index.ts'

/** 投影中间态（与 `@bah/saga` 的 `SagaProjection` 结构兼容）。 */
export interface ProjectionState {
  readonly sagaId: string
  readonly state: string
  readonly steps: Readonly<Record<string, string>>
}

/** 链记录的最小事件面（与 `SagaEventRecord` 结构兼容）。 */
export interface ProjectionEvent {
  readonly sagaId: string
  readonly seqInSaga: number
  readonly type: string
  readonly subjectRef: string
  readonly happensBefore: readonly number[]
  readonly payloadDigest: string
}

/** 唯一转移函数的结构类型（注入 `reduceSaga`）。 */
export type ProjectionReducer = (state: ProjectionState, event: ProjectionEvent) => ProjectionState

/** 只读链面（`ChainFile` 满足）。 */
export interface ProjectionChain {
  read(sagaId: string): readonly ChainRecord[]
}

/** 运行时状态读取面（`bah:saga-store` 的子集）。 */
export interface ProjectionStoreView {
  loadTransaction(sagaId: string): { readonly state: string } | undefined
}

/** 与 `bah:saga-store` 同 id 的结构视图。 */
export const PROJECTION_STORE = defineService<ProjectionStoreView>('bah:saga-store')

/** 回放初值：恒从 `CREATED` 起播（SA-13 §3.3）。 */
export function initialProjection(sagaId: string): ProjectionState {
  return { sagaId, state: 'CREATED', steps: {} }
}

/** 链记录 → 转移所需事件面。 */
export function eventRecordOf(row: ChainRecord): ProjectionEvent {
  return {
    sagaId: row.s,
    seqInSaga: row.q,
    type: row.t,
    subjectRef: row.sub,
    happensBefore: row.hb,
    payloadDigest: row.d,
  }
}

/** 离线全量折叠（不读 `state_snapshot`，不做锚点加速）。 */
export function rebuildSagaState(
  chain: ProjectionChain,
  sagaId: string,
  reduce: ProjectionReducer,
): string {
  let projection = initialProjection(sagaId)
  for (const row of chain.read(sagaId)) {
    projection = reduce(projection, eventRecordOf(row))
  }
  return projection.state
}

/** 投影 vs 运行时：相等返回 0，漂移返回 1（P0 由调用方告警）。 */
export function projectionDiff(
  ctx: Context,
  chain: ProjectionChain,
  sagaId: string,
  reduce: ProjectionReducer,
): number {
  const runtime = ctx.get(PROJECTION_STORE).loadTransaction(sagaId)?.state
  const replayed = rebuildSagaState(chain, sagaId, reduce)
  return replayed === runtime ? 0 : 1
}
