/**
 * 对账接缝的**类型面**（SA-12 §3.2）。
 *
 * 放在独立文件是为了避免 `index → amendment → index` 的运行时环：
 * 这里只有 interface / type，编译后零可执行行。
 */

/** 链事件流一条只读行（结构化类型，避免 `@bah/saga` 运行时 import `@bah/persistence`）。 */
export interface ChainRow {
  readonly q: number
  readonly t: string
  readonly sub: string
  readonly hb?: readonly number[]
}

/**
 * 对账依赖：由 **host 装配位**注入 SA-11 的真实实现。
 *
 * `projectionDiff` = 离线投影 vs 运行时状态的差异条数；`readStream` = `audit.jsonl` 只读面。
 * 二者都不在本包内实现（依赖纪律：`@bah/persistence` 只在 devDependencies）。
 */
export interface ReconDeps {
  readonly projectionDiff: (sagaId: string) => number
  readonly readStream: (sagaId: string) => readonly ChainRow[]
}

/** 外部对账单的一行（mock 网关，README C3）。 */
export interface ExternalStatementRow {
  readonly sagaId: string
  readonly externalState: string
  /** 外部发现、本地未收尾的副作用（step / comp 标识）。 */
  readonly danglingEffects: readonly string[]
}

/** 外部对账单查询：返回给定 saga 区间的外部实际终态与悬垂副作用。 */
export type ExternalStatement = (
  sagaIds: readonly string[],
) => Promise<readonly ExternalStatementRow[]>

/** 单批对账结果。 */
export interface ReconResult {
  readonly batchId: string
  readonly diffCount: number
  readonly amendmentSagaId?: string
}

/** 一个对账批次：`fromIndex` = 区间序号（与 period 一起构成确定性 batchId）。 */
export interface ReconBatch {
  readonly fromIndex: number
  readonly sagaIds: readonly string[]
}

/** 一次 recon job 的汇总。 */
export interface ReconJobResult {
  readonly batches: readonly ReconResult[]
  readonly drill: boolean
}

/** recon job 的可选覆盖（测试与手工演练用；tick 派发时省略）。 */
export interface ReconJobOptions {
  /** 覆盖「本周是否演练」的判定。 */
  readonly drill?: boolean
  /** 演练注入差异的目标 saga（缺省取本轮第一个 active saga）。 */
  readonly drillSagaId?: string
}
