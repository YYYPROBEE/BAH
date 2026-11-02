/**
 * 快照场景：headless profile 跑一段确定性对话。
 *
 * 同一个文件同时服务两端：
 * - **录制**（`runRecord`）：用真实 `profiles/headless` + 真 mock provider，把 provider 调用换成
 *   "录制中"的包装（分片原样透传），跑完返回 `{ meta, events, exchanges }` 交给 harness 落盘；
 * - **回放**（`runReplay`）：**只读快照**——不读 `profiles/`、不读 `bah.yml`、不联网、不读密钥，
 *   用录制下来的行重建应用，再把 provider 换成 `ReplayAdapter`。
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
  name: 'subscription',
  /** 录制时用的 profile（仅供人看；回放不读它）。 */
  profile: 'subscription',
  /**
   * 依次送入的输入（每个跑一个 turn）。
   *
   * 五幕覆盖场景 5 的完整闭环：查 → 合约硬拦 → 到期即断 → 关协议 → 设提醒。
   * 第二幕故意失败：它证明「合约期内退订」是**工具硬拦**，不是审批放行。
   */
  prompts: [
    '我有哪些订阅',
    '视频会员退订',
    '确认，到期即断',
    '彻底停掉视频会员的扣款',
    '提前三天提醒我续费云音乐',
  ],
  /** 会话 ID（固定值，回放必须逐字相同）。 */
  sessionId: 's-snapshot-subscription',
  /** 确定性时钟（epoch ms）：起点取一个固定整数，绝不读真实时间。 */
  clock: { start: 1_700_000_000_000, step: 1 },
  /** seeded 随机种子（recurring 档是固定脚本，种子不参与造数）。 */
  randomSeed: 7,
  /**
   * 本场景真实驱动的治理平面（门禁 snapshot-fresh 的归属依据）。
   *
   * 与 headless-basic 的差别：多了 `bank/src/detect/`（sub_list 真的跑了周期检测）、
   * `bank/src/forge/`（recurring 档真的被造出来）与 `llm/src/demo/` 的订阅路由。
   */
  coveredSources: [
    'packages/runtime/src/agent-loop/',
    'packages/runtime/src/agent/',
    'packages/runtime/src/session/',
    'packages/runtime/src/system-prompt/',
    'packages/runtime/src/tools/',
    'packages/runtime/src/policy/',
    'packages/runtime/src/seams.ts',
    'packages/runtime/src/intent/',
    'packages/interaction/src/prompt/',
    'packages/llm/src/llm/',
    'packages/llm/src/mock/',
    'packages/llm/src/demo/',
    'packages/bank/src/core/',
    'packages/bank/src/tools/',
    'packages/bank/src/detect/',
    'packages/bank/src/forge/',
    'packages/bank/src/index.ts',
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
  const { layers } = readLayers(REPO_ROOT, profile, { home: noHome(), overlays: [] })

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
