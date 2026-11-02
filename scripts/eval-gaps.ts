/**
 * 补齐场景复跑（六场景旅程证据）：`pnpm eval:gaps`。
 *
 * **这不是 CI 的第 15 步**：21 条场景不进 `ALL_SCENARIOS`、不计入 91 官方口径，
 * 只在答辩前手动复跑。矩阵里对应列必须写 `gaps:<ID>`，不能写 `eval:<ID>`。
 *
 * 路线 B′ 的原因：并行并入 91 会动 `validate.ts` 的写死例数与 ADR-0018 的论据，
 * 违背"只加评测与文档"的红线；塞进 vitest 又会改 `eval:unit` 的文件/用例数。
 *
 * 静态自检：`validateScenarios` 把七族例数与总数写死，对 21 条子集必然报红，
 * 所以这里 `validate:false` 并自带最小检查（重号 / 撞官方 ID / 空断言 / 族前缀）。
 */

import assert from 'node:assert/strict'

import { runEval } from '../packages/eval/src/scenario/runner.ts'
import { ALL_SCENARIOS } from '../packages/eval/src/scenarios/index.ts'
import { GAP_SCENARIOS } from '../packages/eval/src/scenarios/gaps/index.ts'
import { projectRoot } from './gate-lib.ts'

const root = projectRoot()
const ids = GAP_SCENARIOS.map((scenario) => scenario.spec.id)
const officialIds = new Set(ALL_SCENARIOS.map((scenario) => scenario.spec.id))

// 最小静态校验（代替被关掉的 `validateScenarios`；任一条失败直接抛，非零退出）。
assert.equal(GAP_SCENARIOS.length, 21, `补齐场景应为 21 条，实际 ${String(GAP_SCENARIOS.length)}`)
assert.equal(ids.length, new Set(ids).size, '补齐场景 ID 重复')
assert.deepEqual(
  ids.filter((id) => officialIds.has(id)),
  [],
  '补齐场景与 ALL_SCENARIOS 重号',
)
for (const { spec } of GAP_SCENARIOS) {
  assert.ok(spec.expect.length > 0, `${spec.id}: expect 不能为空`)
  assert.ok(spec.id.startsWith(spec.family), `${spec.id}: ID 前缀与 family=${spec.family} 不一致`)
  // C3（validate.ts:70-72）：只有 P 族可以声明 approval；validate:false 下必须自己兜住。
  if (spec.family !== 'P') {
    assert.equal(spec.approval, undefined, `${spec.id}: 非 P 族不许声明 approval`)
  }
}

const result = await runEval({
  repoRoot: root,
  scenarios: GAP_SCENARIOS,
  // 校验器的七族例数是写死的 91 口径，不吃 21 条子集；静态检查在上面。
  validate: false,
  // 不把 handoffPath / ticketId 一类的一次性串落进 .ci-artifacts。
  writeArtifacts: false,
})

const failures = result.report.scenarios.filter((scenario) => scenario.status === 'fail')
for (const scenario of result.report.scenarios) {
  const head = scenario.status === 'pass' ? '✔' : '✘'
  const detail =
    scenario.status === 'pass'
      ? ''
      : ` · ${scenario.code ?? '?'}：${scenario.detail ?? ''}`
  console.log(`${head} ${scenario.id} ${scenario.title}${detail}`)
}

console.log(
  `\n补齐场景：${String(result.report.scenarios.length)} 条；` +
    `通过 ${String(result.report.scenarios.length - failures.length)}；` +
    `失败 ${String(failures.length)}；boot 次数 ${String(result.report.bootCount)}；` +
    `墙钟 ${String(Math.round(result.timing.totalMs / 100) / 10)}s`,
)

if (failures.length > 0) process.exitCode = 1
