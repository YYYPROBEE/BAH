/**
 * 授权窗口 + 到期唤醒的**端到端**集成（G1/G2）——对抗式审查后补上的"真链路"证据。
 *
 * 判据（全部来自真实 `HOST_PLUGINS` + 七段管线，不用桩）：
 * 1. `plan_arm` 经管线执行 → 落 `tool/result`，出参是**结构化 JSON**（可回放）；
 * 2. `wake` 执行到期的计划 → 每个节点的 `ticket/approved` 都带
 *    `authorization.kind='window'` 且 `ref` 是窗口 id（ADR-0008 的落点）；
 * 3. 同一实例再唤醒一次 ⇒ `skipped/already-ran`，`plan/created` 计数不变（幂等）；
 * 4. 判定时刻越界（at = now + 1h）⇒ `window-clock-ahead`，一条都不执行；
 * 5. 撤销后的窗口不再被唤醒（`plan-cancelled` 降级）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asSessionId } from '@bah/test-support'
import {
  SESSION_SERVICE,
  TOOLS_SERVICE,
  ToolGuard,
  ToolPipeline,
} from '@bah/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { boot, type BootOptions, type BootedApp, type ProfileSummary } from '../boot.ts'
import { createCatalog } from './index.ts'
import { MERCHANT_SERVICE } from './merchant.ts'
import { PLAN_WAKE_SERVICE } from './plan.ts'
import type { Bundle, ConfigLayer, PluginRow } from '../profile-plugins.ts'
import { testRunContext } from '../test-run-context.ts'

const PROFILE: ProfileSummary = { name: 'plan', bundles: ['base'], hmr: false }

const NOW = 1_000
const DUE_ISO = new Date(NOW).toISOString()

const ROWS: readonly PluginRow[] = [
  { id: 'core:session' },
  { id: 'core:tools' },
  { id: 'core:prompt' },
  { id: 'core:model', config: { provider: 'deepseek', model: 'deepseek-chat' } },
  { id: 'core:agent', config: { loop: { model: 'deepseek:deepseek-chat' } } },
  { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
  { id: 'audit:decisions' },
  { id: 'policy:rules' },
  { id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' } },
  {
    id: 'interaction:approval',
    // ADR-0010：两个应答者各管一类票据——
    // 武装（人工票据）由回归夹具代点，到期（窗口票据）由窗口代签者签。
    // headless 显式**不认领**窗口票据，所以这里能同时证明"代签真的走了窗口核验"。
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
  { id: 'fact:store', config: { enabled: true } },
  { id: 'bank:merchant', config: { enabled: true, fault: 'none' } },
  {
    id: 'plan:dag',
    config: {
      enabled: true,
      maxNodes: 16,
      maxEdges: 64,
      planTimeoutMs: 30_000,
      dryRunDefault: false,
      modelTools: true,
      modelMaxNodes: 8,
    },
  },
  // 调度器显式关掉：本用例手动调 wake，避免 boot 补跑抢先执行
  { id: 'plan:scheduler', config: { enabled: false } },
]

const PLAN_ARGS = {
  title: '生日采购',
  budgetYuan: 1000,
  dueAt: DUE_ISO,
  tier: 'standard',
  conditions: [{ kind: 'balance-at-least', cents: 1 }],
  nodes: [
    {
      id: 'pay',
      tool: 'transfer_create',
      args: { amount: 800, payee: { name: '王建国', phone: '13900002222' }, remark: '房租' },
      deps: [],
    },
  ],
}

interface Booted {
  readonly app: BootedApp
  readonly cleanup: () => void
}

async function bootHost(
  dir = mkdtempSync(join(tmpdir(), 'bah-authz-')),
  rows: readonly PluginRow[] = ROWS,
  restoreSession = false,
): Promise<Booted> {
  const ownDir = dir.startsWith(tmpdir())
  const bundle: Bundle = { name: 'base', rows }
  const layers: readonly ConfigLayer[] = []
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers,
    catalog: createCatalog(),
    run: testRunContext({
      sessionId: asSessionId('s-authz'),
      now: () => NOW,
      jsonlDir: dir,
      ...(restoreSession ? { restoreSession: true } : {}),
    }),
  }
  void ownDir
  return { app: await boot(options), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 通过管线执行一个工具（模拟模型调用；审批由 headless 应答者放行）。 */
async function callTool(app: BootedApp, name: string, args: unknown): Promise<unknown> {
  const session = app.ctx.get(SESSION_SERVICE)
  const pipeline = new ToolPipeline({
    ctx: app.ctx,
    registry: app.ctx.get(TOOLS_SERVICE),
    session,
    guard: new ToolGuard(),
    sessionId: session.sessionId,
    now: () => NOW,
  })
  let seq = 0
  const execution = await pipeline.execute({
    callId: `call-${name}-${String((seq += 1))}`,
    name,
    args: args as Readonly<Record<string, unknown>>,
  })
  if (execution.result.isError) {
    throw new Error(`${name} 失败：${execution.result.code ?? 'unknown'}`)
  }
  return execution.value
}

