/**
 * 告警扇出计数（可观测性 02 / S2.7）。
 *
 * 三个出口（stderr / 文件 / webhook）各自成功与失败，全部只计数、不影响主链路。
 * `/api/metrics.alerts` 与 `bah_alerts_total` 都从这里读——不另建第二套计数。
 */

/** 告警级别（与 saga 的 `AlertEvent.level` 同形）。 */
export type AlertLevel = 'alert' | 'P0'

/** 出口结果：`failed` = 该出口最终投递失败。 */
export type AlertResult = 'stderr' | 'file' | 'webhook' | 'failed'

const counts = new Map<string, number>()

function keyOf(level: AlertLevel, result: AlertResult): string {
  return `${level}|${result}`
}

/** 记一次投递结果（成功与失败都走这里）。 */
export function recordAlertResult(level: AlertLevel, result: AlertResult, amount = 1): void {
  if (amount <= 0) return
  const key = keyOf(level, result)
  counts.set(key, (counts.get(key) ?? 0) + amount)
}

/** 供 `collectMetrics` 的样本列表（只返回出现过的组合，避免空 series）。 */
export function alertSamples(): { level: AlertLevel; result: AlertResult; count: number }[] {
  return [...counts.entries()].map(([key, count]) => {
    const [level, result] = key.split('|') as [AlertLevel, AlertResult]
    return { level, result, count }
  })
}

/** 供 `/api/metrics.alerts` 的按 level / result 汇总。 */
export function alertSummary(): {
  readonly byLevel: Readonly<Record<AlertLevel, number>>
  readonly byResult: Readonly<Record<AlertResult, number>>
} {
  const byLevel: Record<AlertLevel, number> = { alert: 0, P0: 0 }
  const byResult: Record<AlertResult, number> = { stderr: 0, file: 0, webhook: 0, failed: 0 }
  for (const sample of alertSamples()) {
    byLevel[sample.level] += sample.count
    byResult[sample.result] += sample.count
  }
  return { byLevel, byResult }
}

/** 清空计数（测试用；生产不调用）。 */
export function resetAlertStats(): void {
  counts.clear()
}
