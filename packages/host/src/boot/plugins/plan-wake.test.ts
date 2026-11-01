/**
 * 授权窗口（`plan_arm` / `plan_disarm` / `plan_wake`）的输入校验与到期唤醒。
 *
 * 为什么单独一组：这是"用户确认一次、到期自动花钱"的入口。
 * - 入参解析（dueAt / tier / 预算 / 周期 / 条件）每一条都是**封闭联合**，
 *   放进来一个未收窄的值，就等于给"任意时刻 / 任意金额"开门；
 * - 宽档（`tier:'wide'`）必须挡掉红级动作（挂失等）；
 * - 唤醒必须：未到期不跑、条件失守降级、预算超限降级、同一实例只跑一次、撤销后不跑。
 *
 * 装配沿用 `plan.test.ts` 的子集（真实 `HOST_PLUGINS` + 真实工具管线），
 * 只把 `plan:dag.modelTools` 打开——授权窗口的三件套只在模型入口开启时注册。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HALT_SERVICE } from '@bah/safety'
import { asSessionId, captureRejection } from '@bah/test-support'
import {
  PLAN_ARM_TOOL,
  PLAN_DISARM_TOOL,
  PLAN_WAKE_TOOL,
  SESSION_SERVICE,
  TOOLS_SERVICE,
  ToolGuard,
  ToolPipeline,
  type ArmedPlan,
  type ToolDefinition,
  type ToolExecContext,
} from '@bah/runtime'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BANK_COMPENSATION, MERCHANT_OFFERS } from '@bah/bank'

import type { BootedApp, BootOptions, ProfileSummary } from '../boot.ts'
import { boot, RUN_SERVICE } from '../boot.ts'
import { createCatalog, HOST_PLUGINS, type HostPluginLike } from './index.ts'
import { BANK_BALANCE_PROBE } from './bank-tools.ts'
import { MERCHANT_SERVICE, type MerchantService } from './merchant.ts'
import type { HostPlugin } from '../../plugin-manager/index.ts'
import { WINDOW_SIGNER } from './plan-grant.ts'
import {
  PLAN_ARMED_SERVICE,
  PLAN_SERVICE,
  PLAN_WAKE_SERVICE,
  parentBudgetAllows,
  planNoticeText,
  type PlanWakeReport,
} from './plan.ts'
import { testRunContext } from '../test-run-context.ts'

import type { Bundle, ConfigLayer, PluginRow } from '../profile-plugins.ts'

const NOW = 1_700_000_000_000
const PROFILE: ProfileSummary = { name: 'plan', bundles: ['base'], hmr: false }

/**
 * 审批夹具（ADR-0010）。
 *
 * - `window`：与 `profiles/plan/patch.yml` **逐字同义**（`responder: none` +
 *   `windowResponder: true`）——默认夹具，验的是"到期由窗口代签"；
 * - `auto`：只给"武装时要过一次红级挑战"的用例用（自动应答者会替人做那次强验证）。
 *   它是回归夹具，不是生产语义，所以只在个别用例里显式出现；
 * - `both`：`auto` + 窗口应答者同时在线。自动应答者**不认领窗口票据**
 *   （ADR-0010），所以"武装（人工票据）走 headless、到期（窗口票据）走窗口代签"
 *   可以在同一次 boot 里被证明——这也是生日三腿用例唯一可行的夹具。
 */
type ApprovalFixture = 'window' | 'auto' | 'both'

const BASE_ROWS_OF = (approval: ApprovalFixture): readonly PluginRow[] => [
  { id: 'core:session' },
  { id: 'core:tools' },
  { id: 'core:prompt' },
  { id: 'core:model', config: { provider: 'deepseek', model: 'deepseek-chat' } },
  { id: 'core:agent', config: { loop: { model: 'deepseek:deepseek-chat' } } },
  { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
  { id: 'audit:decisions' },
  { id: 'policy:rules' },
  { id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' } },
  approval === 'window'
    ? {
        id: 'interaction:approval',
        config: { responder: 'none', windowResponder: true },
      }
    : approval === 'auto'
      ? {
          id: 'interaction:approval',
          config: { responder: 'headless', autoDecision: 'allow', autoVerify: true },
        }
      : {
          id: 'interaction:approval',
          config: {
            responder: 'headless',
            autoDecision: 'allow',
            autoVerify: true,
            windowResponder: true,
          },
        },
  { id: 'safety:sentry', config: { trace: { sink: 'memory' } } },
  { id: 'bank:saga-store', config: { dbPath: ':memory:' } },
  { id: 'bank:saga' },
  { id: 'bank:saga-audit' },
  { id: 'bank:saga-bridge', config: { enabled: false } },
]

const overlay = (rows: readonly PluginRow[]): ConfigLayer => ({
  layer: 'overlay',
  from: 'plan-wake.test.ts',
  rows,
})

interface Booted {
  readonly app: BootedApp
  readonly cleanup: () => void
}

async function bootPlan(
  extraRows: readonly PluginRow[] = [],
  approval: ApprovalFixture = 'window',
  now: () => number = () => NOW,
  extraPlugins: readonly HostPluginLike[] = [],
  planConfig: Readonly<Record<string, unknown>> = { modelTools: true },
): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'bah-plan-wake-'))
  const bundle: Bundle = { name: 'base', rows: BASE_ROWS_OF(approval) }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [
      overlay([
        { id: 'plan:dag', use: 'plan:dag', config: planConfig },
        ...extraRows,
      ]),
    ],
    catalog: extraPlugins.length === 0 ? createCatalog() : createCatalog([...HOST_PLUGINS, ...extraPlugins]),
    run: testRunContext({ sessionId: asSessionId('s-plan-wake'), now, jsonlDir: dir }),
  }
  return { app: await boot(options), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 额外装一个插件跑一个用例（不共用全局 booted，避免行集合互相污染）。 */
async function withExtraPlan(
  extraRows: readonly PluginRow[],
  run: (app: BootedApp) => Promise<void>,
  approval: ApprovalFixture = 'window',
): Promise<void> {
  const extra = await bootPlan(extraRows, approval)
  try {
    await run(extra.app)
  } finally {
    await extra.app.dispose('test-done')
    extra.cleanup()
  }
}

const execCtx = (callId: string): ToolExecContext => ({
  sessionId: asSessionId('s-plan-wake'),
  callId,
  signal: new AbortController().signal,
})

/** 一个只读节点：唤醒成功时不会触发任何审批。 */
const readNodes = [{ id: 'bal', tool: 'account_balance', args: {}, deps: [] }]

/** 一次转账节点组：用于预算硬校验（staticSpendCents 只数 transfer_create）。 */
const payNodes = [
  { id: 'preview', tool: 'transfer_preview', args: { amount: 100, payee: { name: '王建国', phone: '13900002222' } }, deps: [] },
  {
    id: 'pay',
    tool: 'transfer_create',
    args: { amount: 100, payee: { name: '王建国', phone: '13900002222' } },
    deps: ['preview'],
  },
]

function armArgs(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    title: '查余额',
    planId: 'p-arm',
    nodes: readNodes,
    budgetYuan: 100,
    dueAt: new Date(NOW - 1_000).toISOString(),
    ...overrides,
  }
}

