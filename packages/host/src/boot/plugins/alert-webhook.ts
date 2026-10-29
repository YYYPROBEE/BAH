/**
 * 告警 webhook 出口（可观测性 02 / S2.7）。
 *
 * 六条纪律（逐条都有测试）：
 * 1. **绝不 await 主链路**：`void deliver(event)`；
 * 2. **超时 3s**：`AbortSignal.timeout(3000)`；
 * 3. **最多 3 次**：500ms / 1s / 2s 退避，定时器 `unref`；
 * 4. **去重**：同 `(metric, detail)` 60 秒内只发一次；
 * 5. **队列上限 100**：超了丢最旧的并记 `failed`；
 * 6. **没配就不注册**：`installAlertWebhook` 只在 URL 非空时被调用。
 *
 * 失败只计数（`bah_alerts_total{result="failed"}`），永不抛给告警汇或业务。
 */

import { registerAlertSink, type AlertEvent } from '@bah/saga'

import type { Disposer } from '@bah/core'

import { recordAlertResult } from './alert-stats.ts'

/** URL 必须是 http(s)（`file:` / `javascript:` 直接拒绝）。 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** webhook 选项（测试注入 fetch / 时钟 / 队列）。 */
export interface AlertWebhookOptions {
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly dedupMs?: number
  readonly maxQueue?: number
  readonly timeoutMs?: number
  readonly retryDelaysMs?: readonly number[]
}

interface QueueItem {
  readonly event: AlertEvent
}

/** 可测试的 webhook sink；`dispose` 后不再投递。 */
export function installAlertWebhook(url: string, options: AlertWebhookOptions = {}): Disposer {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const dedupMs = options.dedupMs ?? 60_000
  const maxQueue = options.maxQueue ?? 100
  const timeoutMs = options.timeoutMs ?? 3_000
  const retryDelaysMs = options.retryDelaysMs ?? [500, 1_000, 2_000]

  const queue: QueueItem[] = []
  const lastSent = new Map<string, number>()
  let draining = false
  let disposed = false

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })

  const payloadOf = (event: AlertEvent): Record<string, unknown> => ({
    ts: new Date(now()).toISOString(),
    level: event.level,
    ...(event.metric === undefined ? {} : { metric: event.metric }),
    detail: event.detail,
    source: 'bah-saga',
  })

  const post = async (event: AlertEvent): Promise<boolean> => {
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
      if (disposed) return false
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payloadOf(event)),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (response.ok) {
          recordAlertResult(event.level, 'webhook')
          return true
        }
      } catch {
        // 网络失败 / 超时 / 非 2xx：继续下一次退避。
      }
      const delay = retryDelaysMs[attempt] ?? 0
      if (delay > 0) await sleep(delay)
    }
    recordAlertResult(event.level, 'failed')
    return false
  }

  const drain = async (): Promise<void> => {
    if (draining || disposed) return
    draining = true
    try {
      while (queue.length > 0 && !disposed) {
        const item = queue.shift()
        if (item === undefined) break
        await post(item.event)
      }
    } finally {
      draining = false
    }
  }

  const dispose = registerAlertSink((event) => {
    if (disposed) return
    const key = `${event.metric ?? '-'}\u0001${event.detail}`
    const at = now()
    const previous = lastSent.get(key)
    if (previous !== undefined && at - previous < dedupMs) return
    lastSent.set(key, at)
    if (queue.length >= maxQueue) {
      const dropped = queue.shift()
      if (dropped !== undefined) recordAlertResult(dropped.event.level, 'failed')
    }
    queue.push({ event })
    void drain()
  })

  return () => {
    disposed = true
    queue.length = 0
    dispose()
  }
}
