/**
 * `plan:dag` 集成（方案 §4.6：真实 `HOST_PLUGINS` + `--profile plan`，直接调 `PLAN_SERVICE.run()`）。
 *
 * 判据不是"引擎能跑"，而是**接缝真的通了**：
 * - 每个节点都在 `tool/call` 里有记录（走的是七段管线，不是 `definition.execute`）；
 * - `approval/asked` 只出现 1 次（每个节点各判一次，不是"外层批一次"）；
 * - dry-run 一条 `tool/call` 都没有（假记录不能进审计）；
 * - 未装配 `plan:dag` 的 profile 拿不到 `bah:plan`（"默认零影响"的唯一证据）。
 *
 * 行的配置**从 `profiles/plan/patch.yml` 读**（不是测试里再抄一份）：
 * 抄一份就会出现"profile 改了、测试还在验旧配置"的假绿。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { asSessionId } from '@bah/test-support'
import {
  AGENTS_SERVICE,
  PLAN_INCIDENT_CODE,
  SESSION_SERVICE,
  TOOLS_SERVICE,
  type Plan,
  type PlanApi,
} from '@bah/runtime'
import { BahError } from '@bah/util'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { boot, type BootOptions, type BootedApp, type ProfileSummary } from '../boot.ts'
import { createCatalog } from './index.ts'
import { PLAN_SERVICE, planPlugin } from './plan.ts'

import type { Bundle, ConfigLayer, PluginRow } from '../profile-plugins.ts'

const PROFILE: ProfileSummary = { name: 'plan', bundles: ['base'], hmr: false }

/** 真实的 profile patch（相对本测试文件定位，不依赖 cwd）。 */
const PATCH_PATH = fileURLToPath(new URL('../../../../../profiles/plan/patch.yml', import.meta.url))

/**
 * base 的**子集**（会话/工具/模型/主循环/持久化 + 银行工具 + 审批 + saga 三行 + 接线层）。
 *
 * 为什么是子集而不是全部 16 行：本测试关心的是"plan 行接进管线"，渠道与知识库那几行
 * 与 plan 无接缝。所有行的**实现**仍来自真实的 `createCatalog()`（`HOST_PLUGINS`）。
 *
 * `bank:saga-bridge` 在这里写 `enabled: false`：与 profile patch 的决策一致（方案 §3.6 方案 B）。
 * 真启用的话一个 `transfer_create` 节点会被 saga 再展开成 preview+create，
 * 3 节点的计划会落出 4 条 `tool/call`——下面的断言就是为了钉住这条。
 */
