/**
 * 快照场景：`subscription-reminder` —— 订阅续费**主动**提醒（ADR-0016）。
 *
 * 同一个文件服务两端：
 * - **录制**（`runRecord`）：真实 `profiles/plan` + 真实依赖清单，**不经过模型**；
 * - **回放**（`runReplay`）：只读快照，用录下来的行重建应用，跑同一串步骤。
 *
 * 三幕（对应任务书 §6 的第一条与第三条）：
 *
 * 1. **当日汇总**：还没标 remind 时先 tick 一次——3 天内无、7 天内有 1 笔即将扣款，
 *    发**一条**汇总（`sub:digest:<YYYY-MM-DD>`，`exec` 档）；
 * 2. **用户要求的提前提醒**：`sub_watch(remind, aheadDays=3)` 之后把钟推到 D+3，
 *    再 tick → 一条逐条提醒（`sub:<id>:<YYYY-MM>`，`decision` 档）；
 * 3. **幂等**：同一时刻之后 1ms 再 tick 一次 —— **零新事件**（幂等账本按 key 生效）。
 *
 * 确定性纪律（同 `plan` / `proactive` 场景）：可跳转的注入钟、按 `callId` 派生的票号、
 * 临时会话目录、不读 home patch。**tick 由脚本显式派发**（不是等定时器），
 * 且 overlay 把 `catchUpOnBoot` 关掉——否则 boot 补跑会与脚本抢同一个 key。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadBundles, readLayers, readProfile } from '@bah/cli'
import { boot, createCatalog, RUN_SERVICE, testRunContext } from '@bah/host'
import { LLM_ADAPTERS } from '@bah/llm'
import { SESSION_SERVICE, TOOLS_SERVICE, ToolGuard, ToolPipeline } from '@bah/runtime'
import { asSessionId } from '@bah/test-support'

import type { SessionEvent, TicketId } from '@bah/core'
import type { BootedApp } from '@bah/host'
import type { Exchange, LoadedSnapshot, SnapshotMeta, SnapshotRow } from '@bah/test-support'

/** 仓库根（本文件在 `snapshots/<case>/`，向上两层）。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 起点：2026-10-20 09:00（UTC+8）——白天，不会被静默时段压掉。 */
const START = Date.UTC(2026, 9, 20, 1, 0)

/** 第三幕的判定时刻：D+3 的同一钟点（demo 档的视频会员在 D+5 扣费 → 还剩 2 天）。 */
const DUE_SOON = START + 3 * 86_400_000

export const CASE = {
  name: 'subscription-reminder',
  profile: 'plan',
  sessionId: 's-snapshot-sub-reminder',
  clock: { start: START, step: 1 },
  randomSeed: 7,
  prompts: [] as const,
  /**
   * 本场景真实驱动的面（门禁 `snapshot-fresh` 的归属依据）。
   *
   * - `host/src/boot/plugins/`：本插件本体、`bank:audit` / `bank:subscription-probe` 两个服务、
   *   依赖清单与 tick 派发数组；
   * - `bank/src/tools/`：`sub_watch` 写提醒标记 + `proactive/reminder` 事件声明；
   * - `bank/src/detect/`：即将扣款的口径（`upcomingCharges` 背后的周期推断）；
   * - `saga/src/tick/` 与 `saga/src/seams.ts`：`sub-reminder` 这个 job 名与 tick 载荷并集；
   * - `channels/src/web/`：事件 → `notice` 帧的投影（本场景的事件必须回放成同一条提示）。
   */
  coveredSources: [
    'packages/host/src/boot/plugins/',
    'packages/bank/src/tools/events.ts',
    'packages/bank/src/tools/subscriptions.ts',
    'packages/bank/src/detect/',
    'packages/saga/src/tick/',
    'packages/saga/src/seams.ts',
    'packages/channels/src/web/',
  ],
} as const

/** 可跳转的注入钟：默认不动，`jumpTo` 把判定时刻推到下一幕。 */
function jumpableClock(at: number = START): {
  readonly now: () => number
  jumpTo: (value: number) => void
} {
  let current = at
  return {
    now: () => current,
    jumpTo: (value: number) => {
      current = value
    },
  }
}

const snapshotTicketId = (callId: string): TicketId => `ticket:${callId}` as TicketId

function settingsOf<T>(rows: SnapshotRow[], id: string): T {
  const row = rows.find((candidate) => candidate.id === id)
  if (row === undefined) throw new Error(`快照场景：生效行里没有 ${id}`)
  return row.config as T
}