let booted: Booted | undefined

beforeEach(async () => {
  booted = await bootPlan()
})

afterEach(async () => {
  if (booted !== undefined) {
    await booted.app.dispose('test-done')
    booted.cleanup()
    booted = undefined
  }
})

function toolOf(name: string): ToolDefinition<Readonly<Record<string, unknown>>, unknown> {
  if (booted === undefined) throw new Error('booted 未初始化')
  return booted.app.ctx.get(TOOLS_SERVICE).get(name) as ToolDefinition<
    Readonly<Record<string, unknown>>,
    unknown
  >
}

async function arm(
  args: Readonly<Record<string, unknown>>,
  callId = 'call-arm-1',
): Promise<Record<string, unknown>> {
  return (await toolOf(PLAN_ARM_TOOL).execute(args, execCtx(callId))) as Record<string, unknown>
}

async function invalidCode(
  args: Readonly<Record<string, unknown>>,
  callId = 'call-arm-bad',
): Promise<string> {
  const error = await captureRejection(() => toolOf(PLAN_ARM_TOOL).execute(args, execCtx(callId)))
  return error.code
}

/** 一次管线执行的结果（只需要几个字段）。 */
interface PipelineOutcome {
  readonly isError: boolean
  readonly code?: string
  readonly reason?: string
  readonly value?: unknown
}

/**
 * 走**真实七段管线**武装（`tool/call` → ask → 审批 → 挑战 → 执行）。
 *
 * 与 `arm()`（直接调 `execute`）的区别：这条路径会签票据、过审批、做红级挑战，
 * 也就是模型/Web 实际走的形状。`plan_arm` 的**预授权凭据**只有在这条路径上才存在
 * （`preauthOf` 读 `approval/challenge-issued` + `VerifyService.passed`）。
 */
async function armViaPipeline(
  app: BootedApp,
  name: string,
  args: Readonly<Record<string, unknown>>,
  callId: string,
): Promise<PipelineOutcome> {
  const session = app.ctx.get(SESSION_SERVICE)
  // 时钟取 `bah:run`（可跳转）：票据 `expiresAt` 必须与场景时钟同一时间轴，
  // 否则"武装时刻 + TTL"和"唤醒时刻"会落在两个时代，票据先过期。
  const run = app.ctx.get(RUN_SERVICE)
  const pipeline = new ToolPipeline({
    ctx: app.ctx,
    registry: app.ctx.get(TOOLS_SERVICE),
    session,
    guard: new ToolGuard(),
    sessionId: session.sessionId,
    now: run.now,
  })
  const execution = await pipeline.execute({ callId, name, args })
  return {
    isError: execution.result.isError,
    ...(execution.result.code === undefined ? {} : { code: execution.result.code }),
    ...(execution.result.reason === undefined ? {} : { reason: execution.result.reason }),
    ...(execution.value === undefined ? {} : { value: execution.value }),
  }
}

/** 扁平事件视图（只读 `type` 与 `data`）。 */
interface FlatEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

const eventsOf = (app: BootedApp): readonly FlatEvent[] =>
  app.ctx
    .get(SESSION_SERVICE)
    .events()
    .map((event) => ({ type: String(event.type), data: event.data as unknown as Record<string, unknown> }))

