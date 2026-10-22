/**
 * 快照场景：sandbox-compute（施工单 12 §3；本单补沙箱/强验证背书）。
 *
 * 一条确定性对话踩三面：
 * 1. `analysis_calc`（绿级）→ `BANK_COMPUTE` → worker → `sandbox/done`；
 * 2. 新收款人 120 元转账 → 升红 → `approval/challenge-issued` → `verify/sms` → 核销；
 * 3. 余额查询 → 保持普通读的 turn/step/tool 结构。
 *
 * 确定性纪律与 headless-basic 一致，另加一条：沙箱审计钟独立注入
 * （`CASE.sandboxClock` → `RunContext.sandboxNow`），`sandbox/done.elapsedMs` 恒为 5，
 * 不读墙钟；会话时钟仍是 `fixedClock(CASE.clock)`，事件 `at` 不随沙箱调用次数变化。
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

/** 本场景的层 4 overlay：覆盖 mock 脚本与 bank:tools 档位（回放不读它）。 */
const OVERLAY = join(REPO_ROOT, 'snapshots', 'sandbox-compute', 'overlay.yml')

/** 场景输入（改了它就等于换了场景，必须重录）。 */
export const CASE = {
  /** 用例名 = 快照目录名。 */
  name: 'sandbox-compute',
  /** 录制时用的 profile（仅供人看；回放不读它）。 */
  profile: 'headless',
  /** 依次送入的输入（每个跑一个 turn）。 */
  prompts: [
    '餐饮占交通加餐饮的百分之多少？帮我算一下',
    '给新收款人李小雨转 120 元',
    '帮我查一下余额',
  ],
  /** 会话 ID（固定值，回放必须逐字相同）。 */
  sessionId: 's-snapshot-sandbox-compute',
  /** 会话确定性时钟（epoch ms）：事件 `at` 全部等于它（`fixedClock.now` 不推进）。 */
  clock: { start: 1_700_000_000_000, step: 1 },
  /** 沙箱审计钟：独立于会话钟；`tick()` 每次 +5，一次执行两次调用 → elapsedMs = 5。 */
  sandboxClock: { start: 1_000_000, step: 5 },
  /** seeded 随机种子（stress 造数与场景元数据）。 */
  randomSeed: 7,
  /**
   * 本场景真实驱动的治理平面（门禁 snapshot-fresh 的归属依据）。
   *
   * 清单是 headless-basic 的超集：同一套 headless 装配 + 三面对话。
   * 末尾三条是本单新增的“此前无任何场景声明”的目录。
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
    // 场景装配了 bank:saga（config 为空 → b3/b4 全开），boot 期真执行。
    'packages/saga/src/index.ts',
    'packages/saga/src/tick/',
    // analysis_calc 走 compute-bounded 档：真起 worker，language 求值出 78，
    // sandbox/done 带 tier=compute-bounded 与独立钟 elapsedMs=5。
    'packages/safety/src/sandbox-runtime/',
    // boot 期 buildBankDataset({seed:7, tier:'stress'})：余额/流水/收款人均来自 stress 造数；
    // 证据是 scenario.json 的 bank:tools 行 + 本场景 account_balance 的余额 800000 分。
    'packages/bank/src/forge/',
    // 红级转账：审批服务签发挑战 → createBankChallengePort.issue/verify 真执行；
    // 证据是 approval/challenge-issued、verify/sms、approval/decided 事件。
    'packages/bank/src/verify/',
  ],
} as const

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

/**
 * 录制：真实 headless profile + 本场景 overlay + 录制中的 mock provider。
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
  const sandboxClock = fixedClock(CASE.sandboxClock)
  const scratch = mkdtempSync(join(tmpdir(), 'bah-record-sandbox-'))
  const app = await boot({
    profile,
    bundles,
    layers,
    catalog: createCatalog(),
    run: {
      sessionId: asSessionId(CASE.sessionId),
      now: clock.now,
      sandboxNow: sandboxClock.tick,
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

/**
 * 回放：**只读快照**，用录制下来的行重建应用，provider 换成 `ReplayAdapter`。
 *
 * @returns 本次回放产生的事件流（与 `snapshot.events` 逐条比对）
 */
export async function runReplay(snapshot: LoadedSnapshot): Promise<readonly SessionEvent[]> {
  const clock = fixedClock(snapshot.meta.clock)
  const sandboxClock = fixedClock(CASE.sandboxClock)
  const scratch = mkdtempSync(join(tmpdir(), 'bah-replay-sandbox-'))

  const app = await boot({
    profile: { name: `${snapshot.meta.name}-replay`, bundles: ['snapshot'], hmr: false },
    bundles: [{ name: 'snapshot', rows: snapshot.meta.rows }],
    layers: [],
    catalog: createCatalog(),
    run: {
      sessionId: asSessionId(snapshot.meta.sessionId),
      now: clock.now,
      sandboxNow: sandboxClock.tick,
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
