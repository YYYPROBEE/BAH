/**
 * 快照场景：`scheduled-funds` —— 定时转账入口（`transfer_schedule`）与资金锁定
 * （`fund_lock` 的 lock / status / release 三动作）的端到端证据底稿。
 *
 * 为什么单开一条而不塞进 `proactive`：那两个工具此前在 11 个快照场景里
 * **调用次数都是 0**（2026-11-15 逐行解析 `session.jsonl` 实测），
 * 而 `proactive` 证明的是 `plan_arm` 的窗口三幕，语义不同。
 *
 * 四幕：
 * 1. `transfer_schedule` 用 ISO 绝对时刻武装一张宽档窗口（避免"明天"的时区依赖），
 *    武装时完成一次强验证（`approval/challenge-issued` 落账）；
 * 2. `fund_lock lock` 把 1000 元活期划到本人锁定账户；
 * 3. `fund_lock status` 只读复核锁定额与可用额，`release` 释放 400 元；
 * 4. 时钟跳到到期 → `plan_wake` 执行窗口里的 `transfer_create`（200 元）。
 *
 * 确定性纪律同 `proactive`：可跳转注入钟、按 `callId` 派生票号、临时会话目录。
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
  name: 'scheduled-funds',
  profile: 'plan',
  sessionId: 's-snapshot-scheduled-funds',
  clock: { start: START, step: 1 },
  randomSeed: 11,
  /**
   * 本场景真实驱动的面（门禁 `snapshot-fresh` 的归属依据）：
   *
   * - `host/boot/plugins/plan.ts`：`transfer_schedule` 的定义、`armPlan` 宽档校验、
   *   `plan_wake` 的窗口执行；
   * - `bank/src/tools/fund-lock.ts`：锁定/释放/只读三动作与账本重读；
   * - `runtime/src/authorization/`：窗口签发、到期扫描与代签；
   * - `runtime/src/index.ts`：管线与服务的导出面。
   */
  coveredSources: [
    'packages/host/src/boot/plugins/plan.ts',
    'packages/bank/src/tools/fund-lock.ts',
    // 两个工具都过银行治理面：`specs.ts` 声明 tier/amountPath，`governance.ts` 算票据金额
    // 并判级。2026-11-15 修 `fund_lock` 票据金额时，这两处正是被改的行为面。
    'packages/bank/src/tools/specs.ts',
    'packages/bank/src/tools/governance.ts',
    'packages/runtime/src/authorization/',
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
    throw new Error(
      `快照场景：${name} 失败（${execution.result.code ?? 'unknown'}）：` +
        `${execution.result.reason ?? '(no reason)'}`,
    )
  }
  return execution.value
}

/** 四幕脚本（录制与回放共用同一份；任何一步改了都必须重录）。 */
async function runActs(
  app: BootedApp,
  clock: { readonly now: () => number; jumpTo: (value: number) => void },
): Promise<void> {
  // 第 1 幕：定时转账（ISO 绝对时刻，避免自然语言时间词的时区依赖）
  const scheduled = (await callTool(app, 'call-schedule-1', 'transfer_schedule', {
    amount: 200,
    // F-03：手机号不进计划体（落盘脱敏会破坏重启回放）；只用 name 匹配已登记收款人。
    payee: { name: '王建国' },
    when: new Date(DUE).toISOString(),
    remark: '定时房租',
  })) as {
    readonly scheduleId: string
    readonly planId: string
    readonly dueAt: number
    readonly amount: number
    readonly payeeName: string
  }
  if (scheduled.dueAt !== DUE) {
    throw new Error(`快照场景：dueAt 应为 ${String(DUE)}，实际 ${String(scheduled.dueAt)}`)
  }
  if (scheduled.amount !== 200 || scheduled.payeeName !== '王建国') {
    throw new Error(`快照场景：定时转账回显不符 —— ${JSON.stringify(scheduled)}`)
  }

  // 第 2 幕：锁定 1000 元（100000 分）
  const locked = (await callTool(app, 'call-fund-lock-1', 'fund_lock', {
    action: 'lock',
    amountYuan: 1000,
  })) as {
    readonly action: string
    readonly amountCents?: number
    readonly lockedCents: number
    readonly availableCents: number
    readonly txnId?: string
  }
  if (locked.action !== 'lock' || locked.amountCents !== 100_000) {
    throw new Error(`快照场景：锁定金额应为 100000 分，实际 ${JSON.stringify(locked)}`)
  }
  if (locked.txnId === undefined) throw new Error('快照场景：锁定必须产生流水号')

  // 第 3 幕：只读复核 + 释放 400 元
  const status = (await callTool(app, 'call-fund-lock-2', 'fund_lock', {
    action: 'status',
  })) as {
    readonly action: string
    readonly lockedCents: number
    readonly availableCents: number
    readonly txnId?: string
  }
  if (status.action !== 'status' || status.lockedCents !== locked.lockedCents) {
    throw new Error(`快照场景：status 必须复读账本锁定额，实际 ${JSON.stringify(status)}`)
  }
  if (status.txnId !== undefined) throw new Error('快照场景：status 是只读分支，不应有流水号')

  const released = (await callTool(app, 'call-fund-lock-3', 'fund_lock', {
    action: 'release',
    amountYuan: 400,
  })) as {
    readonly action: string
    readonly amountCents?: number
    readonly lockedCents: number
    readonly availableCents: number
  }
  if (released.action !== 'release' || released.amountCents !== 40_000) {
    throw new Error(`快照场景：释放金额应为 40000 分，实际 ${JSON.stringify(released)}`)
  }
  if (released.lockedCents >= locked.lockedCents) {
    throw new Error('快照场景：释放后锁定额必须下降')
  }

  // 第 4 幕：到期唤醒 → 窗口代签 → transfer_create 200 元
  clock.jumpTo(DUE)
  const wake = (await callTool(app, 'call-wake-1', 'plan_wake', {
    at: new Date(DUE).toISOString(),
  })) as { ok: boolean; entries: readonly { status: string; code?: string }[] }
  if (!wake.ok || wake.entries[0]?.status !== 'executed') {
    throw new Error(`快照场景：定时转账到期应执行，实际 ${JSON.stringify(wake.entries)}`)
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
  const scratch = mkdtempSync(join(tmpdir(), 'bah-scheduled-funds-record-'))
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
  const scratch = mkdtempSync(join(tmpdir(), 'bah-scheduled-funds-replay-'))
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
