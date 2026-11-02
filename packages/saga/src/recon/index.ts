/**
 * 每日对账 + 修正 saga（SA-12 §3.2，批 5）。
 *
 * 纪律：
 * - 按 `reconBatchSize` 切窗，逐窗处理，避免读密集长事务；
 * - 投影/链读面**只经** `ReconDeps` 注入（`@bah/saga` 不 import `@bah/persistence`）；
 * - `batchId = recon:<period>:<fromIndex>` 确定性生成，重复重入同批不产生第二个 id；
 * - 本模块不自建定时器；批 5 只提供可直调的 job 纯函数，派发属批 6。
 */

import { noopAlertSink } from '../alert/sink.ts'
import { commitSegment } from '../coordinator/commit.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE } from '../seams.ts'
import { lastJobHeartbeat, recordJobHeartbeat } from '../tick/registry.ts'

import { createAmendmentSaga } from './amendment.ts'

import type { Context } from '@bah/core'
import type { AlertSink } from '../alert/sink.ts'
import type { SagaSettings } from '../types.ts'
import type {
  ExternalStatement,
  ReconBatch,
  ReconDeps,
  ReconJobOptions,
  ReconJobResult,
  ReconResult,
} from './types.ts'

/** 1 天与 2 天的毫秒数（心跳分级口径）。 */
const DAY_MS = 86_400_000

/** 同一 Context 内已完成批次的缓存：同 batchId 重入直接返回，避免重复建修正 saga。 */
const batchResults = new WeakMap<Context, Map<string, ReconResult>>()

/** UTC 日期键；只由注入时钟的毫秒数决定，便于 batchId 确定性复算。 */
export function reconPeriodOf(at: number): string {
  const date = new Date(at)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}

/** 本周是否演练窗：每 7 个 anchor 间隔一次（第 0 个间隔不演练，避免首个 tick 假告警）。 */
export function isDrillWindow(at: number, settings: SagaSettings): boolean {
  const slot = Math.floor(at / settings.anchorIntervalMs)
  return slot > 0 && slot % 7 === 0
}

function cacheOf(ctx: Context): Map<string, ReconResult> {
  let cache = batchResults.get(ctx)
  if (cache === undefined) {
    cache = new Map<string, ReconResult>()
    batchResults.set(ctx, cache)
  }
  return cache
}

/**
 * 一个对账批次：投影重算 vs 运行时状态（diff≠0 → P0），再外部对账（悬垂 → 修正 saga）。
 *
 * 同一 `batchId` 重入返回首次结果（确定性底座）；不同批次互不影响。
 */
export async function reconcileBatch(
  ctx: Context,
  settings: SagaSettings,
  batch: ReconBatch,
  statement: ExternalStatement,
  deps: ReconDeps,
  alerts: AlertSink = noopAlertSink,
): Promise<ReconResult> {
  const store = ctx.get(SAGA_STORE)
  const at = ctx.get(SAGA_CLOCK).now()
  const batchId = `recon:${reconPeriodOf(at)}:${batch.fromIndex}`

  const cache = cacheOf(ctx)
  const cached = cache.get(batchId)
  if (cached !== undefined) return cached

  const sagaIds = batch.sagaIds.slice(0, settings.reconBatchSize)
  let diffCount = 0
  for (const sagaId of sagaIds) {
    if (deps.projectionDiff(sagaId) !== 0) {
      diffCount += 1
      alerts('P0', `projection-diff:${sagaId}`)
    }
  }

  const rows = await statement(sagaIds)
  const dangling = rows.filter((row) => row.danglingEffects.length > 0)
  let amendmentSagaId: string | undefined
  if (dangling.length > 0) {
    amendmentSagaId = createAmendmentSaga(ctx, settings, dangling[0] as (typeof dangling)[number])
    diffCount += dangling.length
  }

  const anchorSagaId = dangling[0]?.sagaId ?? sagaIds[0] ?? 'recon'
  const result: ReconResult = {
    batchId,
    diffCount,
    ...(amendmentSagaId === undefined ? {} : { amendmentSagaId }),
  }

  commitSegment(ctx, () => {
    ctx.get(SAGA_AUDIT).append(anchorSagaId, 'saga/reconciled', {
      batchId,
      diffCount,
      ...(amendmentSagaId === undefined ? {} : { amendmentSagaId }),
    })
  })

  ctx.events.emit('saga/reconciled', {
    batchId,
    sagaId: anchorSagaId,
    diffCount,
    ...(amendmentSagaId === undefined ? {} : { amendmentSagaId }),
  })

  recordJobHeartbeat(ctx, 'recon', at)
  cache.set(batchId, result)
  return result
}

/** 心跳分级：距上次成功对账 > 1 天 → P1；> 2 天 → P0。首轮不告警。 */
function checkReconHeartbeat(ctx: Context, at: number, alerts: AlertSink): void {
  const last = lastJobHeartbeat(ctx, 'recon')
  if (last === undefined) return
  const missed = at - last
  if (missed > 2 * DAY_MS) {
    alerts('P0', `recon-heartbeat-missed:${missed}`)
  } else if (missed > DAY_MS) {
    alerts('P1', `recon-heartbeat-missed:${missed}`)
  }
}

/** 每周演练：注入一次假差异，跑通 diff≠0 → P0 → `saga/reconciled` 链路。 */
function runDrill(
  ctx: Context,
  at: number,
  sagaId: string,
  alerts: AlertSink,
): void {
  const batchId = `recon:${reconPeriodOf(at)}:drill`
  commitSegment(ctx, () => {
    ctx.get(SAGA_AUDIT).append(sagaId, 'saga/reconciled', { batchId, diffCount: 1 })
  })
  ctx.events.emit('saga/reconciled', { batchId, sagaId, diffCount: 1 })
  alerts('P0', `recon-drill:${sagaId}`)
}

/**
 * 对账 job（批 5 可直调；批 6 由 `saga/tick` 的 `dueJobs` 触发）。
 *
 * 每窗 ≤ `reconBatchSize`；所有窗口在一次 job 调用内完成（不跨 tick 边界）。
 */
export async function runReconJob(
  ctx: Context,
  settings: SagaSettings,
  statement: ExternalStatement,
  deps: ReconDeps,
  alerts: AlertSink = noopAlertSink,
  options: ReconJobOptions = {},
): Promise<ReconJobResult> {
  const store = ctx.get(SAGA_STORE)
  const at = ctx.get(SAGA_CLOCK).now()
  checkReconHeartbeat(ctx, at, alerts)

  const sagaIds = store.activeSagas()
  const batches: ReconResult[] = []
  for (let index = 0; index < sagaIds.length; index += settings.reconBatchSize) {
    const window = sagaIds.slice(index, index + settings.reconBatchSize)
    batches.push(
      await reconcileBatch(
        ctx,
        settings,
        { fromIndex: index / settings.reconBatchSize, sagaIds: window },
        statement,
        deps,
        alerts,
      ),
    )
  }

  const drill = options.drill ?? isDrillWindow(at, settings)
  if (drill) {
    runDrill(ctx, at, options.drillSagaId ?? sagaIds[0] ?? 'recon', alerts)
  }

  // 无 active saga 时没有批次可刷新心跳，这里补一次。
  if (sagaIds.length === 0) recordJobHeartbeat(ctx, 'recon', at)

  return { batches, drill }
}

export type {
  ChainRow,
  ExternalStatement,
  ExternalStatementRow,
  ReconBatch,
  ReconDeps,
  ReconJobOptions,
  ReconJobResult,
  ReconResult,
} from './types.ts'
export { createAmendmentSaga } from './amendment.ts'
