/**
 * tick job 注册表（SA-13 §3.5 约定的模块路径；**普通模块，非 ServiceKey**）。
 *
 * 批 5 只登记 janitor / recon 的 job 纯函数；`saga/tick` 的唯一派发点在批 6
 * 的 `tick/index.ts` 落地。heartbeat 也放这里：它属于 job 自身的运行状态，
 * 不新增服务键，也不落库（跨重启的心跳口径由批 6 的监控位接管）。
 */

import type { Context, Disposer } from '@bah/core'

/** 允许登记的 job 名（与 `saga/tick` 载荷的 `dueJobs` 同一封闭联合）。 */
export type TickJobName = 'janitor' | 'recon' | 'anchor'

const jobs = new Map<TickJobName, () => void>()

/** 每个 Context 各自的心跳表：测试用新 ctx 天然隔离，不串状态。 */
const heartbeats = new WeakMap<Context, Map<TickJobName, number>>()

/**
 * 登记一个 job，返回**注销该 job 的 disposer**。
 *
 * 直接交给 `ctx.effect(disposer)`；不要包成 `ctx.effect(() => ...)`——
 * `ctx.effect` 的参数只在 dispose 时执行。
 */
export function registerTickJob(name: TickJobName, run: () => void): Disposer {
  jobs.set(name, run)
  return () => {
    if (jobs.get(name) === run) jobs.delete(name)
  }
}

/** 直接注销（装配失败回滚等场景）。 */
export function unregisterTickJob(name: TickJobName): void {
  jobs.delete(name)
}

/** 执行一个已登记的 job；未登记即静默跳过（由调用方的 dueJobs 决定是否应有）。 */
export function runTickJob(name: TickJobName): void {
  jobs.get(name)?.()
}

/** 记录某 job 最近一次成功运行时刻（M8 心跳）。 */
export function recordJobHeartbeat(ctx: Context, name: TickJobName, at: number): void {
  let table = heartbeats.get(ctx)
  if (table === undefined) {
    table = new Map<TickJobName, number>()
    heartbeats.set(ctx, table)
  }
  table.set(name, at)
}

/** 读取某 job 最近一次心跳；从未运行过返回 `undefined`（不等于 0）。 */
export function lastJobHeartbeat(ctx: Context, name: TickJobName): number | undefined {
  return heartbeats.get(ctx)?.get(name)
}

/** 仅供测试：清空模块级 job 表（不触碰任何 Context 心跳）。 */
export function clearTickJobsForTest(): void {
  jobs.clear()
}
