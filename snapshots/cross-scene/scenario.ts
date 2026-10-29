/**
 * 快照场景：`cross-scene`（04 单 §8.1）——生日案例的两幕离线全流程。
 *
 * 第一幕："我下个月 8 号我爱人生日" → `intent_resolve`（implicit）→ `goal_set`（意图账本）
 * → `plan_propose`（6 节点 DAG，只校验不执行）。
 * 第二幕："确认执行生日计划" → `plan_execute`（黄级一次）→ 每个写节点**各走一次**审批
 * → 三笔转账各自核销票据（锁定 300 / 鲜花 200 / 蛋糕 100）。
 *
 * 三条确定性纪律（同 `headless-basic`）：
 * 1. 时钟来自 `fixedClock`；2. home patch 指向不存在的临时目录；3. 会话目录是临时目录。
 *
 * 数据口径：本快照用 `plan` profile（headless 自动应答者，autoDecision=allow），
 * 金额取 300/200/100（合计 600 元 < 默认日限 1000 元，保持全链黄级）；
 * 移动端演示配置是 1500 元 + 日限 2000（见 `profiles/mobile/patch.yml`）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadBundles, readLayers, readProfile } from '@bah/cli'
import { boot, createCatalog } from '@bah/host'
import { LLM_ADAPTERS } from '@bah/llm'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import { ReplayAdapter, asSessionId, createRecordingAdapter, fixedClock } from '@bah/test-support'

import type { SessionEvent, TicketId } from '@bah/core'
import type { Agent } from '@bah/runtime'
import type { Exchange, LoadedSnapshot, SnapshotMeta, SnapshotRow } from '@bah/test-support'

/** 仓库根（本文件在 `snapshots/<case>/`，向上两层）。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export const CASE = {
  name: 'cross-scene',
  profile: 'plan',
  prompts: ['我下个月 8 号我爱人生日', '确认执行生日计划'],
  sessionId: 's-snapshot-cross-scene',
  clock: { start: 1_700_000_000_000, step: 1 },
  randomSeed: 7,
  /**
   * 本场景真实驱动的治理平面（`verify-snapshot-fresh` 的归属依据）。
   *
   * 04 单新增：`goal/`（意图账本与重放）、`todo/`（plan 事件派生）、
   * `bank/src/forge/`（商户种子与内部划转数据面）。
   * plan 引擎、工具管线、意图平面、审批与签名链都真的跑到（不是凑覆盖）。
   */
  coveredSources: [
    'packages/runtime/src/goal/',
    'packages/runtime/src/todo/',
    'packages/runtime/src/plan/',
    'packages/runtime/src/agent-loop/',
    'packages/runtime/src/agent/',
    'packages/runtime/src/session/',
    'packages/runtime/src/system-prompt/',
    'packages/runtime/src/tools/',
    'packages/runtime/src/policy/',
    'packages/runtime/src/intent/',
    'packages/runtime/src/seams.ts',
    'packages/runtime/src/index.ts',
    'packages/interaction/src/prompt/',
    'packages/interaction/src/approval/',
    'packages/llm/src/llm/',
    'packages/llm/src/mock/',
    'packages/llm/src/demo/',
    'packages/bank/src/core/',
    'packages/bank/src/forge/',
    'packages/bank/src/tools/',
    'packages/host/src/boot/',
    'packages/persistence/src/jsonl/',
    'packages/persistence/src/chain/',
    'packages/persistence/src/saga-store/',
    'packages/safety/src/sentry/',
    'packages/safety/src/verify/',
    'packages/saga/src/index.ts',
    'packages/saga/src/tick/',
    'packages/saga/src/recovery/',
  ],
} as const

function noHome(): string {
  return join(tmpdir(), 'bah-snapshot-no-home')
}

const snapshotTicketId = (callId: string): TicketId => `ticket:${callId}` as TicketId

async function runPrompts(agent: Agent, prompts: readonly string[]): Promise<void> {
  for (const prompt of prompts) {
    agent.send(prompt)
    await agent.run()
  }
}

