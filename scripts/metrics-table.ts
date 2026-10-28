/**
 * 生成 `docs/observability.md` 的指标登记表（可观测性 02 / S2.9）。
 *
 * 表从 `METRIC_SPECS` 机械生成，手写必然分叉；`verify-observability` 会双向比对
 * "代码里的 name 集合 === 文档表里的 name 集合"。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { METRIC_SPECS } from '../packages/telemetry/src/metrics.ts'

const DOC = join('docs', 'observability.md')
const BEGIN = '<!-- metrics:begin -->'
const END = '<!-- metrics:end -->'

const rows = METRIC_SPECS.map(
  (spec) =>
    `| \`${spec.name}\` | ${spec.type} | ${spec.labels.length === 0 ? '—' : spec.labels.map((label) => `\`${label}\``).join(', ')} | ${spec.unit ?? '—'} | ${spec.source} |`,
)
const table = ['| 指标 | 类型 | 标签 | 单位 | 口径 |', '|---|---|---|---|---|', ...rows].join('\n')

const source = readFileSync(DOC, 'utf8')
const start = source.indexOf(BEGIN)
const stop = source.indexOf(END)
if (start < 0 || stop <= start) {
  throw new Error(`${DOC} 缺少 ${BEGIN} / ${END} 标记`)
}
const next = `${source.slice(0, start + BEGIN.length)}\n${table}\n${source.slice(stop)}`
writeFileSync(DOC, next, 'utf8')
console.log(`已生成 ${String(METRIC_SPECS.length)} 行指标表 → ${DOC}`)
