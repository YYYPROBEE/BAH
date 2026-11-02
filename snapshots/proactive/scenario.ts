/**
 * 快照场景：`proactive` —— 授权窗口三幕（arm / wake 成立 / wake 失守）+ 重启补跑的证据底稿。
 *
 * 同一个文件服务两端：
 * - **录制**（`runRecord`）：真实 `profiles/plan` + 真实依赖清单，**不经过模型**；
 * - **回放**（`runReplay`）：只读快照，用录下来的行重建应用，跑同一串步骤。
 *
 * 三幕：
 * 1. `fact_remember` 记下"爱人生日"，再用 `plan_arm` 武装一张转账计划（条件 = 事实版本 + 余额）；
 * 2. 判定时钟跳到到期时刻 → `wake` 执行（票据带 `authorization.kind='window'`）；
 * 3. 事实再确认（版本 +1）→ 另一张窗口仍快照在旧版本 → `wake` 失守降级，不执行。
 *
 * 确定性纪律（同 `plan` 场景）：可跳转的注入钟、按 `callId` 派生的票号、临时会话目录、
 * 不读 home patch。
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

/** 起点与到期时刻（固定常数，改了等于换场景 → 必须重录）。 */
const START = 1_700_000_000_000
const DUE = START + 60_000

export const CASE = {
  name: 'proactive',
  profile: 'plan',
  sessionId: 's-snapshot-proactive',
  clock: { start: START, step: 1 },
  randomSeed: 7,
  /**
   * 本场景真实驱动的面（门禁 `snapshot-fresh` 的归属依据）。
   *
   * - `authorization/`：arm 签发、due 扫描、occ 实例键、窗口复验、armed 回放；
   * - `fact/`：写事实、版本 +1、条件按版本比对；
   * - `notify/`：唤醒后的播报建议；
   * - `saga/src/seams.ts`：tick 载荷并集（`plan-wake`）——本场景用 boot 补跑而非 tick，
   *   但该文件的类型改动由本场景的 arm→wake 全链证明不会漂移。
   */
  coveredSources: [
    'packages/runtime/src/authorization/',
    'packages/runtime/src/fact/',
    'packages/runtime/src/notify/',
    'packages/saga/src/seams.ts',
    'packages/runtime/src/index.ts',
  ],
} as const

/** 可跳转的注入钟：默认不动，`jumpTo` 把判定时刻推到到期。 */
function jumpableClock(at: number = START): { readonly now: () => number; jumpTo: (value: number) => void } {
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


/** 三幕脚本（录制与回放共用同一份；任何一步改了都必须重录）。 */
async function runActs(app: BootedApp, clock: { readonly now: () => number; jumpTo: (value: number) => void }): Promise<void> {
  const born = (await callTool(app, 'call-fact-1', 'fact_remember', {
    person: '爱人',
    relation: 'spouse',
    kind: 'birthday',
    date: '1990-10-24',
    confirmed: true,
  })) as { factId: string; version: number }
  if (born.version !== 1) throw new Error('快照场景：新事实的 version 必须是 1')

  const dueIso = new Date(DUE).toISOString()
  await callTool(app, 'call-arm-a', 'plan_arm', {
    title: '快照：生日转账',
    budgetYuan: 1000,
    dueAt: dueIso,
    tier: 'standard',
    conditions: [
      { kind: 'balance-at-least', cents: 1 },
      { kind: 'fact-unchanged', factId: born.factId, version: 1 },
    ],
    nodes: [
      {
        id: 'pay',
        tool: 'transfer_create',
        args: { amount: 300, payee: { name: '王建国', phone: '13900002222' }, remark: '生日' },
        deps: [],
      },
    ],
  })

  // 判定时钟推进到到期（落账时刻也跟着走，两者都来自同一个注入钟）
  // 走 `plan_wake` **工具**而不是直接调服务：判决输入要落进 `tool/result`，I13 才能重算
  clock.jumpTo(DUE)
  const first = (await callTool(app, 'call-wake-1', 'plan_wake', {
    at: new Date(DUE).toISOString(),
  })) as { ok: boolean; entries: readonly { status: string }[] }
  if (!first.ok || first.entries[0]?.status !== 'executed') {
    throw new Error(`快照场景：第一幕应执行，实际 ${JSON.stringify(first.entries)}`)
  }

  // 事实再确认 → 版本 +1；第二张窗口仍快照在 v1
  await callTool(app, 'call-fact-2', 'fact_remember', {
    person: '爱人',
    relation: 'spouse',
    kind: 'birthday',
    date: '1990-10-24',
    confirmed: true,
  })
  await callTool(app, 'call-arm-b', 'plan_arm', {
    title: '快照：过期快照（应失守）',
    budgetYuan: 1000,
    dueAt: dueIso,
    tier: 'standard',
    conditions: [{ kind: 'fact-unchanged', factId: born.factId, version: 1 }],
    nodes: [
      {
        id: 'pay',
        tool: 'transfer_create',
        args: { amount: 200, payee: { name: '王建国', phone: '13900002222' }, remark: '生日' },
        deps: [],
      },
    ],
  })
  const second = (await callTool(app, 'call-wake-2', 'plan_wake', {
    at: new Date(DUE).toISOString(),
  })) as { entries: readonly { status: string; code?: string }[] }
  const downgraded = second.entries.find((entry) => entry.status === 'downgraded')
  if (downgraded === undefined || downgraded.code !== 'condition-failed') {
    throw new Error(`快照场景：第二幕应失守，实际 ${JSON.stringify(second.entries)}`)
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
  const scratch = mkdtempSync(join(tmpdir(), 'bah-proactive-record-'))
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
        prompts: [],
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
  const scratch = mkdtempSync(join(tmpdir(), 'bah-proactive-replay-'))
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