/** 通过管线执行工具（callId 固定 → 票号可复现）。 */
async function callTool(
  app: BootedApp,
  callId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const session = app.ctx.get(SESSION_SERVICE)
  const pipeline = new ToolPipeline({
    ctx: app.ctx,
    registry: app.ctx.get(TOOLS_SERVICE),
    session,
    guard: new ToolGuard(),
    sessionId: session.sessionId,
    now: () => app.ctx.get(RUN_SERVICE).now(),
    mintTicketId: snapshotTicketId,
  })
  const execution = await pipeline.execute({ callId, name, args })
  if (execution.result.isError) {
    throw new Error(`快照场景：${name} 失败（${execution.result.code ?? 'unknown'}）`)
  }
  return execution.value
}

/** 当前会话里某种事件的条数（等异步 job 落地用）。 */
function countOf(app: BootedApp, type: string): number {
  return app.ctx
    .get(SESSION_SERVICE)
    .events()
    .filter((event) => String(event.type) === type).length
}

/**
 * 派发一次 `saga/tick` 并等 job 落地。
 *
 * `dispatchTick` 自带 `(job, now)` 幂等指针：同一 `now` 第二次派发会被跳过，所以
 * "再 tick 一次"必须换一个 `now`（这里 +1ms），否则测到的是幂等指针而不是提醒的幂等。
 */
async function tick(app: BootedApp, at: number, expected: number): Promise<void> {
  await app.ctx.events.serial('saga/tick', { now: at, dueJobs: ['sub-reminder'] })
  // job 里是 `void scanOnce(...)`：轮询到预期条数（上限 50 次 setImmediate）
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (countOf(app, 'proactive/reminder') >= expected) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(
    `快照场景：tick 后应有 ${String(expected)} 条 proactive/reminder，实际 ${String(
      countOf(app, 'proactive/reminder'),
    )}`,
  )
}

/** 三幕脚本（录制与回放共用同一份；任何一步改了都必须重录）。 */
async function runActs(
  app: BootedApp,
  clock: { readonly now: () => number; jumpTo: (value: number) => void },
): Promise<void> {
  // 第一幕：当日汇总（未标 remind 的 7 天内即将扣款 → 一条，不是每笔一条）
  await tick(app, START, 1)

  // 第二幕：用户明确要求「提前 3 天提醒」，再把钟推到 D+3 → 逐条提醒一条
  await callTool(app, 'call-watch-1', 'sub_watch', {
    subscriptionId: 's-1',
    watch: 'remind',
    aheadDays: 3,
  })
  clock.jumpTo(DUE_SOON)
  await tick(app, DUE_SOON, 2)

  // 第三幕：同一时刻之后 1ms 再 tick —— 幂等账本按 key 生效，不许出第三条
  await tick(app, DUE_SOON + 1, 2)
  if (countOf(app, 'proactive/reminder') !== 2) {
    throw new Error('快照场景：幂等失效（同一 key 被发了两次）')
  }
}

export async function runRecord(): Promise<{
  readonly meta: SnapshotMeta
  readonly events: readonly SessionEvent[]
  readonly exchanges: readonly Exchange[]
}> {
  const profile = readProfile(REPO_ROOT, CASE.profile)
  const bundles = await loadBundles(REPO_ROOT, profile.bundles)
  const { layers } = readLayers(REPO_ROOT, profile, {
    home: join(tmpdir(), 'bah-snapshot-no-home'),
    overlays: [join(REPO_ROOT, 'snapshots', CASE.name, 'overlay.yml')],
  })

  const clock = jumpableClock()
  const scratch = mkdtempSync(join(tmpdir(), 'bah-sub-reminder-record-'))
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
    const rows: SnapshotRow[] = app.rows().map(({ id, use, config }) => ({ id, use, config }))
    await runActs(app, clock)
    const events = app.ctx.get(SESSION_SERVICE).events()
    const provider = settingsOf<{ provider: string }>(rows, 'core:model').provider
    const loopModel = settingsOf<{ loop: { model: string } }>(rows, 'core:agent').loop.model
    const { model } = app.ctx.get(LLM_ADAPTERS).resolve(loopModel)

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
      exchanges: [],
    }
  } finally {
    await app.dispose('record-finished')
    rmSync(scratch, { recursive: true, force: true })
  }
}

export async function runReplay(snapshot: LoadedSnapshot): Promise<readonly SessionEvent[]> {
  const clock = jumpableClock()
  const scratch = mkdtempSync(join(tmpdir(), 'bah-sub-reminder-replay-'))
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
    await runActs(app, clock)
    return app.ctx.get(SESSION_SERVICE).events()
  } finally {
    await app.dispose('replay-finished')
    rmSync(scratch, { recursive: true, force: true })
  }
}
