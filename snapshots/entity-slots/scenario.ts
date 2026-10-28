/**
 * 快照场景：**实体槽位通电**（实体槽位方案 S4）。
 *
 * 为什么需要这个场景（而不是复用 headless-basic）：
 * 槽位的数据层（`packages/bank/src/context/`）与包入口（`packages/bank/src/index.ts`）
 * 是 S2/S3 新增的敏感面；`verify-snapshot-fresh` 要求"改了敏感面就得有覆盖它的场景
 * 且该场景真的重录过"。能诚实覆盖它们的唯一方式，就是让一条对话**真的把槽位读出来**：
 * 所以本场景在 headless 底座上叠一层 overlay（`slots.source=bank`），
 * 录制产物里因此有 `context/slots` 事件与含账户/流水的 `request/context`。
 *
 * 它同时回答三个问题：
 * 1. 槽位真的进了模型输入吗？（`request/context` 里有 3 账户 + 3 流水）
 * 2. 离线路由还读得对"用户原话"吗？（`【当前用户】` 前缀段不被当指令；仍调 `account_balance`）
 * 3. 同一份输入两次回放逐条全等吗？（时钟/排序/格式化没有隐性不确定性）
 *
 * 确定性纪律与 headless-basic 完全一致（固定时钟 / 不读 home patch / 临时会话目录）。
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
  name: 'entity-slots',
  /** 录制时用的 profile（headless 底座 + 本目录 overlay；回放不读 profile）。 */
  profile: 'headless',
  /**
   * 为什么是这句话：离线路由（`packages/llm/src/demo`）只认"查余额 / 转账"两种意图。
   * 如果 `【运行时数据…】` 段被误当成用户原话，路由会走错，快照立刻暴露。
   */
  prompts: ['帮我查一下余额'],
  /** 会话 ID（固定值，回放必须逐字相同）。 */
  sessionId: 's-snapshot-entity-slots',
  /** 确定性时钟（epoch ms）：与 headless-basic 同起点，便于对照。 */
  clock: { start: 1_700_000_000_000, step: 1 },
  /** seeded 随机种子（与 bank-forge 同源；本场景的 demo 档不用随机，保持同源而已）。 */
  randomSeed: 7,
  /**
   * 本场景真实驱动的治理平面（门禁 snapshot-fresh 的归属依据）。
   *
   * 与 headless-basic 的差别只有三条：
   * - `bank/src/context/`：本场景**唯一的目的**（适配器真的被每 step 调用）；
   * - `bank/src/forge/`：demo 造数真的执行了（`buildBankDataset`）；
   * - `bank/src/index.ts`：文件级入口（barrel，不在任何目录前缀里，必须单列）。
   */
  coveredSources: [
    'packages/runtime/src/agent-loop/',
    'packages/runtime/src/agent/',
    'packages/runtime/src/session/',
    'packages/runtime/src/system-prompt/',
    'packages/runtime/src/tools/',
    'packages/runtime/src/policy/',
    'packages/runtime/src/seams.ts',
    'packages/llm/src/llm/',
    'packages/llm/src/mock/',
    'packages/llm/src/demo/',
    'packages/bank/src/core/',
    'packages/bank/src/tools/',
    // 实体槽位：适配器（S2）与包入口（S3 起 host 从这里装配）
    'packages/bank/src/context/',
    'packages/bank/src/index.ts',
    // S0 把 demo 主体改成张三；本场景真的跑了一遍造数
    'packages/bank/src/forge/',
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

/** 本场景的 overlay（层 4）：打开 `slots.source=bank` + 七键预算。 */
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
 * 录制：headless 底座 + 实体槽位 overlay + 录制中的 mock provider。
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
  const scratch = mkdtempSync(join(tmpdir(), 'bah-record-slots-'))
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
 * 注意：回放**不读 overlay**——`scenario.json` 的 rows 已经是"层 4 合并后的生效行"，
 * 其中就带着 `slots: { source: bank }` 与 `contextSlots` 七键。这正是"快照即事实"。
 *
 * @returns 本次回放产生的事件流（与 `snapshot.events` 逐条比对）
 */
export async function runReplay(snapshot: LoadedSnapshot): Promise<readonly SessionEvent[]> {
  const clock = fixedClock(snapshot.meta.clock)
  const scratch = mkdtempSync(join(tmpdir(), 'bah-replay-slots-'))

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
        `快照回放：录制的 ${String(snapshot.exchanges.length)} 次调用只消费了 ${String(adapter.consumed())} 次（场景与录制不一致）`,
      )
    }

    return app.ctx.get(SESSION_SERVICE).events()
  } finally {
    await app.dispose('replay-finished')
    rmSync(scratch, { recursive: true, force: true })
  }
}
