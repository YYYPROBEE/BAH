/**
 * 快照场景：**web 渠道装配**跑一段确定性对话（施工单 13 的"渠道不扰动事件流"证据）。
 *
 * 为什么需要这个场景（而不是复用 headless-basic）：
 * `channel:web` 是宿主插件，它一落地就改了两个治理平面文件
 * （`packages/host/src/boot/plugins/index.ts` 与本文件同目录的 `web.ts`）。
 * 按 `verify-snapshot-fresh` 的规矩，覆盖这些路径的场景必须**真的重录过**——
 * 于是本场景就是那条"重录"：它把 Web 渠道真的启动一次（HTTP 端口用 0 由内核分配），
 * 再跑一轮黄色转账（审批 → 票据 → 核销 → 文本收尾）。
 *
 * 它同时回答一个值得写进答辩材料的问题：
 * **"Web 渠道接进来以后，模型看到的东西变了吗？"** —— 回放与录制逐条全等，答案是没有。
 *
 * 确定性纪律与 headless-basic 完全一致（固定时钟 / 不读 home patch / 临时会话目录）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot, createCatalog } from '@bah/host'
import { LLM_ADAPTERS } from '@bah/llm'
import { loadBundles, readLayers, readProfile } from '@bah/cli'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import { ReplayAdapter, asSessionId, createRecordingAdapter, fixedClock } from '@bah/test-support'

import type { SessionEvent } from '@bah/core'
import type { Exchange, LoadedSnapshot, SnapshotMeta, SnapshotRow } from '@bah/test-support'
import type { Agent } from '@bah/runtime'

/** 仓库根（本文件在 `snapshots/<case>/`，向上两层）。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 场景输入（改了它就等于换了场景，必须重录）。 */
export const CASE = {
  name: 'web-channel',
  /** 录制时用 headless 的底座行 + 本目录的 overlay 加 `channel:web`（回放不读 profile）。 */
  profile: 'headless',
  prompts: ['给王建国转 800 元'],
  sessionId: 's-snapshot-web-channel',
  clock: { start: 1_700_000_100_000, step: 1 },
  randomSeed: 7,
  /**
   * 本场景真实驱动的治理平面。
   *
   * 与 headless-basic 的差别只在最后两条：`boot/` 现在包含 Web 渠道插件的装配，
   * 而这次装配真的被执行了（起停一次 HTTP 服务）。
   */
  coveredSources: [
    'packages/runtime/src/agent-loop/',
    'packages/runtime/src/session/',
    'packages/runtime/src/system-prompt/',
    'packages/runtime/src/tools/',
    'packages/runtime/src/seams.ts',
    'packages/llm/src/llm/',
    'packages/llm/src/mock/',
    'packages/bank/src/core/',
    'packages/bank/src/tools/',
    'packages/host/src/boot/',
    'packages/persistence/src/jsonl/',
    'packages/persistence/src/saga-store/',
    'packages/safety/src/sentry/',
    'packages/interaction/src/approval/',
    'packages/saga/src/recovery/',
  ],
} as const

/** 本场景的 overlay（层 4）：把 web 渠道挂上，端口交给内核分配。 */
const OVERLAY = join(REPO_ROOT, 'snapshots', CASE.name, 'overlay.yml')

/** 一个"不存在"的 home 目录：录制与回放都不读开发机上的 home patch。 */
function noHome(): string {
  return join(tmpdir(), 'bah-snapshot-no-home')
}

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

/** 录制：headless 底座 + web 渠道 overlay + 录制中的 mock provider。 */
export async function runRecord(): Promise<{
  readonly meta: SnapshotMeta
  readonly events: readonly SessionEvent[]
  readonly exchanges: readonly Exchange[]
}> {
  const profile = readProfile(REPO_ROOT, CASE.profile)
  const bundles = await loadBundles(REPO_ROOT, profile.bundles)
  const { layers } = readLayers(REPO_ROOT, profile, { home: noHome(), overlays: [OVERLAY] })

  const clock = fixedClock(CASE.clock)
  const scratch = mkdtempSync(join(tmpdir(), 'bah-record-web-'))
  const app = await boot({
    profile,
    bundles,
    layers,
    catalog: createCatalog(),
    run: { sessionId: asSessionId(CASE.sessionId), now: clock.now, jsonlDir: scratch },
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

/** 回放：只读快照重建应用（含 `channel:web` 行），provider 换成 `ReplayAdapter`。 */
export async function runReplay(snapshot: LoadedSnapshot): Promise<readonly SessionEvent[]> {
  const clock = fixedClock(snapshot.meta.clock)
  const scratch = mkdtempSync(join(tmpdir(), 'bah-replay-web-'))

  const app = await boot({
    profile: { name: `${snapshot.meta.name}-replay`, bundles: ['snapshot'], hmr: false },
    bundles: [{ name: 'snapshot', rows: snapshot.meta.rows }],
    layers: [],
    catalog: createCatalog(),
    run: { sessionId: asSessionId(snapshot.meta.sessionId), now: clock.now, jsonlDir: scratch },
  })

  try {
    const adapter = new ReplayAdapter({ exchanges: snapshot.exchanges, spec: snapshot.meta.model.spec })
    app.ctx.get(LLM_ADAPTERS).register(adapter, { replace: true })

    const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
    if (agent === undefined) throw new Error('快照回放：重建的应用里没有活体 agent')
    await runPrompts(agent, snapshot.meta.prompts)

    if (adapter.remaining() !== 0) {
      throw new Error(
        `快照回放：录制的 ${String(snapshot.exchanges.length)} 次调用只消费了 ${String(adapter.consumed())} 次（场景与录制不一致）`,
      )
    }

    return app.ctx.get(SESSION_SERVICE).events()
  } finally {
    await app.dispose('replay-finished')
    rmSync(scratch, { recursive: true, force: true })
  }
}