const BASE_ROWS: readonly PluginRow[] = [
  { id: 'core:session' },
  { id: 'core:tools' },
  { id: 'core:prompt' },
  { id: 'core:model', config: { provider: 'deepseek', model: 'deepseek-chat' } },
  { id: 'core:agent', config: { loop: { model: 'deepseek:deepseek-chat' } } },
  { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
  { id: 'audit:decisions' },
  { id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' } },
  {
    id: 'interaction:approval',
    config: { responder: 'headless', autoDecision: 'allow', autoVerify: true },
  },
  // W08：trace.sink 无缺省值（真实 plan patch 也会写 session，此处是子集夹具的兜底）
  { id: 'safety:sentry', config: { trace: { sink: 'memory' } } },
  { id: 'bank:saga-store', config: { dbPath: ':memory:' } },
  { id: 'bank:saga' },
  { id: 'bank:saga-audit' },
  { id: 'bank:saga-bridge', config: { enabled: false } },
]

const PAYEE = { name: '王建国', phone: '13900002222' }

/** 演示主链路：查余额 → 试算 → 扣款（3 个节点、1 次审批）。 */
const transferPlan = (planId: string): Plan => ({
  planId,
  nodes: [
    { id: 'balance', tool: 'account_balance', args: {}, deps: [] },
    {
      id: 'preview',
      tool: 'transfer_preview',
      args: { amount: 800, payee: PAYEE, remark: '房租' },
      deps: ['balance'],
    },
    {
      id: 'pay',
      tool: 'transfer_create',
      args: { amount: 800, payee: PAYEE, remark: '房租' },
      deps: ['preview'],
    },
  ],
})

/** 扁平化的事件视图（测试只读 `type` 与几个字段，不关心判别联合的形状）。 */
interface FlatEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

const eventsOf = (app: BootedApp): readonly FlatEvent[] =>
  app.ctx
    .get(SESSION_SERVICE)
    .events()
    .map((event) => ({ type: event.type, data: event.data as unknown as Record<string, unknown> }))

const countOf = (events: readonly FlatEvent[], type: string): number =>
  events.filter((event) => event.type === type).length

/** 读 profile patch 的行（层 = profile-patch）。 */
function profileLayer(): ConfigLayer {
  const rows = parse(readFileSync(PATCH_PATH, 'utf8')) as readonly PluginRow[]
  return { layer: 'profile-patch', from: 'profiles/plan/patch.yml', rows }
}

interface Booted {
  readonly app: BootedApp
  readonly cleanup: () => void
}

async function bootPlan(extraLayers: readonly ConfigLayer[] = []): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'bah-plan-'))
  const bundle: Bundle = { name: 'base', rows: BASE_ROWS }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [profileLayer(), ...extraLayers],
    catalog: createCatalog(),
    run: { sessionId: asSessionId('s-plan'), now: () => 1_000, jsonlDir: dir },
  }
  return { app: await boot(options), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 覆盖某一行（层 = overlay）：`config` 是**整块替换**，必须写全该行的键。 */
const overlay = (rows: readonly PluginRow[]): ConfigLayer => ({
  layer: 'overlay',
  from: 'plan.test.ts',
  rows,
})

describe('plan:dag 配置校验', () => {
  it('默认值：32 节点 / 128 边 / 30 秒预算 / 非 dry-run / 单节点最多失败 3 次', () => {
    const settings = planPlugin.validate({})

    expect(settings.enabled).toBe(true)
    expect(settings.maxNodes).toBe(32)
    expect(settings.maxEdges).toBe(128)
    expect(settings.planTimeoutMs).toBe(30_000)
    expect(settings.dryRunDefault).toBe(false)
    expect(settings.ticketTtlMs).toBe(120_000)
    // 3 = 1 次原始运行 + 2 次 resume 重试；第 4 次失败后只能换新 planId
    expect(settings.maxNodeAttempts).toBe(3)
    // B1：模型入口默认关闭（不因为多了能力就放宽默认 profile）
    expect(settings.modelTools).toBe(false)
    expect(settings.modelMaxNodes).toBe(8)
  })

  it('B1 模型计划上限：modelMaxNodes 不得大于 maxNodes', () => {
    expect(planPlugin.validate({ modelTools: true, modelMaxNodes: 8 }).modelMaxNodes).toBe(8)
    expect(() => planPlugin.validate({ modelMaxNodes: 33 })).toThrowError(/modelMaxNodes/)
    expect(() => planPlugin.validate({ modelMaxNodes: 0 })).toThrowError(/modelMaxNodes/)
  })

  it('重试上限必须为正整数（0 会让"首次失败"就被判超限）', () => {
    expect(planPlugin.validate({ maxNodeAttempts: 5 }).maxNodeAttempts).toBe(5)
    expect(() => planPlugin.validate({ maxNodeAttempts: 0 })).toThrowError(/maxNodeAttempts/)
  })

  it('预算必须小于票据 TTL（超了就等于拿过期票据扣款）', () => {
    expect(() => planPlugin.validate({ planTimeoutMs: 120_000 })).toThrowError(/票据 TTL/)
    expect(() => planPlugin.validate({ planTimeoutMs: 30_000, ticketTtlMs: 30_000 })).toThrowError(
      /票据 TTL/,
    )
    expect(planPlugin.validate({ planTimeoutMs: 59_000 }).planTimeoutMs).toBe(59_000)
  })

  it('未知键 fail-loud（配置面不许有"写了但没人读"的键）', () => {
    expect(() => planPlugin.validate({ retry: 3 })).toThrowError(/retry/)
  })
})

describe('plan:dag 集成（真实依赖清单 + profile plan）', () => {
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

  it('3 节点全成功：3 条 tool/call、1 条 approval/asked、3 条 node-result', async () => {
    booted = await bootPlan()
    const api = booted.app.ctx.get(PLAN_SERVICE)

    const summary = await api.run(transferPlan('p-ok'))
    const events = eventsOf(booted.app)

    expect(summary.status).toBe('succeeded')
    expect(summary.succeeded).toBe(3)
    expect(countOf(events, 'tool/call')).toBe(3)
    // 试算是绿级直通，只有 transfer_create 走审批：一次审批 = 一次扣款
    expect(countOf(events, 'approval/asked')).toBe(1)
    expect(countOf(events, 'plan/node-result')).toBe(3)
    expect(events.find((event) => event.type === 'plan/completed')?.data).toMatchObject({
      planId: 'p-ok',
      status: 'succeeded',
      total: 3,
      succeeded: 3,
      failed: 0,
      blocked: 0,
    })
    // 节点的 callId 是 `${planId}#${nodeId}#1`：审计里能反查"这条 tool/call 属于哪个计划"
    expect(events.filter((event) => event.type === 'tool/call').map((event) => event.data['callId'])).toEqual([
      'p-ok#balance#1',
      'p-ok#preview#1',
      'p-ok#pay#1',
    ])
  })

  it('B1 模型闭环：plan_propose → plan_execute，3 节点各走一次管线、两次审批', async () => {
    const plan = transferPlan('p-model')
    booted = await bootPlan([
      overlay([
        {
          id: 'core:model',
          config: {
            provider: 'mock',
            model: 'mock-chat',
            script: [
              { tool: { id: 'call-propose', name: 'plan_propose', args: plan } },
              { tool: { id: 'call-execute', name: 'plan_execute', args: plan } },
              { text: '已按计划执行完毕。' },
            ],
          },
        },
        {
          id: 'core:agent',
          config: { channel: 'headless', loop: { model: 'mock:mock-chat', maxSteps: 8 } },
        },
      ]),
    ])
    const registry = booted.app.ctx.get(TOOLS_SERVICE)
    expect(registry.names()).toEqual(expect.arrayContaining(['plan_propose', 'plan_execute']))

    const agent = booted.app.ctx.get(AGENTS_SERVICE).list()[0]!
    agent.send('帮我分步：查余额、试算、给王建国转 800 元')
    await agent.run()

    const events = eventsOf(booted.app)
    const calls = events
      .filter((event) => event.type === 'tool/call')
      .map((event) => event.data)
    expect(calls.map((call) => call['name'])).toEqual([
      'plan_propose',
      'plan_execute',
      'account_balance',
      'transfer_preview',
      'transfer_create',
    ])
    // 外层 plan_execute 一次 + transfer_create 一次；查询/试算不审批
    expect(countOf(events, 'approval/asked')).toBe(2)
    expect(countOf(events, 'plan/created')).toBe(1)
    expect(countOf(events, 'plan/node-result')).toBe(3)
    expect(events.find((event) => event.type === 'plan/completed')?.data).toMatchObject({
      planId: 'p-model',
      status: 'succeeded',
      succeeded: 3,
    })

    // propose 只校验不执行：模型先拿到"尚未执行"，plan/created 在它之后才出现
    const proposeIndex = events.findIndex(
      (event) => event.type === 'tool/result' && event.data['name'] === 'plan_propose',
    )
    const createdIndex = events.findIndex((event) => event.type === 'plan/created')
    expect(proposeIndex).toBeGreaterThanOrEqual(0)
    expect(createdIndex).toBeGreaterThan(proposeIndex)
    expect(JSON.stringify(events[proposeIndex]?.data['content'])).toContain('尚未执行')
  })

  it('B1 非法 DAG：环 / 非银行工具 / 超节点数 / 空计划 全部 plan-invalid', async () => {
    booted = await bootPlan()
    const tool = booted.app.ctx.get(TOOLS_SERVICE).get('plan_propose')
    const toolCtx = {
      sessionId: asSessionId('s-plan'),
      callId: 'call-b1-invalid',
      signal: new AbortController().signal,
    }
    const issueCodesOf = async (args: unknown): Promise<readonly string[]> => {
      try {
        await tool.execute(args, toolCtx)
      } catch (error) {
        const detail = (error as BahError).detail as { issues?: readonly { code: string }[] }
        return (detail.issues ?? []).map((issue) => issue.code)
      }
      throw new Error('期望 plan-invalid，实际执行成功')
    }

    expect(
      await issueCodesOf({
        planId: 'p-cycle',
        nodes: [
          { id: 'a', tool: 'account_balance', args: {}, deps: ['b'] },
          { id: 'b', tool: 'account_balance', args: {}, deps: ['a'] },
        ],
      }),
    ).toContain('plan-cycle')
    expect(
      await issueCodesOf({
        planId: 'p-foreign',
        nodes: [{ id: 'x', tool: 'echo', args: {}, deps: [] }],
      }),
    ).toContain('plan-tool-not-allowed')
    expect(
      await issueCodesOf({
        planId: 'p-big',
        nodes: Array.from({ length: 9 }, (_, index) => ({
          id: `n-${String(index)}`,
          tool: 'account_balance',
          args: {},
          deps: [],
        })),
      }),
    ).toContain('plan-too-large')
    expect(await issueCodesOf({ planId: 'p-empty', nodes: [] })).toContain('plan-empty')

    // 四个都被拒：没有留下任何"计划跑过"的痕迹
    expect(countOf(eventsOf(booted.app), 'plan/created')).toBe(0)
  })

  /**
   * 为什么补：上一例只钉了"环 / 非银行工具 / 超节点 / 空计划"四条策略约束，
   * 而模型给的 JSON 是**不可信输入**——节点形态、id 字符集、tool/args/deps 的类型
   * 每一条都有独立的拒绝分支。漏一条的后果不是"报错不好看"，而是坏字段被
   * 原样带进执行器（例如 `deps: [1]` 让拓扑排序把数字当节点 id）。
   */
  it('B1 模型计划的字段类型逐项校验：非对象 / 坏 id / 缺 tool / args / deps / optional / idempotencyKey', async () => {
    booted = await bootPlan()
    const tool = booted.app.ctx.get(TOOLS_SERVICE).get('plan_propose')
    const toolCtx = {
      sessionId: asSessionId('s-plan'),
      callId: 'call-b1-types',
      signal: new AbortController().signal,
    }
    const issueCodesOf = async (args: unknown): Promise<readonly string[]> => {
      try {
        await tool.execute(args as never, toolCtx)
      } catch (error) {
        const detail = (error as BahError).detail as { issues?: readonly { code: string }[] }
        return (detail.issues ?? []).map((issue) => issue.code)
      }
      throw new Error('期望 plan-invalid，实际执行成功')
    }

    expect(await issueCodesOf(null)).toEqual(['plan-args-invalid'])
    expect(await issueCodesOf({ planId: 'p', nodes: [null] })).toEqual(['plan-args-invalid'])
    expect(
      await issueCodesOf({ planId: 'p', nodes: [{ id: 'bad id', tool: 'account_balance' }] }),
    ).toEqual(['plan-node-id'])
    expect(await issueCodesOf({ planId: 'p', nodes: [{ id: 'a' }] })).toEqual([
      'plan-tool-missing',
    ])
    expect(
      await issueCodesOf({
        planId: 'p',
        nodes: [{ id: 'a', tool: 'account_balance', args: [] }],
      }),
    ).toEqual(['plan-args-invalid'])
    expect(
      await issueCodesOf({
        planId: 'p',
        nodes: [{ id: 'a', tool: 'account_balance', deps: [1] }],
      }),
    ).toEqual(['plan-dep-missing'])
    expect(
      await issueCodesOf({
        planId: 'p',
        nodes: [{ id: 'a', tool: 'account_balance', optional: 'yes' }],
      }),
    ).toEqual(['plan-args-invalid'])
    expect(
      await issueCodesOf({
        planId: 'p',
        nodes: [{ id: 'a', tool: 'account_balance', idempotencyKey: 1 }],
      }),
    ).toEqual(['plan-args-invalid'])
    expect(
      await issueCodesOf({ planId: '', nodes: [{ id: 'a', tool: 'account_balance' }] }),
    ).toEqual(['plan-id-invalid'])

    // 合法侧：planId 首尾空白被裁剪、meta.title 透传（未知 meta 键被忽略）
    const proposal = (await tool.execute(
      {
        planId: ' p-meta ',
        meta: { title: '两步转账', junk: 1 },
        nodes: [{ id: 'a', tool: 'account_balance', args: {}, deps: [] }],
      },
      toolCtx,
    )) as { planId: string }
    expect(proposal.planId).toBe('p-meta')
    // propose 只校验不执行：没有产生任何"计划跑过"的痕迹
    expect(countOf(eventsOf(booted.app), 'plan/created')).toBe(0)
  })

  it('第 2 节点失败：第 3 节点没有 tool/call，落 node-blocked，completed 判 failed', async () => {
    booted = await bootPlan()
    const api = booted.app.ctx.get(PLAN_SERVICE)
    const plan: Plan = {
      planId: 'p-fail',
      nodes: [
        { id: 'balance', tool: 'account_balance', args: {}, deps: [] },
        // 负数金额会被治理平面执行前拒绝（不签发票据）
        { id: 'bad', tool: 'transfer_create', args: { amount: -1, payee: { name: 'x' } }, deps: ['balance'] },
        { id: 'after', tool: 'transfer_preview', args: { amount: 800, payee: PAYEE }, deps: ['bad'] },
      ],
    }

    const summary = await api.run(plan)
    const events = eventsOf(booted.app)

    expect(summary.status).toBe('failed')
    expect(summary.failed).toBe(1)
    expect(summary.blocked).toBe(1)
    // 第 3 节点一次都没进管线
    expect(events.filter((event) => event.type === 'tool/call').map((event) => event.data['name'])).toEqual([
      'account_balance',
      'transfer_create',
    ])
    const blocked = events.find((event) => event.type === 'plan/node-blocked')
    expect(blocked?.data).toMatchObject({
      planId: 'p-fail',
      nodeId: 'after',
      blockedBy: ['bad'],
      reason: 'upstream-failed',
    })
    expect(events.find((event) => event.type === 'plan/completed')?.data).toMatchObject({
      status: 'failed',
      blocked: 1,
      succeeded: 1,
    })
  })

  it('dry-run：tool/call 与 approval/* 都是 0，node-result 仍是 3 条', async () => {
    booted = await bootPlan()
    const api = booted.app.ctx.get(PLAN_SERVICE)

    const summary = await api.run(transferPlan('p-dry'), { dryRun: true })
    const events = eventsOf(booted.app)

    expect(summary.status).toBe('succeeded')
    expect(summary.skipped).toBe(3)
    expect(countOf(events, 'tool/call')).toBe(0)
    expect(countOf(events, 'tool/result')).toBe(0)
    expect(events.filter((event) => event.type.startsWith('approval/'))).toHaveLength(0)
    expect(countOf(events, 'plan/node-result')).toBe(3)
    // dry-run 不进"已完成的 run 表"：snapshot 查不到，不会被当成真实执行留档
    expect(api.snapshot('p-dry')).toBeUndefined()
  })

  it('审批拒绝：decided 记 rejected，节点 failed(approval-rejected)，下游 blocked', async () => {
    booted = await bootPlan([
      overlay([
        {
          id: 'interaction:approval',
          config: { responder: 'headless', autoDecision: 'reject', autoVerify: true },
        },
      ]),
    ])
    const api = booted.app.ctx.get(PLAN_SERVICE)
    const plan: Plan = {
      planId: 'p-reject',
      nodes: [
        { id: 'balance', tool: 'account_balance', args: {}, deps: [] },
        { id: 'pay', tool: 'transfer_create', args: { amount: 800, payee: PAYEE }, deps: ['balance'] },
        { id: 'notify', tool: 'account_list', args: {}, deps: ['pay'] },
      ],
    }

    await api.run(plan)
    const events = eventsOf(booted.app)

    expect(events.find((event) => event.type === 'approval/decided')?.data).toMatchObject({
      decision: 'rejected',
    })
    const payResult = events.find(
      (event) => event.type === 'plan/node-result' && event.data['nodeId'] === 'pay',
    )
    expect(payResult?.data).toMatchObject({ status: 'failed', code: 'approval-rejected' })
    expect(countOf(events, 'plan/node-blocked')).toBe(1)
    expect(events.find((event) => event.type === 'plan/completed')?.data).toMatchObject({
      status: 'failed',
      failed: 1,
      blocked: 1,
    })
  })

  it('取消：plan/aborted 恰好 1 条，completed 记 aborted，剩余节点算 cancelled', async () => {
    booted = await bootPlan()
    const api: PlanApi = booted.app.ctx.get(PLAN_SERVICE)

    const running = api.run(transferPlan('p-cancel'))
    // run() 已经进到第一个节点（同步推进到管线内部），此刻取消 = 取消"下一个节点"
    expect(api.cancel('p-cancel')).toBe(true)
    const summary = await running
    const events = eventsOf(booted.app)

    expect(summary.status).toBe('aborted')
    expect(countOf(events, 'plan/aborted')).toBe(1)
    expect(events.find((event) => event.type === 'plan/aborted')?.data).toMatchObject({
      reason: 'cancelled',
    })
    expect(events.find((event) => event.type === 'plan/completed')?.data).toMatchObject({
      status: 'aborted',
    })
    // 五个计数之和必须等于 total（没有节点留在 pending）
    expect(summary.succeeded + summary.failed + summary.skipped + summary.blocked + summary.cancelled).toBe(
      summary.total,
    )
    expect(summary.cancelled).toBeGreaterThan(0)
  })

  it('TC-W10-02 续跑只跑剩余节点：已 succeeded 的节点不再产生 tool/call', async () => {
    booted = await bootPlan()
    const api = booted.app.ctx.get(PLAN_SERVICE)
    const plan = transferPlan('p-resume')

    const running = api.run(plan)
    // 首个节点已进入管线，此刻取消 = 取消"下一个节点"（取消只在节点之间生效）
    expect(api.cancel('p-resume')).toBe(true)
    const first = await running
    const afterFirst = eventsOf(booted.app)

    expect(first.status).toBe('aborted')
    expect(first.succeeded).toBe(1)
    expect(first.cancelled).toBe(2)
    expect(countOf(afterFirst, 'tool/call')).toBe(1)

    const summary = await api.resume(plan)
    const events = eventsOf(booted.app)

    expect(summary.status).toBe('succeeded')
    expect(summary.succeeded).toBe(3)
    // 续跑恰好补上剩下两个节点：balance 若被重跑，这里就是 4
    expect(countOf(events, 'tool/call')).toBe(3)
    expect(events.filter((event) => event.type === 'tool/call').map((event) => event.data['name'])).toEqual([
      'account_balance',
      'transfer_preview',
      'transfer_create',
    ])
    // 被跳过的节点一条 node-started 都不该多出来
    expect(
      events.filter((event) => event.type === 'plan/node-started' && event.data['nodeId'] === 'balance'),
    ).toHaveLength(1)

    // TC-W10-07：plan/resumed 真的落进会话（appendDomain），载荷与冻结表逐字一致
    expect(countOf(events, 'plan/resumed')).toBe(1)
    expect(events.find((event) => event.type === 'plan/resumed')?.data).toMatchObject({
      planId: 'p-resume',
      skipped: 1,
      resumedFrom: [],
    })
  })

  it('TC-W10-01 续跑一份改过的计划 → plan-identity-mismatch，一个节点都不跑', async () => {
    booted = await bootPlan()
    const api = booted.app.ctx.get(PLAN_SERVICE)
    const plan = transferPlan('p-tamper')
    const first = await api.run(plan)
    expect(first.succeeded).toBe(3)
    const settled = eventsOf(booted.app).length

    const tampered: Plan = {
      planId: 'p-tamper',
      nodes: plan.nodes.map((item) =>
        item.id === 'pay' ? { ...item, args: { ...item.args, amount: 801 } } : item,
      ),
    }
    await expect(api.resume(tampered)).rejects.toMatchObject({ code: 'plan-identity-mismatch' })
    // 拒绝续跑不许留下"跑过"的痕迹
    expect(eventsOf(booted.app)).toHaveLength(settled)
  })

  it('TC-W10-09 from 指向不存在的节点 → plan-resume-target-missing', async () => {
    booted = await bootPlan()
    const api = booted.app.ctx.get(PLAN_SERVICE)
    const plan = transferPlan('p-missing')
    await api.run(plan)

    await expect(api.resume(plan, { from: ['no-such-node'] })).rejects.toMatchObject({
      code: 'plan-resume-target-missing',
    })
  })

  it('未装配 plan:dag 的 profile：拿不到 bah:plan（默认 profile 零影响的证据）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-plan-off-'))
    const app = await boot({
      profile: PROFILE,
      bundles: [{ name: 'base', rows: BASE_ROWS }],
      // ★ 唯一区别：不加 profile patch，因此没有 plan:dag 这一行
      layers: [],
      catalog: createCatalog(),
      run: { sessionId: asSessionId('s-plan-off'), now: () => 1_000, jsonlDir: dir },
    })
    try {
      // service-missing 是内核的 fail-loud 码：`get` 不返回 undefined，也不静默降级
      let missing: unknown
      try {
        app.ctx.get(PLAN_SERVICE)
      } catch (error) {
        missing = error
      }
      expect(missing).toMatchObject({ code: 'service-missing' })
      expect(String((missing as { message?: string }).message)).toContain('未注册')
    } finally {
      await app.dispose('test-done')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TC-W12-06 profile patch 里 saga-bridge 是关掉的（配置断言：否则 transfer_create 会被双层展开）', () => {
    const rows = parse(readFileSync(PATCH_PATH, 'utf8')) as readonly PluginRow[]
    const bridge = rows.find((row) => row.id === 'bank:saga-bridge')
    const plan = rows.find((row) => row.id === 'plan:dag')

    expect(bridge?.config).toMatchObject({ enabled: false })
    expect(plan?.use).toBe('plan:dag')
    expect(plan?.config).toMatchObject({ enabled: true })
  })

  it('总开关关掉：行装配了 `plan:dag`，但拿不到服务（`enabled: false` 等价于没装）', async () => {
    booted = await bootPlan([
      overlay([{ id: 'plan:dag', use: 'plan:dag', config: { enabled: false } }]),
    ])

    let missing: unknown
    try {
      booted.app.ctx.get(PLAN_SERVICE)
    } catch (error) {
      missing = error
    }
    expect(missing).toMatchObject({ code: 'service-missing' })
  })
})

