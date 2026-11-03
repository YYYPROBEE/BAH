/**
 * 订阅检测分层指标（场景 5 §10）。
 *
 * 输入：`benchmarks/subscription-detection/{clean-24,dirty-40,edge-18}.json`（**合成标注集**）。
 * 输出：按置信度分层的 precision / recall、三分法准确率、下次扣款日误差 ≤3 天的占比。
 *
 * 口径纪律：
 * - `high` 层才是「直接入册」的可信度；`medium` 报「待确认召回」；
 * - **不得只报 overall**——报告同时给三层；
 * - 这是合成数据集，不是真实银行流水；对外说明必须同句说明。
 *
 * 运行：`npx tsx scripts/report-subscription-detection.ts`
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectRecurring, DETECTOR_VERSION } from '../packages/bank/src/detect/index.ts'
import { bankIds } from '../packages/bank/src/core/model.ts'
import { DAY_MS } from '../packages/bank/src/core/time.ts'
import type { Transaction } from '../packages/bank/src/core/model.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = ['clean-24', 'dirty-40', 'edge-18'] as const

interface FixtureTxn {
  readonly id: string
  readonly at: number
  readonly amountCents: number
  readonly name: string
  readonly direction: 'out'
  readonly status: 'success'
  readonly category: Transaction['category']
}
interface FixtureSeries {
  readonly merchantKey: string
  readonly cycle: string
  readonly kind: string
  readonly txnIds: readonly string[]
  readonly nextChargeAt: number
}
interface Fixture {
  readonly name: string
  readonly now: number
  readonly windowDays: number
  readonly transactions: readonly FixtureTxn[]
  readonly series: readonly FixtureSeries[]
}

interface LayerStats {
  tp: number
  fp: number
  fn: number
}

function emptyStats(): LayerStats {
  return { tp: 0, fp: 0, fn: 0 }
}

function add(target: LayerStats, source: LayerStats): void {
  target.tp += source.tp
  target.fp += source.fp
  target.fn += source.fn
}

function pct(part: number, total: number): string {
  return total === 0 ? '—' : `${((part / total) * 100).toFixed(1)}%`
}

function precision(stats: LayerStats): string {
  return pct(stats.tp, stats.tp + stats.fp)
}

function recall(stats: LayerStats): string {
  return pct(stats.tp, stats.tp + stats.fn)
}

function toTransaction(txn: FixtureTxn): Transaction {
  return {
    id: bankIds.txn(txn.id),
    accountId: bankIds.account('a-bench'),
    at: txn.at,
    amountCents: txn.amountCents,
    direction: txn.direction,
    counterparty: { name: txn.name },
    category: txn.category,
    channel: 'app',
    status: txn.status,
  }
}

function statsFor(
  fixture: Fixture,
  layer: 'high' | 'medium' | 'low' | 'all',
): { stats: LayerStats; kindHits: number; kindTotal: number; nextHits: number; nextTotal: number } {
  const output = detectRecurring(fixture.transactions.map(toTransaction), {
    now: fixture.now,
    windowDays: fixture.windowDays,
  })
  const labels = new Map(fixture.series.map((item) => [item.merchantKey, item]))
  const stats = emptyStats()
  let kindHits = 0
  let kindTotal = 0
  let nextHits = 0
  let nextTotal = 0
  const matched = new Set<string>()
  for (const detected of output.series) {
    if (layer !== 'all' && detected.confidence !== layer) continue
    const label = labels.get(detected.merchantKey)
    if (label === undefined || matched.has(label.merchantKey)) {
      stats.fp += 1
      continue
    }
    matched.add(label.merchantKey)
    stats.tp += 1
    kindTotal += 1
    if (label.kind === detected.kind) kindHits += 1
    nextTotal += 1
    if (Math.abs(detected.nextChargeAt - label.nextChargeAt) <= 3 * DAY_MS) nextHits += 1
  }
  for (const key of labels.keys()) {
    if (!matched.has(key)) stats.fn += 1
  }
  return { stats, kindHits, kindTotal, nextHits, nextTotal }
}

function reportRow(name: string, layer: string, stats: LayerStats): string {
  return `| ${name} | ${layer} | ${String(stats.tp)} | ${String(stats.fp)} | ${String(stats.fn)} | ${precision(stats)} | ${recall(stats)} |`
}

console.log(`# 订阅检测分层指标（${DETECTOR_VERSION}）\n`)
console.log('| 数据集 | 层 | TP | FP | FN | precision | recall |')
console.log('|---|---|---:|---:|---:|---:|---:|')

const totals = { high: emptyStats(), medium: emptyStats(), low: emptyStats(), all: emptyStats() }
let kindHits = 0
let kindTotal = 0
let nextHits = 0
let nextTotal = 0

for (const name of FIXTURES) {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'benchmarks', 'subscription-detection', `${name}.json`), 'utf8')) as Fixture
  for (const layer of ['high', 'medium', 'low', 'all'] as const) {
    const result = statsFor(fixture, layer)
    add(totals[layer], result.stats)
    if (layer === 'all') {
      kindHits += result.kindHits
      kindTotal += result.kindTotal
      nextHits += result.nextHits
      nextTotal += result.nextTotal
    }
    console.log(reportRow(name, layer, result.stats))
  }
}

console.log('')
for (const layer of ['high', 'medium', 'low', 'all'] as const) {
  console.log(reportRow('**合计**', layer, totals[layer]))
}
console.log('')
console.log(`- 三分法（kind）准确率：${pct(kindHits, kindTotal)}（${String(kindHits)}/${String(kindTotal)}）`)
console.log(`- 下次扣款日误差 ≤3 天：${pct(nextHits, nextTotal)}（${String(nextHits)}/${String(nextTotal)}）`)
console.log('- 标注集：**合成数据**（clean-24 / dirty-40 / edge-18），不是真实银行流水。')