describe('plan_arm 输入校验', () => {
  it('合法入参：windowId 由 callId 派生，预算元转分，tier 缺省 standard', async () => {
    const armed = await arm(armArgs(), 'call-arm-ok')
    expect(armed).toMatchObject({
      planId: 'p-arm',
      windowId: 'w-call-arm-ok',
      tier: 'standard',
      budgetCents: 10_000,
      state: 'armed',
      dueAt: NOW - 1_000,
      conditions: [],
      recurrence: { every: 'once', dueAt: NOW - 1_000 },
    })
    expect(booted?.app.ctx.get(PLAN_ARMED_SERVICE).list()).toHaveLength(1)
  })

  it('dueAt / expiresAt 必须是 ISO 时间', async () => {
    expect(await invalidCode(armArgs({ dueAt: '' }))).toBe('plan-arm-invalid')
    expect(await invalidCode(armArgs({ dueAt: 'tomorrow' }))).toBe('plan-arm-invalid')
    expect(await invalidCode(armArgs({ dueAt: 123 }))).toBe('plan-arm-invalid')
    expect(await invalidCode(armArgs({ expiresAt: 'soon' }))).toBe('plan-arm-invalid')
  })

  it('tier 是封闭联合；宽档必须给 expiresAt（否则等于"永久免验证"）', async () => {
    expect(await invalidCode(armArgs({ tier: 'max' }))).toBe('plan-arm-invalid')
    expect((await arm(armArgs({ tier: 'strict' }), 'call-tier-strict')).tier).toBe('strict')
    expect(await invalidCode(armArgs({ tier: 'wide' }), 'call-tier-wide')).toBe('plan-arm-invalid')
    expect(
      await invalidCode(
        armArgs({ tier: 'wide', expiresAt: new Date(NOW + 60_000).toISOString() }),
        'call-tier-wide-2',
      ),
    ).toBe('plan-arm-unverified')
  })

  it('预算必须是正数（元→分）', async () => {
    expect(await invalidCode(armArgs({ budgetYuan: 0 }))).toBe('plan-arm-invalid')
    expect(await invalidCode(armArgs({ budgetYuan: -5 }))).toBe('plan-arm-invalid')
    expect(await invalidCode(armArgs({ budgetYuan: '100' }))).toBe('plan-arm-invalid')
    expect((await arm(armArgs({ budgetYuan: 12.5 }), 'call-budget')).budgetCents).toBe(1_250)
  })

  it('周期规则逐项收窄', async () => {
    expect(await invalidCode(armArgs({ recurrence: 'daily' }))).toBe('plan-arm-invalid')
    expect(await invalidCode(armArgs({ recurrence: { every: 'weekly', at: '09:00' } }))).toBe(
      'plan-arm-invalid',
    )
    expect(await invalidCode(armArgs({ recurrence: { every: 'daily' } }))).toBe('plan-arm-invalid')
    expect(await invalidCode(armArgs({ recurrence: { every: 'monthly', day: 32, at: '09:00' } }))).toBe(
      'plan-arm-invalid',
    )
    expect(await invalidCode(armArgs({ recurrence: { every: 'monthly', at: '09:00' } }))).toBe(
      'plan-arm-invalid',
    )
    expect(await invalidCode(armArgs({ recurrence: { every: 'yearly', day: 1, at: '09:00' } }))).toBe(
      'plan-arm-invalid',
    )
    expect(
      await invalidCode(armArgs({ recurrence: { every: 'yearly', month: 13, day: 1, at: '09:00' } })),
    ).toBe('plan-arm-invalid')
    expect(await invalidCode(armArgs({ recurrence: { every: 'yearly', month: 1, at: '09:00' } }))).toBe(
      'plan-arm-invalid',
    )
    expect(
      (await arm(armArgs({ recurrence: { every: 'monthly', day: 31, at: '09:00' } }), 'call-monthly'))
        .recurrence,
    ).toEqual({ every: 'monthly', day: 31, at: '09:00' })
    expect((await arm(armArgs({ recurrence: { every: 'once' } }), 'call-once')).recurrence).toEqual({
      every: 'once',
      dueAt: NOW - 1_000,
    })
  })

  it('条件种类是封闭联合，数值项必须是非负整数', async () => {
    const bad: readonly Readonly<Record<string, unknown>>[] = [
      { conditions: 'x' },
      { conditions: [null] },
      { conditions: [{ kind: 'nope' }] },
      { conditions: [{ kind: 'balance-at-least', cents: 1.5 }] },
      { conditions: [{ kind: 'balance-at-least', cents: -1 }] },
      { conditions: [{ kind: 'fact-unchanged', factId: 'f' }] },
      { conditions: [{ kind: 'plan-not-cancelled' }] },
      { conditions: [{ kind: 'amount-within', cents: '900' }] },
      { conditions: [{ kind: 'address-unchanged', addressId: 'a' }] },
    ]
    for (const [index, patch] of bad.entries()) {
      expect(await invalidCode(armArgs(patch), `call-cond-bad-${String(index)}`)).toBe(
        'plan-arm-invalid',
      )
    }

    const good = await arm(
      armArgs({
        conditions: [
          { kind: 'balance-at-least', cents: 0 },
          { kind: 'fact-unchanged', factId: 'f-1', version: 2 },
          { kind: 'plan-not-cancelled', planId: 'p-other' },
          { kind: 'amount-within', cents: 10_000 },
          { kind: 'address-unchanged', addressId: 'addr-1', version: 1 },
        ],
      }),
      'call-cond-good',
    )
    expect(good.conditions).toHaveLength(5)
  })

  it('含红级动作：标准档同样要预授权（红级不再能"混进标准档"）', async () => {
    const redNodes = [{ id: 'lost', tool: 'card_report_lost', args: {}, deps: [] }]
    // 没有有效期 → 直接拒（宽档与含红级节点走同一条闸）
    expect(await invalidCode(armArgs({ tier: 'standard', nodes: redNodes }), 'call-red-standard')).toBe(
      'plan-arm-invalid',
    )
    // 有有效期但没有强验证凭据 → 拒
    expect(
      await invalidCode(
        armArgs({
          tier: 'standard',
          nodes: redNodes,
          expiresAt: new Date(NOW + 60_000).toISOString(),
        }),
        'call-red-standard-2',
      ),
    ).toBe('plan-arm-unverified')
  })

  it('同 windowId 重复武装被拒（窗口是身份，不是缓存键）', async () => {
    await arm(armArgs(), 'call-dup')
    const error = await captureRejection(() =>
      toolOf(PLAN_ARM_TOOL).execute(armArgs(), execCtx('call-dup')),
    )
    expect(error.code).toBe('window-duplicate')
  })

  it('plan_arm 走人工审批（ask），票据绑定参数指纹', async () => {
    if (booted === undefined) throw new Error('booted 未初始化')
    const out = await booted.app.ctx.events.waterfall('tools/pre-execute', {
      call: { callId: 'call-ask', name: PLAN_ARM_TOOL, args: armArgs() },
      verdict: { kind: 'allow' },
    })
    expect(out.verdict.kind).toBe('ask')
  })
})

describe('plan_disarm', () => {
  it('windowId 必填且必须存在', async () => {
    const empty = await captureRejection(() =>
      toolOf(PLAN_DISARM_TOOL).execute({}, execCtx('call-disarm-empty')),
    )
    expect(empty.code).toBe('plan-arm-invalid')
    const unknown = await captureRejection(() =>
      toolOf(PLAN_DISARM_TOOL).execute({ windowId: 'w-nope' }, execCtx('call-disarm-unknown')),
    )
    expect(unknown.code).toBe('window-unknown')
  })

  it('撤销后状态是 cancelled，重复撤销幂等', async () => {
    await arm(armArgs(), 'call-disarm-ok')
    const first = (await toolOf(PLAN_DISARM_TOOL).execute(
      { windowId: 'w-call-disarm-ok' },
      execCtx('call-disarm-1'),
    )) as Record<string, unknown>
    expect(first).toEqual({ windowId: 'w-call-disarm-ok', planId: 'p-arm', state: 'cancelled' })

    const second = (await toolOf(PLAN_DISARM_TOOL).execute(
      { windowId: 'w-call-disarm-ok' },
      execCtx('call-disarm-2'),
    )) as Record<string, unknown>
    expect(second.state).toBe('cancelled')
  })

  it('撤销后不再被唤醒', async () => {
    await arm(armArgs(), 'call-disarm-wake')
    await toolOf(PLAN_DISARM_TOOL).execute(
      { windowId: 'w-call-disarm-wake' },
      execCtx('call-disarm-wake-2'),
    )
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({})
    expect(report?.entries).toEqual([])
  })
})

