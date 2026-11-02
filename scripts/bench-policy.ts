/**
 * `pnpm bench:policy [bundle-dir]`：02 §11 的性能预算测量（本机口径，只做趋势）。
 *
 * 三个数：编译（含 lock 校验）、单次求值 p50/p99、重载（再编译一次）。
 * 预算：编译 < 5 ms、求值 p99 < 20 µs、重载 < 20 ms；超了打印 `✘` 并以 1 退出。
 */

import { performance } from 'node:perf_hooks'

import { loadBundle } from '../packages/policy/src/load.ts'

import { toolNames } from './policy-cli.ts'

const dir = process.argv[2] ?? 'policies/bank-tier/1.0.0'
const COMPILE_BUDGET_MS = 5
const EVAL_P99_BUDGET_US = 20
const RELOAD_BUDGET_MS = 20
const EVAL_ITERATIONS = 100_000

const first = loadBundle({ dir, verifyLock: true, toolNames: toolNames() })
const sample = first.cases[0]?.input
if (sample === undefined) {
  console.error('bundle 没有语料，无法取求值样本')
  process.exit(1)
}

const compileTimes: number[] = []
for (let index = 0; index < 20; index += 1) {
  const start = performance.now()
  loadBundle({ dir, verifyLock: true, toolNames: toolNames(), withCorpus: false })
  compileTimes.push(performance.now() - start)
}

const compiled = first.compiled
const input = compiled.validateInput(sample)
for (let index = 0; index < 1_000; index += 1) compiled.evaluate(input)
const evalTimes: number[] = []
for (let index = 0; index < EVAL_ITERATIONS; index += 1) {
  const start = performance.now()
  compiled.evaluate(input)
  evalTimes.push((performance.now() - start) * 1_000)
}

const reloadStart = performance.now()
loadBundle({ dir, verifyLock: true, toolNames: toolNames(), withCorpus: false })
const reloadMs = performance.now() - reloadStart

const compileAvg = average(compileTimes)
const evalP50 = quantile(evalTimes, 0.5)
const evalP99 = quantile(evalTimes, 0.99)
const checks = [
  [compileAvg <= COMPILE_BUDGET_MS, `compile avg ${compileAvg.toFixed(3)} ms（预算 < ${String(COMPILE_BUDGET_MS)} ms）`],
  [evalP99 <= EVAL_P99_BUDGET_US, `eval p99 ${evalP99.toFixed(3)} µs（预算 < ${String(EVAL_P99_BUDGET_US)} µs）`],
  [reloadMs <= RELOAD_BUDGET_MS, `reload ${reloadMs.toFixed(3)} ms（预算 < ${String(RELOAD_BUDGET_MS)} ms）`],
] as const

for (const [ok, line] of checks) console.log(`${ok ? '✔' : '✘'} ${line}`)
console.log(
  `  eval p50 ${evalP50.toFixed(3)} µs / ${String(EVAL_ITERATIONS)} 次；bundle ${compiled.descriptor.policyVersion}`,
)
process.exitCode = checks.every(([ok]) => ok) ? 0 : 1

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function quantile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index] ?? 0
}
