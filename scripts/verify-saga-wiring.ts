/**
 * 门禁：Saga 是否真的接在**主循环的工具执行面**上（不是"装好了没人调"）。
 *
 * 跑法：`pnpm gate`（其中一项）或 `npx tsx scripts/verify-saga-wiring.ts`。
 *
 * 判据四条，缺一条就算没通电：
 * 1. 一次转账留下**一笔** `saga_transaction`，终态 `SUCCEEDED`；
 * 2. 两步（`transfer_preview` → `transfer_create`）都 `EXECUTED`，且 `attempts = 1`
 *    （写死 1 是安全约束：幂等键没传给核心，重试会多扣钱）；
 * 3. 第二步的 `topology_deps` 里确实有第一步（DAG 是事实，不是画出来的）；
 * 4. `saga/tick` 至少被派发过一次（janitor/recon/anchor 三个收敛 job 的执行前置）。
 *
 * 第 4 条靠 overlay 把 tick 间隔压到 200ms 才看得见；base bundle 里是 60s。
 *
 * ## 为什么全部副作用必须收在 `run()` 里
 *
 * `run-gates.ts` 是 `await import(...)` 之后才读 `{ gate }` —— **导入本身就会执行顶层代码**。
 * 本脚本原先是顶层直接 `boot()` + `agent.send('给王建国转 800 元房租')` + `agent.run()`，
 * 于是每跑一次 `pnpm gate` 都会在"导入阶段"真的走完一笔转账、写进跨运行持久的
 * `sessions/saga.sqlite`，把基线搞脏（而且账面上只报一句"未导出 gate"）。
 * 收进 `run()` 之后，只有调度器真的调用它才会跑。
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { SESSION_FILES, boot, createCatalog } from '@bah/host'
import { AGENTS_SERVICE } from '@bah/runtime'
import { SAGA_STORE } from '@bah/saga'

import { loadBundles } from '../packages/cli/src/bundles.ts'
import { readLayers, readProfile } from '../packages/cli/src/profile.ts'

import { isMainModule, runStandalone, type Gate, type GateResult } from './gate-lib.ts'

/** 证据落盘目录（每次重建）。 */
const JSONL_DIR = '.tmp-saga-wiring'

/** 会话 ID（固定，便于对照日志）。 */
const SESSION_ID = 's-saga-wiring'

/** 演示话术：与 `profiles/headless/patch.yml` 的剧本同一个业务意图。 */
const PROMPT = '给王建国转 800 元房租'

const gate: Gate = {
  name: 'saga-wiring',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const profile = readProfile(root, 'headless')
    const bundles = await loadBundles(root, profile.bundles)
    const { layers } = readLayers(root, profile, {
      home: join(root, '.tmp-no-home'),
      overlays: ['profiles/headless/patch-saga-wiring.yml'],
    })

    rmSync(join(root, JSONL_DIR), { recursive: true, force: true })

    const app = await boot({
      profile,
      bundles,
      layers,
      catalog: createCatalog(),
      run: { sessionId: SESSION_ID as never, now: () => Date.now(), jsonlDir: JSONL_DIR },
    })

    try {
      let ticks = 0
      app.ctx.events.on('saga/tick', () => {
        ticks += 1
      })

      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
      if (agent === undefined) {
        return { ok: false, findings: ['没有活体 agent：profile 里缺少 core:agent 行'], notes }
      }

      // 先记基线：`sessions/saga.sqlite` 是**跨运行持久**的（启动恢复本来就依赖这一点），
      // 直接断言"总共 1 笔"会被上一次运行的残留蒙过去——这个脚本第一次写就踩过这个坑。
      const before = app.ctx.get(SAGA_STORE).listAllSagas().length

      agent.send(PROMPT)
      await agent.run()

      // 留出两个 tick 周期（overlay 里 200ms）后才断言
      await new Promise((resolve) => setTimeout(resolve, 700))

      const store = app.ctx.get(SAGA_STORE)
      const sagas = store.listAllSagas()
      notes.push(`事务 ${sagas.length} 笔（本次之前 ${before} 笔），tick ${ticks} 次`)

      if (sagas.length !== before + 1) {
        findings.push(`期望本次新增 1 笔事务，实际新增 ${sagas.length - before} 笔`)
      } else {
        // 取最新一笔（createdAt 最大），不依赖 listAllSagas 的返回顺序
        const saga = [...sagas].sort((left, right) => right.createdAt - left.createdAt)[0]!
        const steps = store.listSteps(saga.sagaId)
        notes.push(`${saga.sagaId} · ${saga.businessType} · ${saga.state}`)
        for (const step of steps) {
          notes.push(
            `  ${step.stepId} → ${step.toolName} · ${step.state} · attempts=${step.attempts} · deps=[${step.topologyDeps.join(',')}]`,
          )
        }
        if (saga.state !== 'SUCCEEDED') findings.push(`事务终态是 ${saga.state}，期望 SUCCEEDED`)
        if (steps.length !== 2) findings.push(`期望 2 步，实际 ${steps.length} 步`)
        if (steps.some((step) => step.attempts !== 1)) {
          findings.push('有步骤 attempts ≠ 1（写路径重试会多扣钱）')
        }
        if (!steps[1]?.topologyDeps.includes(steps[0]?.stepId ?? '')) {
          findings.push('第二步没有声明对第一步的拓扑依赖（DAG 不成立）')
        }
      }

      if (ticks < 1) findings.push('没有观察到 saga/tick 派发（收敛 job 永远不会执行）')

      notes.push(`审计链根：${join(JSONL_DIR, '<sagaId>', 'audit.jsonl')}`)
      notes.push(`会话日志：${app.ctx.get(SESSION_FILES).fileOf(SESSION_ID as never)}`)

      return { ok: findings.length === 0, findings, notes }
    } finally {
      await app.dispose('verify-saga-wiring-done')
    }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