describe('plan_wake 到期唤醒', () => {
  it('未到期不动；到期后执行一次，再唤醒按实例幂等跳过', async () => {
    await arm(armArgs({ planId: 'p-once' }), 'call-wake-once')
    const wake = booted?.app.ctx.get(PLAN_WAKE_SERVICE)
    if (wake === undefined) throw new Error('missing wake')

    const future = await wake.wake({ at: NOW - 10_000, planId: 'p-once' })
    expect(future.entries).toEqual([])

    const first = await wake.wake({ planId: 'p-once' })
    expect(first.ok).toBe(true)
    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]).toMatchObject({ planId: 'p-once', status: 'executed' })
    expect(first.entries[0]?.summary).toMatchObject({ succeeded: 1, failed: 0 })

    const events = booted?.app.ctx.get(SESSION_SERVICE).events() ?? []
    expect(events.some((event) => String(event.type) === 'plan/created')).toBe(true)

    const second = await wake.wake({ planId: 'p-once' })
    expect(second.entries[0]).toMatchObject({ status: 'skipped', reason: 'already-ran' })
  })

  it('dryRun 只判定不执行', async () => {
    await arm(armArgs({ planId: 'p-dry' }), 'call-wake-dry')
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({ dryRun: true, planId: 'p-dry' })
    expect(report?.entries[0]).toMatchObject({ status: 'skipped', reason: 'dry-run' })
    const events = booted?.app.ctx.get(SESSION_SERVICE).events() ?? []
    expect(events.some((event) => String(event.type) === 'plan/created')).toBe(false)
  })

  it('条件失守 → 降级为人工确认，不执行并产出一条 alert 建议', async () => {
    await arm(
      armArgs({
        planId: 'p-window-fail',
        conditions: [{ kind: 'balance-at-least', cents: 999_999_999 }],
      }),
      'call-wake-fail',
    )
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: 'p-window-fail' })
    expect(report?.entries[0]).toMatchObject({ status: 'downgraded', code: 'condition-failed' })
    expect(report?.entries[0]?.failed?.[0]?.kind).toBe('balance-at-least')
    expect(report?.notified).toHaveLength(1)
    const events = booted?.app.ctx.get(SESSION_SERVICE).events() ?? []
    expect(events.some((event) => String(event.type) === 'plan/created')).toBe(false)
  })

  it('预算硬校验：计划静态金额超预算 → 降级，不执行转账', async () => {
    await arm(
      armArgs({ planId: 'p-over-budget', nodes: payNodes, budgetYuan: 50 }),
      'call-wake-budget',
    )
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: 'p-over-budget' })
    expect(report?.entries[0]).toMatchObject({ status: 'downgraded', code: 'condition-failed' })
    expect(report?.entries[0]?.failed?.[0]).toMatchObject({
      kind: 'amount-within',
      actual: '10000',
    })
    const calls = (booted?.app.ctx.get(SESSION_SERVICE).events() ?? []).filter(
      (event) => event.type === 'tool/call',
    )
    expect(calls).toEqual([])
  })

  it('planId 过滤：一次唤醒只跑指定实例', async () => {
    await arm(armArgs({ planId: 'p-a' }), 'call-wake-a')
    await arm(armArgs({ planId: 'p-b' }), 'call-wake-b')
    const wake = booted?.app.ctx.get(PLAN_WAKE_SERVICE)
    if (wake === undefined) throw new Error('missing wake')
    const onlyA = await wake.wake({ planId: 'p-a' })
    expect(onlyA.entries.map((entry) => entry.planId)).toEqual(['p-a'])
    expect(onlyA.entries[0]?.status).toBe('executed')
    // 第二次批量唤醒：p-a 已跑过按实例跳过，p-b 才执行
    const rest = await wake.wake({})
    expect(rest.entries.map((entry) => [entry.planId, entry.status])).toEqual([
      ['p-a', 'skipped'],
      ['p-b', 'executed'],
    ])
  })

  it('判定时刻越界（未来超过 skew）直接拒绝，一条都不跑', async () => {
    await arm(armArgs({ planId: 'p-skew' }), 'call-wake-skew')
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({
      at: NOW + 10 * 60 * 1000,
    })
    expect(report).toMatchObject({ ok: false, code: 'window-clock-ahead', entries: [] })
  })

  it('错过宽限的窗口：不执行，但如实报 failed(window-expired) 并发一条回执', async () => {
    await arm(
      armArgs({
        planId: 'p-expired',
        expiresAt: new Date(NOW - 500).toISOString(),
      }),
      'call-wake-expired',
    )
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({})
    expect(report?.entries).toHaveLength(1)
    expect(report?.entries[0]).toMatchObject({
      planId: 'p-expired',
      status: 'failed',
      code: 'window-expired',
    })
    expect(report?.notified[0]?.send).toBe(true)
    expect(report?.notified[0]?.text).toContain('已过期未执行')
    // 过期即终止：一次都不可执行、不补扣
    expect(
      (booted?.app.ctx.get(SESSION_SERVICE).events() ?? []).some(
        (event) => String(event.type) === 'plan/created',
      ),
    ).toBe(false)
  })

  it('HALT 期间唤醒：返回 aborted，一个字都不执行', async () => {
    await arm(armArgs({ planId: 'p-halt' }), 'call-halt')
    const halt = booted?.app.ctx.get(HALT_SERVICE)
    expect(halt?.halted).toBe(false)
    halt?.halt('manual')
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: 'p-halt' })
    expect(report?.entries[0]).toMatchObject({ status: 'executed', summary: { status: 'aborted' } })
    const events = booted?.app.ctx.get(SESSION_SERVICE).events() ?? []
    expect(events.some((event) => String(event.type) === 'plan/aborted')).toBe(true)
    expect(events.some((event) => event.type === 'tool/call')).toBe(false)

    // resume 与 run 共用同一条 HALT 拦截（停机期间不能靠续跑绕过）
    const resumed = await booted?.app.ctx.get(PLAN_SERVICE).resume({
      planId: 'p-halt',
      nodes: readNodes.map((node) => ({ ...node, deps: [] })),
    } as never)
    expect(resumed?.status).toBe('aborted')
  })

  it('商户腿：没有 bank:merchant 时回执 merchant-service-missing（失败不静默）', async () => {
    await arm(
      armArgs({ planId: 'p-merchant-missing', merchantOfferId: 'o-flower-a2' }),
      'call-merchant-missing',
    )
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: 'p-merchant-missing' })
    expect(report?.entries[0]?.merchant).toMatchObject({
      status: 'failed',
      attempts: [{ offerId: 'o-flower-a2', ok: false, code: 'merchant-service-missing' }],
    })
    expect(report?.notified).toHaveLength(1)
  })

  it('商户腿：银行腿成功后串行履约（offerId 来自本会话搜索闭包）', async () => {
    await withExtraPlan([{ id: 'bank:merchant', use: 'bank:merchant' }], async (app) => {
      const tools = app.ctx.get(TOOLS_SERVICE)
      await tools.get('merchant_search').execute({ category: 'flower' }, execCtx('call-msearch'))
      await tools.get(PLAN_ARM_TOOL).execute(
        armArgs({ planId: 'p-merchant-ok', budgetYuan: 200, merchantOfferId: 'o-flower-a2' }),
        execCtx('call-merchant-ok'),
      )
      const report = await app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: 'p-merchant-ok' })
      expect(report.entries[0]).toMatchObject({
        status: 'executed',
        merchant: { status: 'ok', order: { offerId: 'o-flower-a2', totalCents: 15_900 } },
      })
    })
  })

  it('plan_wake 工具是 internal，且 source 标 tool、参数透传', async () => {
    await arm(armArgs({ planId: 'p-tool' }), 'call-wake-tool')
    const tool = toolOf(PLAN_WAKE_TOOL)
    expect(tool.exposure).toBe('internal')
    const report = (await tool.execute({ planId: 'p-tool' }, execCtx('call-wake-tool-2'))) as PlanWakeReport
    expect(report.source).toBe('tool')
    expect(report.entries[0]).toMatchObject({ planId: 'p-tool', status: 'executed' })
    // at 解析与 plan_arm 同一口径
    await expect(tool.execute({ at: 'soon' }, execCtx('call-wake-bad-at'))).rejects.toMatchObject({
      code: 'plan-arm-invalid',
    })
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 提示词 4-2：到期语义（用户可见回执 + 到期前提醒）
 *
 * 三条要证明的事：
 * 1. 三类失守各有一句**只从 durable 字段**渲染的回执；认不出的码不编文案；
 * 2. 同一窗口的同一种失守只提醒一次（进程内账本，超出 deriveNotify 的 5 分钟去重窗口）；
 * 3. 到期前 24h 发一条 `exec` 提醒：**只提醒不执行**，同一实例只提醒一次。
 * ──────────────────────────────────────────────────────────────────────────── */

describe('到期回执（提示词 4-2）', () => {
  it('三类码各有文案；其它码返回 undefined（不编"已转人工"）', () => {
    const at = Date.UTC(2026, 9, 31, 9)
    expect(
      planNoticeText({ code: 'window-expired', title: '定时转账', dueAt: at, expiresAt: at + 1000 }),
    ).toBe(`计划《定时转账》已过期未执行（有效期至 ${new Date(at + 1000).toISOString()}），未扣款`)
    expect(planNoticeText({ code: 'details-changed', title: '生日计划', dueAt: at })).toBe(
      '计划《生日计划》的明细与批准时不一致（摘要变化），已转人工确认，未扣款',
    )
    expect(
      planNoticeText({
        code: 'condition-failed',
        title: '定时转账',
        dueAt: at,
        failed: [{ kind: 'balance-at-least', expected: '>= 100000', actual: '60000' }],
      }),
    ).toBe('计划《定时转账》的条件不满足（balance-at-least 期望 >= 100000，实际 60000），本次未执行')
    expect(planNoticeText({ code: 'unknown-code', title: 'x', dueAt: at })).toBeUndefined()
    expect(planNoticeText({ code: undefined, title: 'x', dueAt: at })).toBeUndefined()
  })

  it('条件失守：回执随 notified 一起发出，且判决仍是降级（回执不改变判决）', async () => {
    await arm(
      armArgs({
        planId: 'p-notice',
        conditions: [{ kind: 'balance-at-least', cents: 999_999_999 }],
      }),
      'call-notice',
    )
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: 'p-notice' })
    expect(report?.entries[0]).toMatchObject({ status: 'downgraded', code: 'condition-failed' })
    expect(report?.notified).toHaveLength(1)
    expect(report?.notified[0]?.send).toBe(true)
    expect(report?.notified[0]?.text).toContain('条件不满足')
    expect(report?.notified[0]?.text).toContain('本次未执行')
  })

  it('同一窗口的同一种失守只提醒一次（时钟越过 5 分钟去重窗口后仍不重复）', async () => {
    let clockNow = NOW
    const extra = await bootPlan([], 'window', () => clockNow)
    try {
      await extra.app.ctx
        .get(TOOLS_SERVICE)
        .get(PLAN_ARM_TOOL)
        .execute(
          armArgs({
            planId: 'p-dedup',
            conditions: [{ kind: 'balance-at-least', cents: 999_999_999 }],
          }),
          execCtx('call-dedup'),
        )
      const wake = extra.app.ctx.get(PLAN_WAKE_SERVICE)
      const first = await wake.wake({ planId: 'p-dedup' })
      expect(first.notified).toHaveLength(1)

      clockNow += 6 * 60 * 1000 // 越过 DEFAULT_NOTIFY_BUDGET 的 5 分钟窗口
      const second = await wake.wake({ planId: 'p-dedup', at: clockNow })
      expect(second.entries[0]?.status).toBe('downgraded')
      expect(second.notified).toHaveLength(0)
    } finally {
      await extra.app.dispose('test-done')
      extra.cleanup()
    }
  })

  it('到期前 24h 提醒：只提醒不执行；同一实例只提醒一次', async () => {
    // 提醒是 `exec` 档：会被静默时段拦。取 UTC+8 10:00 的时钟，证明"能发"而不是"被静默"
    const noon = Date.UTC(2023, 10, 15, 2, 0)
    const extra = await bootPlan([], 'window', () => noon)
    try {
      await extra.app.ctx
        .get(TOOLS_SERVICE)
        .get(PLAN_ARM_TOOL)
        .execute(
          armArgs({ planId: 'p-soon', dueAt: new Date(noon + 60 * 60 * 1000).toISOString() }),
          execCtx('call-soon'),
        )
      const wake = extra.app.ctx.get(PLAN_WAKE_SERVICE)
      const report = await wake.wake({})
      // 未到期：一条都不执行
      expect(report.entries).toEqual([])
      const notices = report.notified.filter((item) => item.text?.includes('到期执行') === true)
      expect(notices).toHaveLength(1)
      expect(notices[0]?.send).toBe(true)
      expect(notices[0]?.text).toContain('如需修改请重新授权')

      const again = await wake.wake({})
      expect(again.notified.filter((item) => item.text?.includes('到期执行') === true)).toHaveLength(0)
      // 提醒不等于执行：事件里没有 plan/created
      expect(
        extra.app.ctx
          .get(SESSION_SERVICE)
          .events()
          .some((event) => String(event.type) === 'plan/created'),
      ).toBe(false)
    } finally {
      await extra.app.dispose('test-done')
      extra.cleanup()
    }
  })

  it('dueSoonLeadMs = 0 关闭到期前提醒', async () => {
    const noon = Date.UTC(2023, 10, 15, 2, 0)
    const extra = await bootPlan([], 'window', () => noon, [], {
      modelTools: true,
      dueSoonLeadMs: 0,
    })
    try {
      await extra.app.ctx
        .get(TOOLS_SERVICE)
        .get(PLAN_ARM_TOOL)
        .execute(
          armArgs({ planId: 'p-soon-off', dueAt: new Date(noon + 60 * 60 * 1000).toISOString() }),
          execCtx('call-soon-off'),
        )
      const report = await extra.app.ctx.get(PLAN_WAKE_SERVICE).wake({})
      expect(report.notified).toHaveLength(0)
    } finally {
      await extra.app.dispose('test-done')
      extra.cleanup()
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * ADR-0013：生日计划原子性与补偿
 *
 * 四条要证明的事：
 * 1. 父预算守卫的边界（等号通过、超 1 分拒）；
 * 2. 三张子窗口共享 parentPlanId / legKind / parentBudgetCents；
 * 3. 涨价不自动支付：预占价 ≠ 用户批准价 ⇒ skipped(price-changed)、不扣款；
 * 4. 扣款后商户没成交（commit 抛错）⇒ 银行腿冲正、余额回到原值、entry 带 compensation。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 提交必抛错的商户服务（只用于证明"commit 失败也要冲正"）。 */
const throwingMerchantPlugin: HostPlugin<Readonly<Record<string, never>>> = {
  id: 'test:merchant-throws',
  plugin: {
    name: 'test:merchant-throws',
    inject: [],
    apply(ctx) {
      const service: MerchantService = {
        search: () => [],
        offer: (offerId) => ({
          offerId,
          merchantId: 'm-test',
          merchantName: '测试商户',
          name: '测试商品',
          category: 'flower',
          priceCents: 1_000,
          etaMinutes: 10,
          stock: 5,
        }),
        orderable: () => true,
        fulfil: () => ({ status: 'failed', attempts: [] }),
        reserve: (_sessionKey, offerId) => ({
          ok: true,
          attempts: [{ offerId, ok: true }],
          reservation: {
            orderId: 'mo-test-1',
            offerId,
            merchantId: 'm-test',
            merchantName: '测试商户',
            totalCents: 1_000,
            etaMinutes: 10,
          },
        }),
        commit: () => {
          throw new Error('mock commit failed')
        },
        release: () => undefined,
        fault: () => 'none',
      }
      ctx.effect(ctx.provide(MERCHANT_SERVICE, service))
    },
  },
  validate: () => ({}),
}

describe('生日计划原子性与补偿（ADR-0013）', () => {
  it('父预算守卫：等号通过、超 1 分拒（纯函数边界）', () => {
    expect(parentBudgetAllows(1_200, 1_100, 100)).toBe(true)
    expect(parentBudgetAllows(1_200, 1_100, 101)).toBe(false)
    expect(parentBudgetAllows(1_200, 0, 1_200)).toBe(true)
    expect(parentBudgetAllows(1_200, 0, 1_201)).toBe(false)
  })

  it('三腿共享 parentPlanId / legKind / parentBudgetCents', async () => {
    const app = await bootPlan([{ id: 'bank:merchant', use: 'bank:merchant' }], 'both')
    try {
      const outcome = await armViaPipeline(
        app.app,
        'birthday_plan',
        { birthday: '下个月8号', lockYuan: 10, flowerYuan: 1, cakeYuan: 1 },
        'call-parent',
      )
      expect(outcome.isError).toBe(false)
      const list = app.app.ctx.get(PLAN_ARMED_SERVICE).list()
      expect(list).toHaveLength(3)
      expect(new Set(list.map((item) => item.parentPlanId)).size).toBe(1)
      expect(list.map((item) => item.legKind)).toEqual(['lock', 'flower', 'cake'])
      const parent = list[0]?.parentBudgetCents
      expect(typeof parent).toBe('number')
      expect(list.every((item) => item.parentBudgetCents === parent)).toBe(true)
    } finally {
      await app.app.dispose('test-done')
      app.cleanup()
    }
  })

  it('涨价（预占价 ≠ 用户批准价）⇒ skipped(price-changed)、不扣款、无补偿', async () => {
    let current = NOW
    const app = await bootPlan([{ id: 'bank:merchant', use: 'bank:merchant' }], 'both', () => current)
    const flower = MERCHANT_OFFERS.find((offer) => offer.offerId === 'o-flower-c2')
    if (flower === undefined) throw new Error('测试种子缺 o-flower-c2')
    const approved = flower.priceCents
    try {
      const outcome = await armViaPipeline(
        app.app,
        'birthday_plan',
        { birthday: '下个月8号', lockYuan: 10, flowerYuan: 200, cakeYuan: 200 },
        'call-price-skip',
      )
      expect(outcome.isError).toBe(false)
      const out = outcome.value as {
        dueAt: number
        schedules: readonly { kind: string; planId: string }[]
      }
      const flowerPlanId = out.schedules.find((item) => item.kind === 'flower')?.planId
      if (flowerPlanId === undefined) throw new Error('缺鲜花腿')
      // 唤醒前抬价 1 元：用户批准的是旧价
      ;(flower as { priceCents: number }).priceCents = approved + 100
      current = out.dueAt
      const report = await app.app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: flowerPlanId })
      const entry = report.entries[0]
      expect(entry).toMatchObject({ status: 'skipped', reason: 'price-changed' })
      expect(entry?.merchant?.price).toEqual({
        approvedCents: approved,
        currentCents: approved + 100,
      })
      expect(entry?.compensation).toBeUndefined()
      expect(eventsOf(app.app).some((event) => event.type === 'transfer/created')).toBe(false)
    } finally {
      ;(flower as { priceCents: number }).priceCents = approved
      await app.app.dispose('test-done')
      app.cleanup()
    }
  })

  it('缺货：预占失败 ⇒ 不扣款、entry failed(out-of-stock)、无补偿', async () => {
    const app = await bootPlan(
      [{ id: 'bank:merchant', use: 'bank:merchant', config: { fault: 'stockout' } }],
      'both',
    )
    try {
      const tools = app.app.ctx.get(TOOLS_SERVICE)
      await tools
        .get('merchant_search')
        .execute({ category: 'flower', budgetYuan: 200 }, execCtx('call-search-stockout'))
      const outcome = await armViaPipeline(
        app.app,
        'plan_arm',
        {
          title: '缺货用例',
          planId: 'p-stockout',
          nodes: payNodes,
          budgetYuan: 100,
          dueAt: new Date(NOW - 1_000).toISOString(),
          tier: 'wide',
          expiresAt: new Date(NOW + 60_000).toISOString(),
          merchantOfferId: 'o-flower-a2',
        },
        'call-stockout',
      )
      expect(outcome.isError).toBe(false)
      const report = await app.app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: 'p-stockout' })
      const entry = report.entries[0]
      expect(entry).toMatchObject({ status: 'failed', reason: 'out-of-stock' })
      expect(entry?.merchant?.attempts).toEqual([
        { offerId: 'o-flower-a2', ok: false, code: 'out-of-stock' },
      ])
      expect(entry?.compensation).toBeUndefined()
      expect(eventsOf(app.app).some((event) => event.type === 'transfer/created')).toBe(false)
    } finally {
      await app.app.dispose('test-done')
      app.cleanup()
    }
  })

  it('扣款后商户没成交（commit 抛错）⇒ 冲正银行腿：余额回原值、entry 记 reversed', async () => {
    const app = await bootPlan(
      [{ id: 'bank:merchant', use: 'test:merchant-throws' }],
      'both',
      () => NOW,
      [throwingMerchantPlugin],
    )
    try {
      const probe = app.app.ctx.get(BANK_BALANCE_PROBE)
      const before = await probe.availableCents('u-1')
      const outcome = await armViaPipeline(
        app.app,
        'plan_arm',
        {
          title: '补偿用例',
          planId: 'p-compensate',
          nodes: payNodes,
          budgetYuan: 100,
          dueAt: new Date(NOW - 1_000).toISOString(),
          tier: 'wide',
          expiresAt: new Date(NOW + 60_000).toISOString(),
          merchantOfferId: 'o-test',
        },
        'call-compensate',
      )
      expect(outcome.isError).toBe(false)

      const report = await app.app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: 'p-compensate' })
      const entry = report.entries[0]
      expect(entry).toMatchObject({ status: 'executed', merchant: { status: 'failed' } })
      expect(entry?.compensation?.kind).toBe('reversed')
      const txnId = entry?.compensation?.txnId
      expect(typeof txnId).toBe('string')
      const after = await probe.availableCents('u-1')
      expect(after).toBe(before)
      if (txnId !== undefined) {
        expect(app.app.ctx.get(BANK_COMPENSATION).reversalOf(txnId)).toBeDefined()
      }
      const created = eventsOf(app.app).filter((event) => event.type === 'transfer/created')
      expect(created).toHaveLength(1)
    } finally {
      await app.app.dispose('test-done')
      app.cleanup()
    }
  })
})
/* ────────────────────────────────────────────────────────────────────────────
 * ADR-0010：窗口代签
 *
 * 四条要证明的事（缺一条，"无人值守自动扣款"就不成立）：
 * 1. 唤醒确实由窗口签的字：`ticket/approved.authorization.kind='window'`
 *    + `approval/decided.by='window-responder'`；
 * 2. 伪造 `authorization` 换不来代签：没有唤醒标记就直接拒；
 * 3. `strict` 档一次都不跑（降级在进引擎前）；
 * 4. 生日三腿能在**没有任何人工点击**的情况下跑完（凭据来自武装时那次强验证）。
 * ──────────────────────────────────────────────────────────────────────────── */
