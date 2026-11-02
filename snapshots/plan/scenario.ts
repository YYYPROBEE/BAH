/**
 * 快照场景：`plan:dag` 编排原语跑一张固定的 3 节点计划。
 *
 * 同一个文件服务两端：
 * - **录制**（`runRecord`）：真实 `profiles/plan` + 真实依赖清单，直接调 `bah:plan` 跑计划，
 *   全程不碰模型（plan 由数据构造，不由模型生成）；
 * - **回放**（`runReplay`）：**只读快照**——不读 `profiles/`、不读 `bah.yml`、不联网、不读密钥，
 *   用录制下来的行重建应用，再跑**同一张计划**。
 *
 * 三条确定性纪律（少一条"两次回放全等"就会偶发失败）：
 * 1. 时钟来自 `fixedClock`：`plan/created.at` 与每个节点的 `durationMs` 都从它派生；
 * 2. 票据 ID 按 `callId` 派生（`mintTicketId`）：生产随机、验收可复现；
 * 3. home patch 指向不存在的临时目录（不读开发机上的 `~/.bah`），会话目录是临时目录。
 *
 * 为什么这张计划放在 `scenario.ts` 常量里而不是 `scenario.json`：`SnapshotMeta` 没有
 * "计划"这个字段，而计划本体**含金额与收款人**，不该进 append-only 的会话日志
 * （方案 §3.5 约束 2）。它属于场景输入，与 `prompts` 同层。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadBundles, readLayers, readProfile } from '@bah/cli'
import { boot, createCatalog, PLAN_SERVICE, testRunContext } from '@bah/host'
import { LLM_ADAPTERS } from '@bah/llm'
import { SESSION_SERVICE, type Plan } from '@bah/runtime'
import { asSessionId, fixedClock } from '@bah/test-support'

import type { SessionEvent, TicketId } from '@bah/core'
import type { Exchange, LoadedSnapshot, SnapshotMeta, SnapshotRow } from '@bah/test-support'

/** 仓库根（本文件在 `snapshots/<case>/`，向上两层）。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 场景输入（改了它就等于换了场景，必须重录）。 */
export const CASE = {
  /** 用例名 = 快照目录名。 */
  name: 'plan',
  /** 录制时用的 profile（仅供人看；回放不读它）。 */
  profile: 'plan',
  /** 会话 ID（固定值，回放必须逐字相同）。 */
  sessionId: 's-snapshot-plan',
  /** 确定性时钟（epoch ms）：起点取一个固定整数，绝不读真实时间。 */
  clock: { start: 1_700_000_000_000, step: 1 },
  /** seeded 随机种子（bank-forge 同源；demo 档数据由它决定）。 */
  randomSeed: 7,
  /**
   * 本场景真实驱动的治理平面（门禁 `snapshot-fresh` 的归属依据）。
   *
   * 只列**只有本场景能证明**的两条：`plan/` 引擎本体与 runtime 的 barrel
   * （`runtime/src/index.ts` 新增了 `export * from './plan/index.ts'`）。
   * 其余被这条计划走到的面（tools / session / host 装配 / bank / approval / persistence）
   * 已由 `headless-basic` 覆盖，重复声明只会让将来每次改动都要多录一份。
   */
  coveredSources: ['packages/runtime/src/plan/', 'packages/runtime/src/index.ts'],
} as const

/** 固定计划：查余额 → 试算 → 扣款（3 节点，1 次审批）。 */
const PLAN: Plan = {
  planId: 'snapshot-plan-basic',
  meta: { title: '快照：查余额 → 试算 → 扣款' },
  nodes: [
    { id: 'balance', tool: 'account_balance', args: {}, deps: [] },
    {
      id: 'preview',
      tool: 'transfer_preview',
      args: { amount: 800, payee: { name: '王建国', phone: '13900002222' }, remark: '房租' },
      deps: ['balance'],
    },
    {
      id: 'pay',
      tool: 'transfer_create',
      args: { amount: 800, payee: { name: '王建国', phone: '13900002222' }, remark: '房租' },
      deps: ['preview'],
    },
  ],
}

/** 本场景的 overlay（层 4）：只给录制夹具一个显式放行的审批应答者（ADR-0010 后 profile 是 `none`）。 */
const OVERLAY = join(REPO_ROOT, 'snapshots', CASE.name, 'overlay.yml')

/** 一个"不存在"的 home 目录：录制与回放都不读开发机上的 home patch。 */
function noHome(): string {
  return join(tmpdir(), 'bah-snapshot-no-home')
}

/** 快照面的票据 ID：按 `callId` 派生（生产仍随机；见 `ToolPipelineOptions.mintTicketId`）。 */
const snapshotTicketId = (callId: string): TicketId => `ticket:${callId}` as TicketId

/** 从生效行里取某行的配置（找不到就 fail-loud，别猜默认值）。 */
function settingsOf<T>(rows: SnapshotRow[], id: string): T {
  const row = rows.find((candidate) => candidate.id === id)
  if (row === undefined) throw new Error(`快照场景：生效行里没有 ${id}`)
  return row.config as T
}

/**
 * 录制：真实 `profiles/plan` + 真实依赖清单，跑一次固定计划。
 *
 * `exchanges` 恒为空数组：plan 不经过模型（这也是"无模型入口"这条限制的实证）。
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
  const scratch = mkdtempSync(join(tmpdir(), 'bah-plan-record-'))
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
    const summary = await app.ctx.get(PLAN_SERVICE).run(PLAN)
    if (summary.status !== 'succeeded') {
      throw new Error(`快照场景：计划本应全成功，实际 ${summary.status}（录制的计划必须稳定通过）`)
    }

    const events = app.ctx.get(SESSION_SERVICE).events()
    const provider = settingsOf<{ provider: string }>(rows, 'core:model').provider
    const loopModel = settingsOf<{ loop: { model: string } }>(rows, 'core:agent').loop.model
    const { model } = app.ctx.get(LLM_ADAPTERS).resolve(loopModel)

    return {
      meta: {
        name: CASE.name,
        profile: CASE.profile,
        // plan 不喂 prompt：这条场景证明的是"编排不经过模型"
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

/**
 * 回放：**只读快照**，用录制下来的行重建应用，再跑同一张计划。
 *
 * @returns 本次回放产生的事件流（与 `snapshot.events` 逐条比对）
 */
export async function runReplay(snapshot: LoadedSnapshot): Promise<readonly SessionEvent[]> {
  const clock = fixedClock(snapshot.meta.clock)
  const scratch = mkdtempSync(join(tmpdir(), 'bah-plan-replay-'))

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
    await app.ctx.get(PLAN_SERVICE).run(PLAN)
    return app.ctx.get(SESSION_SERVICE).events()
  } finally {
    await app.dispose('replay-finished')
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** 计划本体（负控：快照里不得出现 args 原文）。 */
export const SNAPSHOT_PLAN = PLAN
