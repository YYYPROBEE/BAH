/**
 * 授权窗口的**审批明细**（G8）：签票时就把每一笔钱说清楚。
 *
 * 这一组用例只回答三个问题，答不上来就等于没做：
 * 1. `plan_arm` / `transfer_schedule` / `birthday_plan` 走**真实管线**时，
 *    `approval/asked.details` 到底有几条、金额是不是来自事实源；
 * 2. 商户报价变了，审批卡上的数字会不会跟着变（**这是"来自报价而非入参"的唯一证据**）；
 * 3. `detailsDigest` 被篡改（日志里把预算改小、摘要不动）时，唤醒是否**真的**不自动放行。
 *
 * 抗自证：
 * - 金额一律与 `MERCHANT_OFFERS` 的 `priceCents` 对照，不拿工具自己的出参自证；
 * - "篡改"构造在**会话日志层**（`tool/result` 正文），不是改内存对象——
 *   内存对象改了不算攻击，日志改了才是；
 * - 对照组（不篡改 → 真的执行）与实验组同批跑，否则"永远降级"也能伪装成绿。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asSessionId } from '@bah/test-support'
import { formatYuan } from '@bah/bank'
import {
  PLAN_ARM_TOOL,
  SESSION_SERVICE,
  TOOLS_SERVICE,
  ToolGuard,
  ToolPipeline,
} from '@bah/runtime'
import { afterEach, describe, expect, it } from 'vitest'

import { boot, type BootOptions, type BootedApp, type ProfileSummary } from '../boot.ts'
import { BANK_TRANSFER_PROBE } from './bank-tools.ts'
import { createCatalog } from './index.ts'
import { PLAN_ARMED_SERVICE, PLAN_WAKE_SERVICE, transferUsageOf, type PlanWakeReport } from './plan.ts'
import {
  chineseTimeAt,
  detailsDigestOf,
  maskPhone,
  renderArmDetails,
  renderBirthdayDetails,
  renderScheduleDetails,
} from './plan-details.ts'

import type { Bundle, PluginRow } from '../profile-plugins.ts'
import { testRunContext } from '../test-run-context.ts'

const PROFILE: ProfileSummary = { name: 'plan', bundles: ['base'], hmr: false }
const NOW = 1_000

/**
 * 行集合显式写在这里（对齐 `authorization.test.ts` 的夹具）。
 *
 * 为什么不读 `profiles/plan/patch.yml`：那份 patch 里的 `interaction:approval` 在这个
 * 层叠方式下不会装出自动应答者（实测 `approval-no-responder`），而本设计要测的是
 * **签票时的明细**，不是 profile 层叠。行集合写死在这里，少一层间接。
 */
const BASE_ROWS: readonly PluginRow[] = [
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
    config: { responder: 'headless', autoDecision: 'allow', autoVerify: true },
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
  // 本文件手动调 `wake()`：调度器开着会在 boot 补跑里抢先执行，对照组会变成 already-ran
  { id: 'plan:scheduler', config: { enabled: false } },
]

interface Booted {
  readonly app: BootedApp
  readonly cleanup: () => void
}

/**
 * 造一份行集合：只把商户故障开关换掉，其余原样（**整行替换**，不是叠一层 overlay——
 * overlay 的 `config` 语义在这里会把 `fault` 套成对象，boot 直接 fail-loud）。
 */
function rowsWithMerchantFault(fault: 'none' | 'price-up'): readonly PluginRow[] {
  return BASE_ROWS.map((row) =>
    row.id === 'bank:merchant' ? { ...row, config: { enabled: true, fault } } : row,
  )
}

async function bootPlanIn(
  dir: string,
  restore = false,
  fault: 'none' | 'price-up' = 'none',
): Promise<BootedApp> {
  const bundle: Bundle = { name: 'base', rows: rowsWithMerchantFault(fault) }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({
      sessionId: asSessionId('s-plan-details'),
      now: () => NOW,
      jsonlDir: dir,
      ...(restore ? { restoreSession: true } : {}),
    }),
  }
  return boot(options)
}