describe('窗口代签（ADR-0010）', () => {
  it('唤醒代签：票据带窗口授权，approval/decided.by = window-responder', async () => {
    await arm(armArgs({ planId: 'p-sign', nodes: payNodes, budgetYuan: 100 }), 'call-sign')
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: 'p-sign' })

    expect(report?.entries[0]).toMatchObject({
      status: 'executed',
      summary: { status: 'succeeded', succeeded: 2, failed: 0 },
    })

    const events = eventsOf(booted!.app)
    const approved = events.filter((event) => event.type === 'ticket/approved')
    expect(approved).toHaveLength(1)
    expect(approved[0]?.data['authorization']).toMatchObject({
      kind: 'window',
      ref: 'w-call-sign',
    })

    const decided = events.filter((event) => event.type === 'approval/decided')
    expect(decided).toHaveLength(1)
    expect(decided[0]?.data).toMatchObject({
      decision: 'allowed-once',
      by: 'window-responder',
    })
    // 窗口票据只由窗口代签者认领：headless 夹具根本没装，`headless-auto` 不可能出现
    expect(decided.some((event) => event.data['by'] === 'headless-auto')).toBe(false)
  })

  it('伪造窗口字段换不来代签：没有唤醒标记时核验端口直接拒', async () => {
    const signer = booted?.app.ctx.get(WINDOW_SIGNER)
    if (signer === undefined) throw new Error('missing signer')
    // 窗口是真的（先武装），但这次调用**不是**唤醒发起的 → 没有标记
    await arm(armArgs({ planId: 'p-forge' }), 'call-forge')
    const grant = await signer.sign({
      ticketId: 'ticket:forged',
      callId: 'call-forged',
      name: 'transfer_create',
      level: 'yellow',
      amountYuan: 1,
      authorization: { kind: 'window', ref: 'w-call-forge', digest: 'whatever' },
    })
    expect(grant).toMatchObject({ ok: false, code: 'no-wake-mark' })
  })

  it('strict 档：唤醒在进引擎前降级，一次都不跑、一分都不扣', async () => {
    await arm(
      armArgs({
        planId: 'p-strict',
        nodes: payNodes,
        budgetYuan: 100,
        tier: 'strict',
      }),
      'call-strict',
    )
    const report = await booted?.app.ctx.get(PLAN_WAKE_SERVICE).wake({ planId: 'p-strict' })
    expect(report?.entries[0]).toMatchObject({ status: 'downgraded', code: 'tier-not-allowed' })
    expect(report?.entries[0]?.summary).toBeUndefined()

    const events = eventsOf(booted!.app)
    expect(events.some((event) => event.type === 'tool/call')).toBe(false)
    expect(events.some((event) => event.type === 'transfer/created')).toBe(false)
    expect(events.some((event) => event.type === 'plan/created')).toBe(false)
  })

  it('无窗口授权的人工票据：无人点击时立即被拒（headless 兜底确实撤掉了）', async () => {
    const session = booted!.app.ctx.get(SESSION_SERVICE)
    const pipeline = new ToolPipeline({
      ctx: booted!.app.ctx,
      registry: booted!.app.ctx.get(TOOLS_SERVICE),
      session,
      guard: new ToolGuard(),
      sessionId: session.sessionId,
      now: () => NOW,
    })
    const execution = await pipeline.execute({
      callId: 'call-human-ticket',
      name: 'transfer_create',
      args: { amount: 800, payee: { name: '王建国', phone: '13900002222' }, remark: '房租' },
    })

    expect(execution.result).toMatchObject({
      isError: true,
      code: 'approval-unavailable',
      reason: 'approval-no-responder',
    })
    const events = eventsOf(booted!.app)
    expect(events.some((event) => event.type === 'transfer/created')).toBe(false)
    // 窗口应答者不认领 ⇒ 没有进入仲裁，也没有任何"批准"
    expect(
      events.filter((event) => event.type === 'approval/decided' && event.data['decision'] === 'allowed-once'),
    ).toEqual([])
  })

  it('生日三腿：到期窗口代签跑完，全程无人工点击', async () => {
    /** 可跳转的注入钟（判定时刻必须能被推到到期日）。 */
    let current = NOW
    const jumpable = (): number => current
    const app = await bootPlan([{ id: 'bank:merchant', use: 'bank:merchant' }], 'both', jumpable)
    try {
      // ① 武装（父审批是红级 + 挑战；三张子窗口继承凭据）
      const outcome = await armViaPipeline(
        app.app,
        'birthday_plan',
        { birthday: '下个月8号', lockYuan: 10, flowerYuan: 1, cakeYuan: 1 },
        'call-birthday-wake',
      )
      expect(outcome).toMatchObject({ isError: false })
      const armedOut = outcome.value as { dueAt: number; schedules: readonly { kind: string }[] }
      expect(armedOut.schedules.map((item) => item.kind)).toEqual(['lock', 'flower', 'cake'])

      // ② 把时钟推到到期时刻，唤醒
      current = armedOut.dueAt
      const report = await app.app.ctx.get(PLAN_WAKE_SERVICE).wake({})
      expect(report.entries.map((entry) => entry.status)).toEqual([
        'executed',
        'executed',
        'executed',
      ])
      for (const entry of report.entries) {
        expect(entry.summary).toMatchObject({ status: 'succeeded', failed: 0 })
      }

      // ③ 三笔流水真实出现，三张票据都带窗口凭据
      const events = eventsOf(app.app)
      expect(events.filter((event) => event.type === 'transfer/created')).toHaveLength(3)
      const approved = events.filter((event) => event.type === 'ticket/approved')
      expect(approved).toHaveLength(3)
      for (const event of approved) {
        expect(event.data['authorization']).toMatchObject({ kind: 'window' })
      }
      const allowed = events
        .filter((event) => event.type === 'approval/decided')
        .filter((event) => event.data['decision'] === 'allowed-once')
      // 4 次批准：1 次是武装（夹具代点）+ 3 次是到期代签
      expect(allowed).toHaveLength(4)
      const signed = allowed.filter((event) => event.data['by'] === 'window-responder')
      expect(signed).toHaveLength(3)
      // 武装那一次**不是**窗口代签（它是人/夹具点的）：`by` 只在窗口票据上落账，
      // 所以这 1 条必须没有 `by`——这正是"人工票据不写签署人"的断言。
      expect(allowed.filter((event) => event.data['by'] === undefined)).toHaveLength(1)
    } finally {
      await app.app.dispose('test-done')
      app.cleanup()
    }
  })
})
