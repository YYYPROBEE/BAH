/**
 * 快照场景：**策略外置通电**（策略外置 S4 / PE-44）。
 *
 * 为什么需要这个场景（而不是复用 headless-basic）：
 * headless-basic 走的是生产 `bank-tier/1.0.0`，与 legacy 穷举等价——判决"看起来一样"
 * 证明不了判决来自外置文件。本场景在 headless 底座上叠一层 overlay，把 active 切到
 * `bank-tier-demo/1.1.0`（单笔 ≥ 800 元白名单升红），再用一句 800 元转账把差异打出来：
 * `tier/decided` 必须是 `red + TR-004-single-large + bank-tier-demo/1.1.0`，
 * 而同一份输入在 `tier.ts` legacy 下是黄级。
 *
 * 同一个文件同时服务两端：
 * - **录制**（`runRecord`）：用真实 `profiles/headless` + overlay + 真 mock provider；
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
  name: 'policy-externalized',
  /** 录制时用的 profile（headless 底座 + 本目录 overlay；回放不读 profile）。 */
  profile: 'headless',
  /**
   * 为什么是这句话：离线 router 抽得出「800 元 + 王建国」，王建国是 demo 档白名单；
   * 800 元在 legacy 下是黄级，在演示 bundle 的 `TR-004-single-large` 下是红级。
   */
  prompts: ['给王建国转 800 元'],
  /** 会话 ID（固定值，回放必须逐字相同）。 */
  sessionId: 's-snapshot-policy-externalized',
  /** 确定性时钟（epoch ms）：与 headless-basic 同起点，便于对照。 */
  clock: { start: 1_700_000_000_000, step: 1 },
  /** seeded 随机种子（与 bank-forge 同源接口的预留位；本场景暂未用到）。 */
  randomSeed: 7,
  /**
   * 本场景真实驱动的治理平面（门禁 snapshot-fresh 的归属依据）。
   *
   * 与 headless-basic 的差别只有四条：
   * - `packages/policy/src/`：编译/求值/摘要真的执行了；
   * - `packages/host/src/boot/plugins/policy.ts`：载入 registry、提供引擎、发 `bundle-loaded`；
   * - `packages/bank/src/tools/{policy,governance,tier}.ts`：输入映射、判决、legacy oracle；
   * - `packages/bank/src/tools/transfers.ts`：试算卡片与执行判决共用同一判定矩阵。
   */
  coveredSources: [
    'packages/runtime/src/agent-loop/',
    'packages/runtime/src/agent/',
    'packages/runtime/src/session/',
    'packages/runtime/src/system-prompt/',
    'packages/runtime/src/tools/',
    // 治理平面每次判决都走 `runtime:policy` 端口；本场景的实现来自宿主 policy:rules。
    'packages/runtime/src/policy/',
    'packages/runtime/src/seams.ts',
    // 策略外置：编译器/求值器/内容寻址（bundle 真的被载入并求值）
    'packages/policy/src/',
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

/** 本场景的 overlay（层 4）：active 切到演示 bundle + `statePath` 指向不存在的文件。 */
const OVERLAY = join(REPO_ROOT, 'snapshots', CASE.name, 'overlay.yml')

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
  const { layers } = readLayers(REPO_ROOT, profile, { home: noHome(), overlays: [OVERLAY] })

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