/** 与 `ROWS` 相同，但打开调度器（用于"重启补跑"用例）。 */
const ROWS_WITH_SCHEDULER: readonly PluginRow[] = [
  ...ROWS.filter((row) => row.id !== 'plan:scheduler'),
  { id: 'plan:scheduler', config: { enabled: true, catchUpOnBoot: true } },
]

const eventsOf = (app: BootedApp): readonly { type: string; data: Record<string, unknown> }[] =>
  app.ctx
    .get(SESSION_SERVICE)
    .events()
    .map((event) => ({ type: event.type, data: event.data as unknown as Record<string, unknown> }))

describe('授权窗口 → 唤醒（端到端）', () => {
  let booted: Booted | undefined

  beforeEach(() => {
    booted = undefined
  })

  afterEach(async () => {
    if (booted !== undefined) {
      await booted.app.dispose('test-done')
      booted.cleanup()
    }
  })

  it('arm → wake：执行一次；票据带 window 授权；同实例再唤醒幂等', async () => {
    booted = await bootHost()
    const app = booted.app

    const armed = (await callTool(app, 'plan_arm', PLAN_ARGS)) as { windowId: string; planId: string }
    expect(armed.windowId).toMatch(/^w-call-plan_arm-/)
    // 出参必须是结构化对象（回放与计划卡都靠它）
    expect(armed).toMatchObject({ planId: expect.any(String), state: 'armed' })

    const runner = app.ctx.get(PLAN_WAKE_SERVICE)
    const first = await runner.wake({ at: NOW, source: 'cli' })
    expect(first.ok).toBe(true)
    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]).toMatchObject({ status: 'executed', windowId: armed.windowId })

    const events = eventsOf(app)
    expect(events.filter((event) => event.type === 'plan/created')).toHaveLength(1)
    const approved = events.filter((event) => event.type === 'ticket/approved')
    expect(approved.length).toBeGreaterThan(0)
    for (const event of approved) {
      expect(event.data['authorization']).toMatchObject({ kind: 'window', ref: armed.windowId })
    }

    const second = await runner.wake({ at: NOW, source: 'cli' })
    expect(second.entries[0]).toMatchObject({ status: 'skipped', reason: 'already-ran' })
    expect(eventsOf(app).filter((event) => event.type === 'plan/created')).toHaveLength(1)
  })

  it('判定时刻越界 ⇒ window-clock-ahead，一条都不执行', async () => {
    booted = await bootHost()
    const app = booted.app
    await callTool(app, 'plan_arm', PLAN_ARGS)

    const report = await app.ctx.get(PLAN_WAKE_SERVICE).wake({ at: NOW + 60 * 60 * 1000, source: 'cli' })
    expect(report.ok).toBe(false)
    expect(report.code).toBe('window-clock-ahead')
    expect(report.entries).toHaveLength(0)
    expect(eventsOf(app).filter((event) => event.type === 'plan/created')).toHaveLength(0)
  })

  it('条件失守 ⇒ downgraded（不执行、不扣款）', async () => {
    booted = await bootHost()
    const app = booted.app
    await callTool(app, 'plan_arm', {
      ...PLAN_ARGS,
      conditions: [{ kind: 'balance-at-least', cents: 999_999_999 }],
    })

    const report = await app.ctx.get(PLAN_WAKE_SERVICE).wake({ at: NOW, source: 'cli' })
    expect(report.entries[0]).toMatchObject({ status: 'downgraded', code: 'condition-failed' })
    expect(eventsOf(app).filter((event) => event.type === 'plan/created')).toHaveLength(0)
  })

  it('disarm 后唤醒 ⇒ 扫描阶段就排除（entries 为空、零执行）', async () => {
    booted = await bootHost()
    const app = booted.app
    const armed = (await callTool(app, 'plan_arm', PLAN_ARGS)) as { windowId: string }
    await callTool(app, 'plan_disarm', { windowId: armed.windowId })

    const report = await app.ctx.get(PLAN_WAKE_SERVICE).wake({ at: NOW, source: 'cli' })
    // 撤销在 `duePlans` 的 state 过滤处生效：撤销的窗口不是"到期"，连条目都不该出现。
    // `checkWindow` 仍保留 `plan-cancelled` 分支（防"扫描后被撤"的竞态），但正常路径走不到。
    expect(report.ok).toBe(true)
    expect(report.entries).toHaveLength(0)
    expect(eventsOf(app).filter((event) => event.type === 'plan/created')).toHaveLength(0)
  })

  it('预算越界 ⇒ 不擅自加价（amount-within 失守，不执行）', async () => {
    booted = await bootHost()
    const app = booted.app
    await callTool(app, 'plan_arm', { ...PLAN_ARGS, budgetYuan: 100 })

    const report = await app.ctx.get(PLAN_WAKE_SERVICE).wake({ at: NOW, source: 'cli' })
    expect(report.entries[0]).toMatchObject({ status: 'downgraded', code: 'condition-failed' })
    expect(eventsOf(app).filter((event) => event.type === 'plan/created')).toHaveLength(0)
  })
})


