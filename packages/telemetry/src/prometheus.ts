/**
 * Prometheus 文本渲染（可观测性 02 / S2.4）。
 *
 * 格式逐字照 02 §4.3：
 * 1. 每个 family：`# HELP` → `# TYPE` → 样本行；
 * 2. family 间空一行，文件以 `\n` 结尾；
 * 3. 标签按字母序；值转义 `\` / `"` / `\n`；
 * 4. 数值整数直接写，浮点用 `toString()`（**不用** `toFixed`）；`NaN` 写 `NaN`；
 * 5. histogram 出 `_bucket` / `_sum` / `_count`，`+Inf` 桶 count 恒等于 `_count`；
 * 6. 不许出现重复 series（同 name + 同 labels）。
 *
 * 本模块是纯函数：不读时钟、不读磁盘、不依赖进程。
 */

import type { MetricFamily } from './metrics.ts'

/** 标签值转义（Prometheus 文本格式只要求这三类）。 */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** 标签串：字母序；histogram 的 `le` 由调用方追加在最后。 */
function labelsText(labels: Readonly<Record<string, string>>, extra?: readonly [string, string]): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${escapeLabel(labels[key] ?? '')}"`)
  if (extra !== undefined) pairs.push(`${extra[0]}="${extra[1]}"`)
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`
}

/** 数值格式：整数直写、浮点 toString、NaN 特殊处理。 */
function numberText(value: number): string {
  return Number.isNaN(value) ? 'NaN' : String(value)
}

/** 一个 family 的 series 唯一键（用来硬拦重复）。 */
function seriesKey(name: string, labels: Readonly<Record<string, string>>): string {
  return `${name}\u0001${Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key] ?? ''}`)
    .join('\u0001')}`
}

/** `MetricFamily[]` → Prometheus 文本。 */
export function renderPrometheus(families: readonly MetricFamily[]): string {
  const lines: string[] = []
  const seen = new Set<string>()

  for (const family of families) {
    if (family.samples.length === 0) continue
    const { spec } = family
    // 直方图没有样本时不输出空 family（`_count=0` 不是"有数据"）。
    if (
      spec.type === 'histogram' &&
      !family.samples.some((sample) => (sample.histogram?.count ?? 0) > 0)
    ) {
      continue
    }
    lines.push(`# HELP ${spec.name} ${spec.help}`)
    lines.push(`# TYPE ${spec.name} ${spec.type}`)

    for (const sample of family.samples) {
      if (spec.type !== 'histogram') {
        const key = seriesKey(spec.name, sample.labels)
        if (seen.has(key)) throw new Error(`bah-telemetry: duplicate series ${spec.name}`)
        seen.add(key)
        lines.push(`${spec.name}${labelsText(sample.labels)} ${numberText(sample.value ?? 0)}`)
        continue
      }

      const histogram = sample.histogram
      if (histogram === undefined || histogram.count === 0) continue
      for (const bucket of histogram.buckets) {
        const le = bucket.le === Number.POSITIVE_INFINITY ? '+Inf' : String(bucket.le)
        const key = seriesKey(`${spec.name}_bucket`, { ...sample.labels, le })
        if (seen.has(key)) throw new Error(`bah-telemetry: duplicate series ${spec.name}_bucket`)
        seen.add(key)
        lines.push(
          `${spec.name}_bucket${labelsText(sample.labels, ['le', le])} ${numberText(bucket.count)}`,
        )
      }
      const sumKey = seriesKey(`${spec.name}_sum`, sample.labels)
      const countKey = seriesKey(`${spec.name}_count`, sample.labels)
      if (seen.has(sumKey) || seen.has(countKey)) {
        throw new Error(`bah-telemetry: duplicate series ${spec.name}_sum/_count`)
      }
      seen.add(sumKey)
      seen.add(countKey)
      lines.push(`${spec.name}_sum${labelsText(sample.labels)} ${numberText(histogram.sum)}`)
      lines.push(`${spec.name}_count${labelsText(sample.labels)} ${numberText(histogram.count)}`)
    }
  }

  return lines.length === 0 ? '\n' : `${lines.join('\n')}\n`
}
