/**
 * 宿主唤醒 tick（`saga/tick` 的**唯一派发点**，SA-13 §3.5）。
 *
 * - `saga/tick` 是冻结事件表里**唯一** `serial` 键；监听器无 `next`，忽略返回；
 * - 重复 tick 幂等：同一 `(now, job)` 只执行一次（幂等指针按 Context 隔离）；
 * - job 失败不阻断后续，统一进告警汇（P0 只进 sink，不冒充 DLQ 升级）；
 * - 跨进程重启的幂等由 job 内部确定性键兜底（batchId / period / 终态 CAS）。
 */

import { page } from '../alert/index.ts'
import { runTickJob, type TickJobName } from './registry.ts'

import type { Context } from '@bah/core'

/** tick 载荷（与 `BahEventMap['saga/tick']` 逐字一致）。 */
export interface TickPayload {
  readonly now: number
  readonly dueJobs: readonly TickJobName[]
}

/** 幂等指针：每个 Context 一张表（新 ctx 天然隔离，测试不串状态）。 */
const lastRun = new WeakMap<Context, Set<string>>()

function runSetOf(ctx: Context): Set<string> {
  let set = lastRun.get(ctx)
  if (set === undefined) {
    set = new Set<string>()
    lastRun.set(ctx, set)
  }
  return set
}

/** 已执行过的 `(job, now)` 指针（测试/诊断用）。 */
export function hasRunTick(ctx: Context, job: TickJobName, now: number): boolean {
  return runSetOf(ctx).has(`${job}:${now}`)
}

/**
 * 派发 `dueJobs`：顺序执行、失败不阻断后续。
 *
 * 先登记幂等指针再执行：job 抛错后重复 tick 也不会重试同一窗口
 * （重试语义由 job 自身的确定性键与下一窗口承担）。
 */
export function dispatchTick(ctx: Context, payload: TickPayload): void {
  const ran = runSetOf(ctx)
  for (const job of payload.dueJobs) {
    const key = `${job}:${payload.now}`
    if (ran.has(key)) continue
    ran.add(key)
    try {
      runTickJob(job)
    } catch (error) {
      page(
        ctx,
        'P0',
        `tick job ${job} 失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * 装配 tick 钩子：把 `saga/tick` 监听器挂到事件系统（唯一 `serial`）。
 *
 * `ctx.events.on` 自带 disposer；幂等指针随插件 dispose 清空。
 */
export function installTick(ctx: Context): void {
  ctx.effect(ctx.events.on('saga/tick', (payload) => dispatchTick(ctx, payload)))
  ctx.effect(() => {
    lastRun.delete(ctx)
  })
}