/* ── W11：三件事在**真实装配**下的接缝 ─────────────────────────────── */

describe('plan:dag · W11 接缝（incident / node-waiting / 动态 args）', () => {
  let booted: Booted | undefined

  afterEach(() => {
    booted?.cleanup()
    booted = undefined
  })

  it('TC-W11-06 审批等待落 node-waiting：恰好 1 条，nodeId 是走审批的那个节点', async () => {
    booted = await bootPlan()
    const api: PlanApi = booted.app.ctx.get(PLAN_SERVICE)

    await api.run(transferPlan('p-wait'))
    const waiting = eventsOf(booted.app).filter((event) => event.type === 'plan/node-waiting')

    // 三个节点里只有 transfer_create 走审批（黄级）
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.data['nodeId']).toBe('pay')
    // 注入钟测出来的数：非负整数（精确值由引擎单测钉，这里只证明"真的接了管线的钟"）
    const waitedMs = waiting[0]?.data['waitedMs']
    expect(typeof waitedMs).toBe('number')
    expect(Number.isInteger(waitedMs)).toBe(true)
    expect(waitedMs as number).toBeGreaterThanOrEqual(0)
  })

  it('incident：工具报 upstream-unavailable → 节点落第 9 态，completed 判 failed，resume 能重跑', async () => {
    booted = await bootPlan()
    const api: PlanApi = booted.app.ctx.get(PLAN_SERVICE)

    let down = true
    booted.app.ctx.get(TOOLS_SERVICE).register({
      name: 'probe_down',
      description: '模拟外部依赖不可用（可手动恢复）',
      schema: { type: 'object' },
      tier: { level: 'green' },
      execute: async () => {
        if (down) throw new BahError('upstream-unavailable', '核心系统不可用')
        return { ok: true }
      },
    })

    const plan: Plan = { planId: 'p-inc', nodes: [{ id: 'only', tool: 'probe_down', args: {}, deps: [] }] }
    const first = await api.run(plan)

    expect(first.status).toBe('failed')
    expect(api.snapshot('p-inc')?.nodes[0]?.state).toBe('incident')
    // 载荷仍是三值里的 failed，区分靠 code（引擎自己写的那个常量）
    const result = eventsOf(booted.app).find(
      (event) => event.type === 'plan/node-result' && event.data['nodeId'] === 'only',
    )
    expect(result?.data['status']).toBe('failed')
    expect(result?.data['code']).toBe(PLAN_INCIDENT_CODE)

    // 外部恢复后显式 resume：incident 自动回 pending 并重跑（不需要 from）
    down = false
    const second = await api.resume(plan)
    expect(second.status).toBe('succeeded')
    expect(api.snapshot('p-inc')?.nodes[0]?.state).toBe('succeeded')
  })

  it('并发同一 planId：第二次被拒后**还回**第一次的 guard，正在跑的 run 不撞 plan-guard-missing', async () => {
    booted = await bootPlan()
    const api: PlanApi = booted.app.ctx.get(PLAN_SERVICE)

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    booted.app.ctx.get(TOOLS_SERVICE).register({
      name: 'probe_slow',
      description: '模拟慢工具：用于制造同 planId 的并发窗口',
      schema: { type: 'object' },
      tier: { level: 'green' },
      execute: async () => {
        started()
        await gate
        return { ok: true }
      },
    })

    const plan: Plan = { planId: 'p-conc', nodes: [{ id: 'only', tool: 'probe_slow', args: {}, deps: [] }] }
    const first = api.run(plan)
    await running

    await expect(api.run(plan)).rejects.toMatchObject({ code: 'plan-already-running' })

    // 第二次的 finally 若把正在跑的 guard 删掉，这里就会撞 plan-guard-missing
    release()
    await expect(first).resolves.toMatchObject({ status: 'succeeded' })
    // 槽位完全归还：再跑一次仍能正常拿到新 guard
    await expect(api.run(plan)).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('动态 args 端到端：取的是**结构化原值**，不是 projectContent 渲染出来的文本', async () => {
    booted = await bootPlan()
    const api: PlanApi = booted.app.ctx.get(PLAN_SERVICE)

    const registry = booted.app.ctx.get(TOOLS_SERVICE)
    let settleArgs: Record<string, unknown> | undefined
    registry.register({
      name: 'probe_quote',
      description: '模拟试算：结构化结果与渲染文本不同',
      schema: { type: 'object' },
      tier: { level: 'green' },
      execute: async () => ({ quoteId: 'Q-1', amountCents: 80_000 }),
      // 渲染投影刻意只给一句人话：`${node.quote.quoteId}` 若能取到 Q-1，
      // 就证明 output 走的是 result.value 而不是 content
      projectContent: () => [{ type: 'text', text: '报价已生成，请确认' }],
    })
    registry.register({
      name: 'probe_settle',
      description: '模拟落单：记录收到的 quoteId',
      schema: { type: 'object' },
      tier: { level: 'green' },
      execute: async (args) => {
        settleArgs = args as Record<string, unknown>
        return { settled: true }
      },
    })

    const plan: Plan = {
      planId: 'p-args',
      nodes: [
        { id: 'quote', tool: 'probe_quote', args: {}, deps: [] },
        { id: 'settle', tool: 'probe_settle', args: { quoteId: '${node.quote.quoteId}' }, deps: ['quote'] },
      ],
    }
    const summary = await api.run(plan)

    expect(summary.status).toBe('succeeded')
    expect(settleArgs).toEqual({ quoteId: 'Q-1' })
    // 真实管线里也该是解析后的值（tool/call 落的是结算入参，不是模板原文）
    const call = eventsOf(booted.app).find(
      (event) => event.type === 'tool/call' && event.data['name'] === 'probe_settle',
    )
    expect((call?.data['args'] as Record<string, unknown>)['quoteId']).toBe('Q-1')
    // plan 域里一个字都不许出现模板原文
    expect(JSON.stringify(eventsOf(booted.app).filter((event) => event.type.startsWith('plan/')))).not.toContain(
      '${node.',
    )
  })
})
