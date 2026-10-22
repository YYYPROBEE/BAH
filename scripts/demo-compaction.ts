/**
 * 证据脚本：上下文压缩是否真的在跑（不是"配了但没通电"）。
 *
 * 为什么必须是脚本而不是三次 `pnpm bah`：jsonl 后端对已存在的会话**拒绝覆写**
 * （`packages/persistence/src/jsonl/backend.ts:109`），多轮只能落在同一个进程里。
 * 而压缩是在**turn 边界**判定的（`runtime/src/agent-loop/agent.ts:369,434`），
 * 只有单进程多轮才能让它触发。
 *
 * 跑法：`npx tsx scripts/demo-compaction.ts`
 *
 * 判定：第三轮开始时完整 turn 数（3）> `maxTurns`（2），于是折叠更早的历史、
 * 追加一条 `compaction/summary`。期望该事件条数 ≥ 1。
 *
 * 纪律：落盘目录固定 `.tmp-compact-driver` 且每次先清；证据要可重放，
 * 不允许依赖上一次运行的残留。
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { SESSION_FILES, boot, createCatalog } from '@bah/host'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'

import { loadBundles } from '../packages/cli/src/bundles.ts'
import { readLayers, readProfile } from '../packages/cli/src/profile.ts'

/** 证据落盘目录（每次重建）。 */
const JSONL_DIR = '.tmp-compact-driver'

/** 会话 ID（固定，便于对照日志）。 */
const SESSION_ID = 's-compact-driver'

/** 三轮提问：条数必须 ≥ 期望触发的 turn 数。 */
const PROMPTS = ['第一轮：活期余额多少', '第二轮：最近三笔消费', '第三轮：这个月账单汇总'] as const

const root = process.cwd()
const profile = readProfile(root, 'headless')
const bundles = await loadBundles(root, profile.bundles)
const { layers } = readLayers(root, profile, {
  home: join(root, '.tmp-no-home'),
  overlays: ['profiles/headless/patch-compaction.yml'],
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
  const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
  if (agent === undefined) throw new Error('没有活体 agent：profile 里缺少 core:agent 行')

  for (const prompt of PROMPTS) {
    agent.send(prompt)
    await agent.run()
  }

  const session = app.ctx.get(SESSION_SERVICE)
  const events = session.events()
  const summaries = events.filter((event) => event.type === 'compaction/summary')

  console.log(`会话 ${SESSION_ID}：${events.length} 条事件，其中 compaction/summary ${summaries.length} 条`)
  for (const event of summaries) {
    const data = event.data as { fromTurn?: number; toTurn?: number; turns?: number; summary?: string }
    console.log(`  折叠 turn ${String(data.fromTurn)}–${String(data.toTurn)}（${String(data.turns)} 个）`)
    console.log(`  摘要：${String(data.summary).slice(0, 200)}`)
  }
  console.log(`日志：${app.ctx.get(SESSION_FILES).fileOf(SESSION_ID as never)}`)

  if (summaries.length === 0) {
    console.error('FAIL：三轮跑完仍无 compaction/summary —— 压缩没通电')
    process.exitCode = 1
  } else {
    console.log('PASS：压缩确实在 turn 边界触发了')
  }
} finally {
  await app.dispose('demo-compaction-done')
}
