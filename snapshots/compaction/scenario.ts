/**
 * 快照场景：headless 压缩演示。
 *
 * 与 `headless-basic` 共用同一套装配，只做两处改动：
 * - 叠 `profiles/headless/patch-compaction.yml`，把阈值压到 `maxTurns: 1, keepRecentTurns: 1`；
 * - 连发三轮，让第 2 轮 end 折叠第 1 轮、第 3 轮请求带上摘要（第 3 轮 end 再折叠第 2 轮）。
 *
 * 这个场景存在的唯一目的：让 `compaction/summary` 的**实际载荷**进入可回放快照，
 * 而不是只声明"代码被执行过"。摘要文案、refs、工具要点、金融字段的回归都能在这里看。
 *
 * 三条确定性纪律（少一条"两次回放全等"就会偶发失败）：
 * 1. 时钟来自 `fixedClock`（不碰 `Date.now`）；
 * 2. home patch 指向一个不存在的临时目录（不读开发机上的 `~/.bah`）；
 * 3. 会话目录是临时目录（录制产物由 harness 写，回放不写仓库）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot, createCatalog, testRunContext } from '@bah/host'
import { LLM_ADAPTERS } from '@bah/llm'
import { loadBundles, readLayers, readProfile } from '@bah/cli'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import { ReplayAdapter, asSessionId, createRecordingAdapter, fixedClock } from '@bah/test-support'

import type { SessionEvent, TicketId } from '@bah/core'
import type { Exchange, LoadedSnapshot, SnapshotMeta, SnapshotRow } from '@bah/test-support'
import type { Agent } from '@bah/runtime'

/** 仓库根（本文件在 `snapshots/<case>/`，向上两层）。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 场景输入（改了它就等于换了场景，必须重录）。 */
export const CASE = {
  /** 用例名 = 快照目录名。 */
  name: 'compaction',
  /** 录制时用的 profile（仅供人看；回放不读它）。 */
  profile: 'headless',
  /** 依次送入的输入（每个跑一个 turn；三轮足够触发两次折叠）。 */
  prompts: [
    '第一轮：请记住尾号 1234 的账户',
    '第二轮：这个账户的余额是多少',
    '第三轮：按刚才那个账户再查一次',
  ],
  /** 会话 ID（固定值，回放必须逐字相同）。 */
  sessionId: 's-snapshot-compaction',
  /** 确定性时钟（epoch ms）：起点取一个固定整数，绝不读真实时间。 */
  clock: { start: 1_700_000_000_000, step: 1 },
  /** seeded 随机种子（与 bank-forge 同源接口的预留位；本场景暂未用到）。 */
  randomSeed: 7,
  /**
   * 本场景真实驱动的治理平面（门禁 snapshot-fresh 的归属依据）。
   *
   * 装配与 `headless-basic` 相同，差别在本场景**真的触发了折叠**：
   * 第 2 轮 end 折叠第 1 轮、第 3 轮请求带上摘要、第 3 轮 end 再折叠第 2 轮。
   * 因此 `runtime/src/compaction/` 不是声明出来的覆盖，而是录制产物里看得见的
   * `compaction/summary` 事件（含摘要正文、`refs`、对话要点与金融字段）。
   */
  coveredSources: [
    'packages/runtime/src/agent-loop/',
    'packages/runtime/src/agent/',
    'packages/runtime/src/session/',
    'packages/runtime/src/system-prompt/',
    'packages/runtime/src/tools/',
    'packages/runtime/src/policy/',
    'packages/runtime/src/seams.ts',
    // 本场景的折叠/摘要/投影（summarize.ts / apply.ts / types.ts）
    'packages/runtime/src/compaction/',
    'packages/llm/src/llm/',
    'packages/llm/src/mock/',
    'packages/llm/src/demo/',
    'packages/bank/src/core/',
    'packages/bank/src/tools/',
    'packages/host/src/boot/',
    'packages/persistence/src/jsonl/',
    'packages/persistence/src/chain/',
    'packages/persistence/src/saga-store/',
    'packages/safety/src/sentry/',
    'packages/safety/src/verify/',
    'packages/interaction/src/approval/',
    'packages/saga/src/recovery/',
    'packages/saga/src/index.ts',
    'packages/saga/src/tick/',
  ],
} as const

/** 一个"不存在"的 home 目录：录制与回放都不读开发机上的 home patch。 */
function noHome(): string {
  return join(tmpdir(), 'bah-snapshot-no-home')
}

/** 快照面的票据 ID：按 `callId` 派生（生产仍随机；见 `ToolPipelineOptions.mintTicketId`）。 */
const snapshotTicketId = (callId: string): TicketId => `ticket:${callId}` as TicketId

/** 跑完全部 prompt（每个 prompt 一个 turn）。 */
async function runPrompts(agent: Agent, prompts: readonly string[]): Promise<void> {
  for (const prompt of prompts) {
    agent.send(prompt)
    await agent.run()
  }
}

/** 从生效行里取某行的配置（找不到就 fail-loud，别猜默认值）。 */
function settingsOf<T>(rows: SnapshotRow[], id: string): T {
  const row = rows.find((candidate) => candidate.id === id)
  if (row === undefined) throw new Error(`快照场景：生效行里没有 ${id}`)
  return row.config as T
}

/**
 * 录制：真实 headless profile + 录制中的 mock provider。
 *
 * @returns 交给 `recordSnapshot` 的三样东西（场景输入 / 事件流 / provider 调用序列）
 */
export async function runRecord(): Promise<{
  readonly meta: SnapshotMeta
  readonly events: readonly SessionEvent[]
  readonly exchanges: readonly Exchange[]
}> {
  const profile = readProfile(REPO_ROOT, CASE.profile)
  const bundles = await loadBundles(REPO_ROOT, profile.bundles)
  const { layers } = readLayers(REPO_ROOT, profile, {
    home: noHome(),
    // 复用演示用的压缩 overlay：阈值 maxTurns=1 / keepRecentTurns=1 + 三条固定 mock 文本。
    // 不在快照里改 profile 本体，避免影响真实 headless 演示的阈值。
    overlays: ['profiles/headless/patch-compaction.yml'],
  })

  const clock = fixedClock(CASE.clock)
  const scratch = mkdtempSync(join(tmpdir(), 'bah-record-'))
  const app = await boot({
    profile,
    bundles,
    layers,
    catalog: createCatalog(),
    run: testRunContext({
      sessionId: asSessionId(CASE.sessionId),
      now: clock.now,
      mintTicketId: snapshotTicketId,
      jsonlDir: scratch,
    }),
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

/**
 * 回放：**只读快照**，用录制下来的行重建应用，provider 换成 `ReplayAdapter`。
 *
 * @returns 本次回放产生的事件流（与 `snapshot.events` 逐条比对）
 */
export async function runReplay(snapshot: LoadedSnapshot): Promise<readonly SessionEvent[]> {
  const clock = fixedClock(snapshot.meta.clock)
  const scratch = mkdtempSync(join(tmpdir(), 'bah-replay-'))

  const app = await boot({
    profile: { name: `${snapshot.meta.name}-replay`, bundles: ['snapshot'], hmr: false },
    bundles: [{ name: 'snapshot', rows: snapshot.meta.rows }],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({
      sessionId: asSessionId(snapshot.meta.sessionId),
      now: clock.now,
      mintTicketId: snapshotTicketId,
      jsonlDir: scratch,
    }),
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