describe('重启补跑（D1 的实测证据）', () => {
  it('第一次进程 arm 并退出；第二次进程 boot 后自动补跑到期计划', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-authz-boot-'))
    const first = await bootHost(dir)
    await callTool(first.app, 'plan_arm', PLAN_ARGS)
    const windowId = (first.app.ctx.get(SESSION_SERVICE).events().length > 0)
      ? (eventsOf(first.app).find((event) => event.type === 'tool/result' && event.data['name'] === 'plan_arm')
          ?.data['content'] as { text?: string }[] | undefined)?.[0]?.text
      : undefined
    expect(windowId).toBeDefined()
    await first.app.dispose('simulated-exit')
    // 不删目录：模拟"关掉 App，会话日志还在"

    const second = await bootHost(dir, ROWS_WITH_SCHEDULER, true)
    // boot 补跑在微任务/重试窗口内完成（最多 20×50ms）
    await new Promise((resolve) => setTimeout(resolve, 200))
    const created = eventsOf(second.app).filter((event) => event.type === 'plan/created')
    expect(created.length).toBeGreaterThanOrEqual(1)
    await second.app.dispose('test-done')
    rmSync(dir, { recursive: true, force: true })
  }, 15_000)
})


describe('商户腿（G4）：搜索闭包 + 缺货换店', () => {
  let app: BootedApp | undefined

  afterEach(async () => {
    if (app !== undefined) await app.dispose('test-done')
  })

  it('搜索结果才能下单；没搜过的 offerId 一律拒（引用闭包）', async () => {
    app = (await bootHost()).app
    const searched = (await callTool(app, 'merchant_search', { category: 'cake' })) as {
      offers: readonly { offerId: string }[]
    }
    expect(searched.offers.length).toBeGreaterThan(0)

    const service = app.ctx.get(MERCHANT_SERVICE)
    const ok = service.fulfil('s-authz', searched.offers[0]!.offerId, 100_000)
    expect(ok.status).toBe('ok')

    const denied = service.fulfil('s-authz', 'o-flower-a1', 100_000)
    expect(denied.status).toBe('failed')
    expect(denied.attempts[0]).toMatchObject({ code: 'offer-not-searched' })
  })

  it('缺货 ⇒ 自动换一家（fallback，最多两家）', async () => {
    const stockout = ROWS.map((row) =>
      row.id === 'bank:merchant' ? { ...row, config: { enabled: true, fault: 'stockout' } } : row,
    )
    app = (await bootHost(undefined, stockout)).app
    const searched = (await callTool(app, 'merchant_search', { category: 'flower' })) as {
      offers: readonly { offerId: string; merchantId: string }[]
    }
    // 售罄开关针对 m-flower-a：先从搜索结果里选它家的商品（演示"选到这家、下单才发现卖完"）
    const picked = searched.offers.find((offer) => offer.merchantId === 'm-flower-a')
    expect(picked).toBeDefined()
    const service = app.ctx.get(MERCHANT_SERVICE)
    const result = service.fulfil('s-authz', picked!.offerId, 100_000)
    expect(result.status).toBe('fallback')
    expect(result.attempts).toHaveLength(2)
    expect(result.order).toBeDefined()
  })

  it('涨价超预算 ⇒ 不成交（不擅自加价）', async () => {
    const priceUp = ROWS.map((row) =>
      row.id === 'bank:merchant' ? { ...row, config: { enabled: true, fault: 'price-up' } } : row,
    )
    app = (await bootHost(undefined, priceUp)).app
    const searched = (await callTool(app, 'merchant_search', { category: 'cake' })) as {
      offers: readonly { offerId: string }[]
    }
    const service = app.ctx.get(MERCHANT_SERVICE)
    // 预算只有 100 元：涨价后最便宜的蛋糕也超预算
    const result = service.fulfil('s-authz', searched.offers[0]!.offerId, 10_000)
    expect(result.status).toBe('failed')
    expect(result.attempts.some((attempt) => attempt.code === 'over-budget')).toBe(true)
  })

  it('arm 带 merchantOfferId ⇒ wake 的条目里有商户履约结果', async () => {
    app = (await bootHost()).app
    const searched = (await callTool(app, 'merchant_search', { category: 'cake' })) as {
      offers: readonly { offerId: string }[]
    }
    await callTool(app, 'plan_arm', {
      ...PLAN_ARGS,
      merchantOfferId: searched.offers[0]!.offerId,
    })
    const report = await app.ctx.get(PLAN_WAKE_SERVICE).wake({ at: NOW, source: 'cli' })
    expect(report.entries[0]?.status).toBe('executed')
    expect(report.entries[0]?.merchant?.status).toBe('ok')
  })
})