function settingsOf<T>(rows: SnapshotRow[], id: string): T {
  const row = rows.find((candidate) => candidate.id === id)
  if (row === undefined) throw new Error(`快照场景：生效行里没有 ${id}`)
  return row.config as T
}

export async function runRecord(): Promise<{
  readonly meta: SnapshotMeta
  readonly events: readonly SessionEvent[]
  readonly exchanges: readonly Exchange[]
}> {
  const profile = readProfile(REPO_ROOT, CASE.profile)
  const bundles = await loadBundles(REPO_ROOT, profile.bundles)
  const { layers } = readLayers(REPO_ROOT, profile, { home: noHome(), overlays: [] })

  const clock = fixedClock(CASE.clock)
  const scratch = mkdtempSync(join(tmpdir(), 'bah-cross-scene-record-'))
  const app = await boot({
    profile,
    bundles,
    layers,
    catalog: createCatalog(),
    run: {
      sessionId: asSessionId(CASE.sessionId),
      now: clock.now,
      mintTicketId: snapshotTicketId,
      jsonlDir: scratch,
    },
  })

  try {
    const registry = app.ctx.get(LLM_ADAPTERS)
    const rows: SnapshotRow[] = app.rows().map(({ id, use, config }) => ({ id, use, config }))
    const provider = settingsOf<{ provider: string }>(rows, 'core:model').provider

    const exchanges: Exchange[] = []
    registry.register(
      createRecordingAdapter(registry.get(provider), (exchange) => {
        exchanges.push(exchange)
      }),
      { replace: true },
    )

    const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
    if (agent === undefined) throw new Error('快照场景：profile 里没有活体 agent')
    await runPrompts(agent, CASE.prompts)

    const events = app.ctx.get(SESSION_SERVICE).events()
    const loopModel = settingsOf<{ loop: { model: string } }>(rows, 'core:agent').loop.model
    const { model } = registry.resolve(loopModel)

    return {
      meta: {
        name: CASE.name,
        profile: CASE.profile,
        prompts: [...CASE.prompts],
        sessionId: CASE.sessionId,
        clock: { ...CASE.clock },
        randomSeed: CASE.randomSeed,
        rows,
        model: { provider, spec: model },
        coveredSources: [...CASE.coveredSources],
      },
      events,
      exchanges,
    }
  } finally {
    await app.dispose('record-finished')
    rmSync(scratch, { recursive: true, force: true })
  }
}

export async function runReplay(snapshot: LoadedSnapshot): Promise<readonly SessionEvent[]> {
  const clock = fixedClock(snapshot.meta.clock)
  const scratch = mkdtempSync(join(tmpdir(), 'bah-cross-scene-replay-'))

  const app = await boot({
    profile: { name: `${snapshot.meta.name}-replay`, bundles: ['snapshot'], hmr: false },
    bundles: [{ name: 'snapshot', rows: snapshot.meta.rows }],
    layers: [],
    catalog: createCatalog(),
    run: {
      sessionId: asSessionId(snapshot.meta.sessionId),
      now: clock.now,
      mintTicketId: snapshotTicketId,
      jsonlDir: scratch,
    },
  })

  try {
    const adapter = new ReplayAdapter({ exchanges: snapshot.exchanges, spec: snapshot.meta.model.spec })
    app.ctx.get(LLM_ADAPTERS).register(adapter, { replace: true })

    const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
    if (agent === undefined) throw new Error('快照回放：重建的应用里没有活体 agent')
    await runPrompts(agent, snapshot.meta.prompts)

    if (adapter.remaining() !== 0) {
      throw new Error(
        `快照回放：录制的 ${snapshot.exchanges.length} 次调用只消费了 ${adapter.consumed()} 次（场景与录制不一致）`,
      )
    }
    return app.ctx.get(SESSION_SERVICE).events()
  } finally {
    await app.dispose('replay-finished')
    rmSync(scratch, { recursive: true, force: true })
  }
}
