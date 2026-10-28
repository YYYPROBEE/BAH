/**
 * 进程快照（可观测性 02 / S2.3）。
 *
 * `collectMetrics` 是纯函数，进程数字由**调用方**给（`readProcessSnapshot`）；
 * 这样 8 个用例就能覆盖指标派生，不需要起进程、也不需要 fake 全局。
 *
 * 事件循环延迟用 Node 内建的 `monitorEventLoopDelay`：每次抓取读一次并 `reset()`，
 * 所以它是"上次抓取以来的 p99"，不是进程启动至今的累计值——Prometheus 拉模式要的正是前者。
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

/** 一次进程快照（单位见字段名；时间统一 epoch ms / 秒）。 */
export interface ProcessSnapshot {
  readonly startedAtMs: number
  readonly uptimeSec: number
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly eventLoopP99Sec: number
  readonly nodeVersion: string
}

let histogram: IntervalHistogram | undefined

/** 读事件循环 p99（秒）；监控器懒创建，读后重置窗口。 */
function readEventLoopP99Sec(): number {
  if (histogram === undefined) {
    histogram = monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()
    return 0
  }
  const value = histogram.percentile(99) / 1e9
  histogram.reset()
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * 读一次进程快照。
 *
 * 只能在宿主调用（会读 `process` 全局）；测试直接造 `ProcessSnapshot` 对象传给
 * `collectMetrics`，不需要调用本函数。
 */
export function readProcessSnapshot(now: number): ProcessSnapshot {
  const memory = process.memoryUsage()
  const uptimeSec = process.uptime()
  return {
    startedAtMs: now - Math.round(uptimeSec * 1000),
    uptimeSec,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    eventLoopP99Sec: readEventLoopP99Sec(),
    nodeVersion: process.version,
  }
}