async function bootPlan(fault: 'none' | 'price-up' = 'none'): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'bah-plan-details-'))
  return {
    app: await bootPlanIn(dir, false, fault),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

interface FlatEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

const eventsOf = (app: BootedApp): readonly FlatEvent[] =>
  app.ctx
    .get(SESSION_SERVICE)
    .events()
    .map((event) => ({ type: event.type, data: event.data as unknown as Record<string, unknown> }))

/** 某个工具最近一次 `approval/asked` 的明细（没有就 `undefined`）。 */
function detailsOf(app: BootedApp, name: string): readonly { label: string; value: string }[] | undefined {
  const asked = eventsOf(app).filter(
    (event) => event.type === 'approval/asked' && event.data['name'] === name,
  )
  const last = asked[asked.length - 1]
  if (last === undefined) return undefined
  const details = last.data['details']
  if (!Array.isArray(details)) return undefined
  return details as readonly { label: string; value: string }[]
}

/** 通过**真实工具管线**执行一次调用（模型调用的等价物；审批由 headless 应答者放行）。 */
async function callTool(
  app: BootedApp,
  name: string,
  args: Readonly<Record<string, unknown>>,
  callId: string,
): Promise<unknown> {
  const session = app.ctx.get(SESSION_SERVICE)
  const pipeline = new ToolPipeline({
    ctx: app.ctx,
    registry: app.ctx.get(TOOLS_SERVICE),
    session,
    guard: new ToolGuard(),
    sessionId: session.sessionId,
    now: () => NOW,
  })
  const execution = await pipeline.execute({ callId, name, args })
  if (execution.result.isError) {
    throw new Error(`${name} 失败：${JSON.stringify(execution.result)}`)
  }
  return execution.value
}

let booted: Booted | undefined

afterEach(async () => {
  if (booted !== undefined) {
    await booted.app.dispose('test-done')
    booted.cleanup()
    booted = undefined
  }
})

describe('明细渲染（纯函数）', () => {
  const offer = { offerId: 'o-flower-1', merchantName: '即刻花', priceCents: 12_900 }

  it('报价进明细：换一个 priceCents，明细与摘要一起变', () => {
    const base = renderArmDetails({
      title: '生日计划：鲜花',
      budgetCents: 20_000,
      dueAt: Date.UTC(2026, 1, 6, 9),
      tier: 'standard',
      conditions: [{ kind: 'balance-at-least', cents: 129_800 }],
      offer,
      legs: [{ nodeId: 'pay', tool: 'transfer_create', amountCents: 12_900, payee: '即刻花' }],
    })
    const cheaper = renderArmDetails({
      title: '生日计划：鲜花',
      budgetCents: 20_000,
      dueAt: Date.UTC(2026, 1, 6, 9),
      tier: 'standard',
      conditions: [{ kind: 'balance-at-least', cents: 129_800 }],
      offer: { ...offer, priceCents: 17_900 },
      legs: [{ nodeId: 'pay', tool: 'transfer_create', amountCents: 17_900, payee: '即刻花' }],
    })

    expect(base[1]).toEqual({ label: '商户报价', value: '即刻花 ¥129.00', emphasis: 'amount' })
    expect(cheaper[1]?.value).toBe('即刻花 ¥179.00')
    // 摘要必须跟着变：否则"用户批了 129、唤醒时按 179 付"查不出来
    expect(detailsDigestOf(cheaper)).not.toBe(detailsDigestOf(base))
  })

  it('同一份事实两次渲染逐字相同（摘要稳定），且与入参顺序无关的键序无关', () => {
    const facts = {
      title: '查余额',
      budgetCents: 10_000,
      dueAt: NOW,
      tier: 'standard' as const,
      conditions: [{ kind: 'balance-at-least' as const, cents: 10_000 }],
      legs: [{ nodeId: 'bal', tool: 'account_balance' as const }],
    }
    expect(renderArmDetails(facts)).toEqual(renderArmDetails(facts))
    expect(detailsDigestOf(renderArmDetails(facts))).toBe(detailsDigestOf(renderArmDetails(facts)))
    // 16 位十六进制
    expect(detailsDigestOf(renderArmDetails(facts))).toMatch(/^[0-9a-f]{16}$/)
  })

  it('条件快照逐条翻译成人话；认不出的 kind 也不静默丢弃', () => {
    const details = renderArmDetails({
      title: 't',
      budgetCents: 100,
      dueAt: NOW,
      tier: 'strict',
      conditions: [
        { kind: 'balance-at-least', cents: 129_800 },
        { kind: 'amount-within', cents: 50_000 },
        { kind: 'fact-unchanged', factId: 'f-income', version: 3 },
      ],
      legs: [],
    })
    const lines = details.filter((detail) => detail.label === '条件快照').map((detail) => detail.value)
    expect(lines).toEqual(['余额 ≥ ¥1,298.00', '单笔金额 ≤ ¥500.00', '事实 f-income 仍为第 3 版'])
    expect(details[details.length - 1]).toEqual({
      label: '授权档位',
      value: '严格（每次都问）',
    })
  })

  it('定时转账：手机号脱敏后进明细，原号一个字符都不出现；时刻给 ISO 与中文两条', () => {
    const details = renderScheduleDetails({
      amountCents: 50_000,
      payeeName: '王建国',
      payeePhoneMasked: maskPhone('13900002222'),
      dueAt: Date.UTC(2026, 10, 1, 9),
    })
    expect(details).toEqual([
      { label: '转账金额', value: '¥500.00', emphasis: 'amount' },
      { label: '收款人', value: '王建国（139****2222）' },
      { label: '执行时刻', value: '2026-11-01T09:00:00.000Z', emphasis: 'date' },
      { label: '执行时刻', value: '2026年11月1日 09:00（UTC）', emphasis: 'date' },
    ])
    expect(JSON.stringify(details)).not.toContain('13900002222')
  })

  it('定时转账：有 usage 时插入「当日已用 / 当日剩余」两行；没有就整条省略（不写 0）', () => {
    const base = {
      amountCents: 50_000,
      payeeName: '王建国',
      dueAt: Date.UTC(2026, 10, 1, 9),
    }
    const withUsage = renderScheduleDetails({
      ...base,
      usage: { dailyUsedCents: 200_000, dailyLimitCents: 500_000, remainingCents: 300_000 },
    })
    expect(withUsage.map((detail) => detail.label)).toEqual([
      '转账金额',
      '收款人',
      '当日已用',
      '当日剩余',
      '执行时刻',
      '执行时刻',
    ])
    expect(withUsage[2]).toEqual({ label: '当日已用', value: '¥2,000.00', emphasis: 'amount' })
    expect(withUsage[3]).toEqual({ label: '当日剩余', value: '¥3,000.00', emphasis: 'amount' })
    // 省略纪律：没有 usage 时**一行都不写**，不拿「¥0.00」冒充服务端算过的事实
    expect(renderScheduleDetails(base)).toHaveLength(4)
  })

  it('额度探针：缺席 / 无身份 / 抛错都返回 undefined（不把展示面的异常变成审批失败）', async () => {
    const probe = {
      preview: async () => ({
        dailyUsedCents: 200_000,
        dailyLimitCents: 500_000,
        remainingCents: 300_000,
      }),
    }
    expect(await transferUsageOf(probe, 'u-1', 500, '王建国')).toEqual({
      dailyUsedCents: 200_000,
      dailyLimitCents: 500_000,
      remainingCents: 300_000,
    })
    expect(await transferUsageOf(undefined, 'u-1', 500, '王建国')).toBeUndefined()
    expect(await transferUsageOf(probe, undefined, 500, '王建国')).toBeUndefined()
    const boom = {
      preview: async (): Promise<never> => {
        throw new Error('probe-boom')
      },
    }
    expect(await transferUsageOf(boom, 'u-1', 500, '王建国')).toBeUndefined()
  })

  it('生日三腿：鲜花/蛋糕只认报价；商户服务缺席才退回入参预算并**标注**', () => {
    const withOffers = renderBirthdayDetails({
      birthdayAt: Date.UTC(2026, 1, 8),
      dueAt: Date.UTC(2026, 1, 6, 9),
      lockCents: 100_000,
      flower: offer,
      cake: { offerId: 'o-cake-1', merchantName: '小满烘焙', priceCents: 16_900 },
      totalCents: 129_800,
      conditions: [{ kind: 'balance-at-least', cents: 129_800 }],
      tier: 'standard',
      lockPayee: '锁定账户(9012)',
    })
    expect(withOffers.slice(0, 3)).toEqual([
      { label: '锁定预算', value: '¥1,000.00 → 锁定账户(9012)', emphasis: 'amount' },
      { label: '鲜花', value: '¥129.00（即刻花，生日前 2 天 09:00 UTC）', emphasis: 'amount' },
      { label: '蛋糕', value: '¥169.00（小满烘焙，生日前 2 天 09:00 UTC）', emphasis: 'amount' },
    ])

    const degraded = renderBirthdayDetails({
      birthdayAt: Date.UTC(2026, 1, 8),
      dueAt: Date.UTC(2026, 1, 6, 9),
      lockCents: 100_000,
      flowerBudgetCents: 20_000,
      cakeBudgetCents: 20_000,
      totalCents: 140_000,
      conditions: [],
      tier: 'standard',
    })
    expect(degraded[1]?.value).toBe('¥200.00（无商户报价：商户服务未装配，按入参预算）')
  })

  it('中文时刻按 UTC 渲染（把 UTC 说成北京时间是 8 小时的事故）', () => {
    expect(chineseTimeAt(Date.UTC(2026, 9, 31, 16, 5))).toBe('2026年10月31日 16:05（UTC）')
  })
})

/** 用同一份入参跑一次 `birthday_plan`，返回它的审批明细。 */
async function birthdayDetailsOf(
  bootedApp: Booted,
): Promise<readonly { label: string; value: string }[]> {
  await callTool(
    bootedApp.app,
    'birthday_plan',
    // 300 元预算：涨价 30% 后仍买得起（否则会走"无商户报价"降级分支）
    { birthday: '下个月8号', lockYuan: 1000, flowerYuan: 300, cakeYuan: 300 },
    'call-birthday-price',
  )
  const details = detailsOf(bootedApp.app, 'birthday_plan')
  expect(details).toBeDefined()
  return details ?? []
}


/** 起一个"自动拒绝"的实例：验证不批准 → 无 armed、无流水（验收 3）。 */
async function bootPlanRejecting(): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'bah-plan-reject-'))
  const bundle: Bundle = {
    name: 'base',
    rows: rowsWithMerchantFault('none').map((row) =>
      row.id === 'interaction:approval'
        ? { ...row, config: { responder: 'headless', autoDecision: 'reject', autoVerify: true } }
        : row,
    ),
  }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({ sessionId: asSessionId('s-plan-details'), now: () => NOW, jsonlDir: dir }),
  }
  return { app: await boot(options), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('审批明细：走真实管线签票', () => {
  it('plan_arm：明细 4 条（预算 / 节点 / 到期 / 档位），金额来自入参预算而不是编的', async () => {
    booted = await bootPlan()
    await callTool(
      booted.app,
      PLAN_ARM_TOOL,
      {
        title: '查余额',
        planId: 'p-details',
        nodes: [{ id: 'bal', tool: 'account_balance', args: {}, deps: [] }],
        budgetYuan: 100,
        dueAt: new Date(NOW + 60_000).toISOString(),
      },
      'call-arm-details',
    )

    const details = detailsOf(booted.app, PLAN_ARM_TOOL)
    expect(details).toBeDefined()
    expect(details).toHaveLength(4)
    expect(details?.[0]).toMatchObject({ label: '预算上限', value: '¥100.00' })
    expect(details?.[1]?.value).toContain('account_balance')
    expect(details?.[2]?.label).toBe('窗口到期')
    expect(details?.[3]?.value).toContain('标准')
  })

  it('plan_arm：带 merchantOfferId 时，商户行取自报价而不是预算', async () => {
    booted = await bootPlan()
    // 先搜一次商户，拿到一个本会话可引用的 offerId（引用闭包）
    const offers = (await callTool(
      booted.app,
      'merchant_search',
      { category: 'flower', budgetCents: 50_000 },
      'call-search',
    )) as { offers: readonly { offerId: string; merchantName: string; priceCents: number }[] }
    const first = offers.offers[0]
    expect(first).toBeDefined()
    if (first === undefined) return

    await callTool(
      booted.app,
      PLAN_ARM_TOOL,
      {
        title: '生日鲜花',
        planId: 'p-merchant',
        nodes: [
          {
            id: 'pay',
            tool: 'transfer_create',
            args: { amount: first.priceCents / 100, payee: { name: first.merchantName } },
            deps: [],
          },
        ],
        budgetYuan: 999,
        dueAt: new Date(NOW + 60_000).toISOString(),
        merchantOfferId: first.offerId,
      },
      'call-arm-merchant',
    )

    const details = detailsOf(booted.app, PLAN_ARM_TOOL)
    // 预算行说的是 999，商户行必须说报价（两者不同正是"价格只认报价"的证据）
    expect(details?.[0]?.value).toBe('¥999.00')
    expect(details?.[1]?.label).toBe('商户报价')
    expect(details?.[1]?.value).toContain(first.merchantName)
    expect(details?.[1]?.value).toContain(`¥${(first.priceCents / 100).toFixed(2)}`)
  })

  it('birthday_plan：三腿逐笔可见；鲜花/蛋糕取商户报价，入参预算再大也不改审批卡数字', async () => {
    booted = await bootPlan()
    await callTool(
      booted.app,
      'birthday_plan',
      // 入参故意写 999：如果实现拿 flowerYuan 当报价，这里就会显示 999
      { birthday: '下个月8号', lockYuan: 1000, flowerYuan: 999, cakeYuan: 999 },
      'call-birthday-details',
    )

    const details = detailsOf(booted.app, 'birthday_plan')
    expect(details).toBeDefined()
    const labels = (details ?? []).map((detail) => detail.label)
    expect(labels.slice(0, 4)).toEqual(['锁定预算', '鲜花', '蛋糕', '总预算'])
    expect(details?.[0]?.value).toBe('¥1,000.00 → 锁定账户(9012)')
    // 即时花的鲜花报价 129 元、小满烘焙的蛋糕 169 元（`MERCHANT_OFFERS`）
    expect(details?.[1]?.value).toContain('¥129.00')
    expect(details?.[1]?.value).toContain('即刻花')
    expect(details?.[2]?.value).toContain('¥169.00')
    expect(details?.[2]?.value).toContain('小满烘焙')
    // 999 元只可能来自入参，绝不能出现在报价行
    expect(details?.[1]?.value).not.toContain('999')
    expect(details?.[2]?.value).not.toContain('999')
  })

  it('商户报价变了（price-up 涨价 30%）→ 审批卡数字跟着变，入参一个都没改', async () => {
    // 同一份入参、两份商户目录：如果实现拿入参预算当报价，两次渲染必然一模一样
    const baseline = await bootPlan('none')
    const raised = await bootPlan('price-up')
    try {
      const before = await birthdayDetailsOf(baseline)
      const after = await birthdayDetailsOf(raised)
      expect(before[1]?.value).toContain('¥129.00')
      expect(after[1]?.value).toContain('¥167.70')
      expect(before[2]?.value).toContain('¥169.00')
      expect(after[2]?.value).toContain('¥219.70')
      // 档位 / 到期这些不随报价变：证明变的只有价格本身
      expect(after[0]?.value).toBe(before[0]?.value)
    } finally {
      await baseline.app.dispose('test-done')
      baseline.cleanup()
      await raised.app.dispose('test-done')
      raised.cleanup()
    }
  })

  it('不批准 → 不产生任何流水，也没有 armed 计划（验收 3）', async () => {
    const rej = await bootPlanRejecting()
    try {
      const session = rej.app.ctx.get(SESSION_SERVICE)
      const pipeline = new ToolPipeline({
        ctx: rej.app.ctx,
        registry: rej.app.ctx.get(TOOLS_SERVICE),
        session,
        guard: new ToolGuard(),
        sessionId: session.sessionId,
        now: () => NOW,
      })
      const execution = await pipeline.execute({
        callId: 'call-birthday-reject',
        name: 'birthday_plan',
        args: { birthday: '下个月8号' },
      })
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('approval-rejected')
      // 授权窗口账本为空：被拒绝的请求一步都没执行
      expect(rej.app.ctx.get(PLAN_ARMED_SERVICE).list()).toHaveLength(0)
      // 没有任何资金流水（transfer_create 未发生）
      const types = eventsOf(rej.app).map((event) => event.type)
      expect(types.filter((type) => type === 'tool/call')).toHaveLength(1) // 只有 birthday_plan 自己
      expect(
        eventsOf(rej.app).filter(
          (event) => event.type === 'tool/call' && event.data['name'] === 'transfer_create',
        ),
      ).toHaveLength(0)
    } finally {
      await rej.app.dispose('test-done')
      rej.cleanup()
    }
  })

  it('transfer_schedule：金额 / 脱敏收款人 / 当日额度 / ISO 与中文时刻都在明细里', async () => {
    booted = await bootPlan()
    await callTool(
      booted.app,
      'transfer_schedule',
      { amount: 500, payee: { name: '王建国', phone: '13900002222' }, when: '明天 09:00' },
      'call-schedule-details',
    )

    const details = detailsOf(booted.app, 'transfer_schedule')
    expect(details?.map((detail) => detail.label)).toEqual([
      '转账金额',
      '收款人',
      '当日已用',
      '当日剩余',
      '执行时刻',
      '执行时刻',
    ])
    expect(details?.[0]?.value).toBe('¥500.00')
    expect(details?.[1]?.value).toBe('王建国（139****2222）')
    // 额度数字必须来自探针（核心试算），不是入参推算：拿探针现读一次对照
    const usage = await booted.app.ctx
      .get(BANK_TRANSFER_PROBE)
      .preview('u-1', 500, '王建国')
    expect(usage).toBeDefined()
    expect(details?.[2]?.value).toBe(formatYuan(usage?.dailyUsedCents ?? -1))
    expect(details?.[3]?.value).toBe(formatYuan(usage?.remainingCents ?? -1))
    expect(details?.[5]?.value).toMatch(/年.*月.*日.*（UTC）$/)
    // PII：原号不得进审批帧（帧是从事件投影的，等于不得进事件）
    expect(JSON.stringify(details)).not.toContain('13900002222')
  })

  it('plan_arm 的出参带 detailsDigest（武装时算的那一份），且与明细一一对应', async () => {
    booted = await bootPlan()
    const armed = (await callTool(
      booted.app,
      PLAN_ARM_TOOL,
      {
        title: '查余额',
        planId: 'p-digest',
        nodes: [{ id: 'bal', tool: 'account_balance', args: {}, deps: [] }],
        budgetYuan: 100,
        dueAt: new Date(NOW + 60_000).toISOString(),
      },
      'call-arm-digest',
    )) as { detailsDigest?: string }

    expect(armed.detailsDigest).toMatch(/^[0-9a-f]{16}$/)
    // 回放（重启后从 tool/result 重建）必须拿到同一个摘要：否则每次重启都判"被篡改"
    const replayed = booted.app.ctx.get(PLAN_ARMED_SERVICE).list()
    expect(replayed[0]?.detailsDigest).toBe(armed.detailsDigest)
  })
})

describe('detailsDigest：日志被篡改 → 唤醒不自动放行', () => {
  /**
   * 造一条"已武装"的 `tool/result` 并**重启**：篡改发生在磁盘日志上，不是内存对象上。
   *
   * 为什么必须重启：`replayArmedPlans` 只在 `apply()` 时读一次事件流；改内存里的
   * `ArmedPlan` 不算攻击（进程内本来就是可信的），改日志才是真实威胁模型。
   */
  async function wakeWith(tamper: boolean): Promise<{ report: PlanWakeReport; app: BootedApp }> {
    const dir = mkdtempSync(join(tmpdir(), 'bah-plan-tamper-'))

    const dueAt = NOW - 1_000
    const legit = {
      planId: 'p-tamper',
      windowId: 'w-tamper',
      planDigest: 'digest-of-plan',
      title: '转账 800 元',
      tier: 'standard' as const,
      conditions: [],
      budgetCents: 80_000,
      dueAt,
      recurrence: { every: 'once' as const, dueAt },
      // 只读节点：执行成功不会触发任何审批，红/绿只由"有没有执行"决定
      plan: {
        planId: 'p-tamper',
        nodes: [{ id: 'bal', tool: 'account_balance', args: {}, deps: [] }],
      },
      armedAt: NOW - 60_000,
      state: 'armed' as const,
      detailsDigest: detailsDigestOf(
        renderArmDetails({
          title: '转账 800 元',
          budgetCents: 80_000,
          dueAt,
          tier: 'standard',
          conditions: [],
          legs: [{ nodeId: 'bal', tool: 'account_balance' }],
        }),
      ),
    }
    // 篡改：预算被改成 1 元（摘要仍是 800 元那一份）
    const record = tamper ? { ...legit, budgetCents: 100 } : legit

    const first = await bootPlanIn(dir)
    first.ctx.get(SESSION_SERVICE).append('tool/result', {
      callId: 'call-legacy-arm',
      name: PLAN_ARM_TOOL,
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(record) }],
      durationMs: 1,
    })
    await first.dispose('test-done')

    const app = await bootPlanIn(dir, true)
    booted = { app, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
    const report = await app.ctx.get(PLAN_WAKE_SERVICE).wake({ at: NOW, source: 'tool' })
    return { report, app }
  }

  it('对照组：摘要对得上 → 真的执行（证明下面那条红不是因为"永远降级"）', async () => {
    const { report } = await wakeWith(false)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]).toMatchObject({ status: 'executed', planId: 'p-tamper' })
  })

  it('实验组：预算被改小、摘要没动 → downgraded(details-changed)，一条 plan/created 都没有', async () => {
    const { report, app } = await wakeWith(true)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]).toMatchObject({ status: 'downgraded', code: 'details-changed' })
    expect(report.entries[0]?.failed?.[0]).toMatchObject({ kind: 'details-digest' })
    // 降级 = 人工确认，不是"自动放行后再看"：会话里不能有执行痕迹
    const types = eventsOf(app).map((event) => event.type)
    expect(types.filter((type) => type === 'plan/created')).toEqual([])
  })
})
