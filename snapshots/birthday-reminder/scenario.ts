/**
 * 快照场景：`birthday-reminder` —— 生日主动检测（复用 ADR-0016 通道）。
 *
 * 同一个文件服务两端：
 * - **录制**（`runRecord`）：真实 `profiles/plan` + 真实依赖清单，**不经过模型**；
 * - **回放**（`runReplay`）：只读快照，用录下来的行重建应用，跑同一串步骤。
 *
 * 三幕：
 * 1. `fact_remember` 记下「爱人生日 1990-03-08」；
 * 2. 钟在 2026-03-05 → `birthday-reminder` tick → **一条** `proactive/reminder(source='birthday')`；
 * 3. 同日再 tick、钟推到 03-08 当天再 tick → **零新事件**（`birthday:<factId>:2026` 一年一次）。
 *
 * 确定性纪律（同 `subscription-reminder`）：可跳转的注入钟、临时会话目录、
 * 不读 home patch；tick 由脚本显式派发，overlay 关掉 boot 补跑，避免与脚本抢同一个 key。
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

/** 起点：2026-03-05 09:00（UTC+8）—— 生日前 3 天，白天不会被静默。 */
const START = Date.UTC(2026, 2, 5, 1, 0)
/** 生日当天（同一钟点）。 */
const BIRTHDAY = Date.UTC(2026, 2, 8, 1, 0)

export const CASE = {
  name: 'birthday-reminder',
  profile: 'plan',
  sessionId: 's-snapshot-birthday',
  clock: { start: START, step: 1 },
  randomSeed: 7,
  prompts: [] as const,
  /**
   * 本场景真实驱动的面（门禁 `snapshot-fresh` 的归属依据）。
   *
   * - `host/src/boot/plugins/`：`birthday.ts` 扫描器、`proactive.ts` 的第二个 tick job、
   *   事实账本取数；
   * - `runtime/src/fact/`：`fact_remember` 落账与 `replayFacts` 重建；
   * - `bank/src/tools/events.ts`：`proactive/reminder` 事件声明；
   * - `saga/src/tick/` 与 `saga/src/seams.ts`：`birthday-reminder` job 名与 tick 载荷并集；
   * - `channels/src/web/`：事件 → `notice` 帧的投影（刷新后仍在）。
   */
  coveredSources: [
    'packages/host/src/boot/plugins/',
    'packages/runtime/src/fact/',
    'packages/bank/src/tools/events.ts',
    'packages/saga/src/tick/',
    'packages/saga/src/seams.ts',
    'packages/channels/src/web/',
  ],
} as const

/** 可跳转的注入钟。 */
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
 * `dispatchTick` 自带 `(job, now)` 幂等指针：同一 `now` 第二次派发会被跳过，
 * 所以"再 tick 一次"必须换一个 `now`（这里 +1ms）。
 */
async function tick(app: BootedApp, at: number, expected: number): Promise<void> {
  await app.ctx.events.serial('saga/tick', { now: at, dueJobs: ['birthday-reminder'] })
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
  // 第一幕：记下生日（结构化事实；kind='birthday' + date）
  await callTool(app, 'call-fact-1', 'fact_remember', {
    person: '爱人',
    relation: 'spouse',
    kind: 'birthday',
    date: '1990-03-08',
    confirmed: true,
  })

  // 第二幕：提前 3 天 → 一条提醒
  await tick(app, START, 1)
  const reminders = app.ctx
    .get(SESSION_SERVICE)
    .events()
    .filter((event) => String(event.type) === 'proactive/reminder')
  const first = reminders[0]
  if (first === undefined) throw new Error('快照场景：没有落下生日提醒')
  if (String((first.data as Record<string, unknown>)['source']) !== 'birthday') {
    throw new Error('快照场景：提醒 source 不是 birthday')
  }

  // 第三幕：同日再 tick（+1ms）→ 幂等；生日当天再 tick → 仍一年一次
  await tick(app, START + 1, 1)
  clock.jumpTo(BIRTHDAY)
  await tick(app, BIRTHDAY, 1)
  if (countOf(app, 'proactive/reminder') !== 1) {
    throw new Error('快照场景：生日提醒重复了（一年一次的幂等失效）')
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
  const scratch = mkdtempSync(join(tmpdir(), 'bah-birthday-record-'))
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
  const scratch = mkdtempSync(join(tmpdir(), 'bah-birthday-replay-'))
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
