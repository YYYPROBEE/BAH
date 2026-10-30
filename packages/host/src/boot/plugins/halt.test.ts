/**
 * W07 · HALT 闭环（HP-3）的宿主级验收。
 *
 * 覆盖 TC-W07-01…07：
 * - 三处全拒：新 turn（agent.send）/ 工具执行（ToolPipeline）/ plan 节点（宿主拦截）；
 * - 解除只能凭会话内 U 盾 MFA 审批票据（没有审批面 = 不签票）；
 * - 两个 `safety/*` 事件按冻结载荷落账；
 * - 重复 HALT / 重复解除幂等；
 * - P0 累计 3 次触发（destructive / exfil 族）。
 *
 * TC-W07-08/09 是 `rules.ts` / `plan/engine.ts` 的 diff=0（见施工台账 §65 的取证命令，台账已撤下）；
 * TC-W07-10 是反向验证：把闸从"next() 之前"挪到签票之后 → TC-02 必红。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HALT_SERVICE, type HaltHandle } from '@bah/safety'
import {
  AGENTS_SERVICE,
  SESSION_SERVICE,
  TOOLS_SERVICE,
  ToolGuard,
  ToolPipeline,
  type Plan,
} from '@bah/runtime'
import { asSessionId } from '@bah/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AnySessionEvent, PlanApi } from '@bah/runtime'

import { boot, type BootOptions, type BootedApp } from '../boot.ts'
import { createCatalog } from './index.ts'
import { PLAN_SERVICE } from './plan.ts'
import type { PluginRow } from '../profile-plugins.ts'
import { testRunContext } from '../test-run-context.ts'

let sessionDir = ''
let bootSeq = 0

beforeAll(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'bah-halt-'))
})

afterAll(() => {
  rmSync(sessionDir, { recursive: true, force: true })
})

/** boot 参数：`halt` 是 safety:sentry.halt 段；`responder` 控制有没有 MFA 面。 */
interface BootWithOptions {
  readonly halt?: Readonly<Record<string, unknown>>
  readonly responder?: 'headless' | 'none'
  /** 省略 `interaction:approval`（覆盖"没有审批服务"的 fail-closed 分支）。 */
  readonly approval?: false
  /** 自动应答结论（覆盖审批拒绝时 `approval/decided.reason` 的分支）。 */
  readonly decision?: 'allow' | 'reject'
  /** 省略 `safety:sentry`（覆盖 plan 的惰性缺省分支）。 */
  readonly sentry?: false
}

/** 默认行：与 headless 演示同构（审批自动放行 + 自动验 U 盾）。 */
function rows(options: BootWithOptions): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    {
      id: 'core:model',
      config: { provider: 'mock', model: 'mock-chat', chunkSize: 8, script: [{ text: '收到' }] },
    },
    { id: 'core:agent', config: { channel: 'headless', loop: { model: 'mock:mock-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
    { id: 'audit:decisions' },
    { id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' } },
    ...(options.approval === false
      ? []
      : [
          {
            id: 'interaction:approval',
            config:
              options.responder === 'none'
                ? { responder: 'none' }
                : {
                    responder: 'headless',
                    autoDecision: options.decision ?? 'allow',
                    autoVerify: true,
                  },
          },
        ]),
    ...(options.sentry === false
      ? []
      : [
          {
            id: 'safety:sentry',
            config: {
              // W08：trace.sink 无缺省值（夹具显式选 memory，避免写盘）
              trace: { sink: 'memory' },
              ...(options.halt === undefined ? {} : { halt: options.halt }),
            },
          },
        ]),
    { id: 'plan:dag', config: { enabled: true } },
  ]
}

/** 一次 boot 及其可推进的注入钟。 */
interface Booted {
  readonly app: BootedApp
  readonly advance: (ms: number) => void
}

async function bootWith(options: BootWithOptions = {}): Promise<Booted> {
  bootSeq += 1
  // C3 起 `safety:sentry` 会把停机状态落到租户根：`jsonlDir/<tenant>/halt.json`；本文件的用例共用同一个
  // 临时目录，所以**每次 boot 前必须清掉它**，否则"上一个用例停过机"会变成下一个用例的
  // 初始状态（跨重启恢复的语义由 `sentry.test.ts` 的 C3 组专门覆盖）。
  rmSync(join(sessionDir, 'demo', 'halt.json'), { force: true })
  let now = 1_792_000_000_000
  const bootOptions: BootOptions = {
    profile: { name: 'fx-halt', bundles: ['fx-halt'], hmr: false },
    bundles: [{ name: 'fx-halt', rows: rows(options) }],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({
      sessionId: asSessionId(`s-halt-${String(bootSeq)}`),
      now: () => now,
      jsonlDir: sessionDir,
    }),
  }
  const app = await boot(bootOptions)
  return {
    app,
    advance: (ms) => {
      now += ms
    },
  }
}

/** 扁平事件视图。 */
function eventsOf(app: BootedApp): readonly {
  readonly type: string
  readonly data: Record<string, unknown>
}[] {
  return app.ctx.get(SESSION_SERVICE).events().map((event: AnySessionEvent) => ({
    type: event.type,
    data: event.data as unknown as Record<string, unknown>,
  }))
}

const countOf = (events: readonly { type: string }[], type: string): number =>
  events.filter((event) => event.type === type).length

/** 直接调七段管线（绕过主循环）。 */
function pipelineOf(app: BootedApp): ToolPipeline {
  const session = app.ctx.get(SESSION_SERVICE)
  return new ToolPipeline({
    ctx: app.ctx,
    registry: app.ctx.get(TOOLS_SERVICE),
    session,
    guard: new ToolGuard(),
    sessionId: session.sessionId,
  })
}

const haltOf = (app: BootedApp): HaltHandle => app.ctx.get(HALT_SERVICE)

/** 一笔会走 ask 的黄级转账（HALT 时应在签票之前被拒）。 */
const TRANSFER = {
  amount: 800,
  payee: { name: '王建国', phone: '13900002222' },
} as const

/** 一条计划：两个只读节点（HALT 时一个都不许跑）。 */
const PLAN: Plan = {
  planId: 'halt-plan-1',
  nodes: [
    { id: 'balance', tool: 'account_balance', args: {}, deps: [] },
    { id: 'accounts', tool: 'account_list', args: {}, deps: [] },
  ],
}

describe('TC-W07-01 新 turn 直接抛 safety-halted', () => {
  it('send() 抛错且不产生 tool/call / turn/start', async () => {
    const { app } = await bootWith()
    try {
      haltOf(app).halt('manual', '演练')
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      expect(() => agent.send('给王建国转 800 元')).toThrowError(
        expect.objectContaining({ code: 'safety-halted' }),
      )
      const events = eventsOf(app)
      expect(countOf(events, 'tool/call')).toBe(0)
      expect(countOf(events, 'turn/start')).toBe(0)
    } finally {
      await app.dispose('test')
    }
  })
})

describe('TC-W07-02 工具执行在 next() 之前被拒（无票据）', () => {
  it('直接调 ToolPipeline → isError / safety-halted / 无 ticket/issued', async () => {
    const { app } = await bootWith()
    try {
      haltOf(app).halt('manual', '演练')
      const execution = await pipelineOf(app).execute({
        callId: 'halt-call-1',
        name: 'transfer_create',
        args: TRANSFER,
      })
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('safety-halted')

      const events = eventsOf(app)
      expect(countOf(events, 'ticket/issued')).toBe(0)
      expect(countOf(events, 'approval/asked')).toBe(0)
      expect(events.some((event) => event.type === 'safety/halt')).toBe(true)
    } finally {
      await app.dispose('test')
    }
  })
})

describe('TC-W07-03 plan 在宿主层被拦截（引擎零改动）', () => {
  it('零 node-started / 零 tool/call；completed=aborted + aborted=halted', async () => {
    const { app } = await bootWith()
    try {
      haltOf(app).halt('manual', '演练')
      const plan = app.ctx.get(PLAN_SERVICE) as PlanApi
      const summary = await plan.run(PLAN)

      expect(summary.status).toBe('aborted')
      expect(summary.total).toBe(2)
      expect(summary.cancelled).toBe(2)
      expect(summary.succeeded).toBe(0)

      const events = eventsOf(app)
      expect(countOf(events, 'plan/node-started')).toBe(0)
      expect(countOf(events, 'plan/node-result')).toBe(0)
      expect(countOf(events, 'tool/call')).toBe(0)
      // 计划根本没开始：连 plan/created 都不落（没有伪造"已开始"）
      expect(countOf(events, 'plan/created')).toBe(0)

      const completed = events.find((event) => event.type === 'plan/completed')
      expect(completed?.data).toMatchObject({
        planId: PLAN.planId,
        status: 'aborted',
        total: 2,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        skipped: 0,
        cancelled: 2,
        durationMs: 0,
      })
      const aborted = events.find((event) => event.type === 'plan/aborted')
      expect(aborted?.data).toMatchObject({ planId: PLAN.planId, reason: 'halted' })
    } finally {
      await app.dispose('test')
    }
  })
})

describe('TC-W10-HALT 停机期间 resume 也被拦（HALT 面不能被续跑绕过）', () => {
  it('resume 返回 aborted、零 plan/resumed、零新 tool/call', async () => {
    const { app } = await bootWith()
    try {
      const plan = app.ctx.get(PLAN_SERVICE) as PlanApi
      // 先跑完一次，留下可续跑的历史；否则 resume 会先撞 plan-replay-incomplete
      expect((await plan.run(PLAN)).status).toBe('succeeded')
      const settledCalls = countOf(eventsOf(app), 'tool/call')

      haltOf(app).halt('manual', '演练')
      const summary = await plan.resume(PLAN)

      expect(summary.status).toBe('aborted')
      expect(summary.succeeded).toBe(0)
      expect(summary.cancelled).toBe(PLAN.nodes.length)

      const events = eventsOf(app)
      // 续跑根本没开始：一个起点事件都不落
      expect(countOf(events, 'plan/resumed')).toBe(0)
      expect(countOf(events, 'plan/node-started')).toBe(settledCalls)
      expect(countOf(events, 'tool/call')).toBe(settledCalls)
      expect(events.filter((event) => event.type === 'plan/aborted').at(-1)?.data).toMatchObject({
        planId: PLAN.planId,
        reason: 'halted',
      })
    } finally {
      await app.dispose('test')
    }
  })
})

describe('TC-W07-04 / 05 / 06 解除只凭会话内 MFA 票据', () => {
  it('未知票据 / mfa=false / 已过期 都拒绝，状态仍 HALTED', async () => {
    const { app, advance } = await bootWith()
    try {
      const halt = haltOf(app)
      halt.halt('manual')

      expect(halt.unfreeze('t-missing')).toEqual({ ok: false, code: 'halt-ticket-unknown' })
      expect(halt.halted).toBe(true)

      halt.registerTicket({
        ticketId: 't-no-mfa',
        status: 'approved',
        expiresAt: 1_792_000_000_000 + 60_000,
        mfa: false,
      })
      expect(halt.unfreeze('t-no-mfa')).toEqual({ ok: false, code: 'halt-ticket-mfa-required' })
      expect(halt.halted).toBe(true)

      const requested = await halt.requestUnfreeze()
      expect(requested.ok).toBe(true)
      if (!requested.ok) throw new Error('unreachable')
      advance(120_000)
      expect(halt.unfreeze(requested.ticketId)).toEqual({ ok: false, code: 'halt-ticket-expired' })
      expect(halt.halted).toBe(true)
    } finally {
      await app.dispose('test')
    }
  })

  it('有效票据解除 → RUNNING；两个事件载荷逐字冻结；重复操作不落重复事件', async () => {
    const { app } = await bootWith()
    try {
      const at = 1_792_000_000_000
      const halt = haltOf(app)
      expect(halt.halt('manual', '演练')).toBe(true)
      // 重复 HALT：幂等
      expect(halt.halt('chain-broken')).toBe(false)

      const requested = await halt.requestUnfreeze()
      expect(requested.ok).toBe(true)
      if (!requested.ok) throw new Error('unreachable')

      expect(halt.unfreeze(requested.ticketId)).toEqual({ ok: true })
      expect(halt.status).toBe('RUNNING')
      // 重复解除：幂等
      expect(halt.unfreeze(requested.ticketId)).toEqual({ ok: false, code: 'halt-not-halted' })

      const events = eventsOf(app)
      expect(countOf(events, 'safety/halt')).toBe(1)
      expect(countOf(events, 'safety/unfreeze')).toBe(1)
      expect(events.find((event) => event.type === 'safety/halt')?.data).toEqual({
        reason: 'manual',
        detail: '演练',
        at,
      })
      expect(events.find((event) => event.type === 'safety/unfreeze')?.data).toEqual({
        ticketId: requested.ticketId,
        mfa: true,
        at,
      })

      // 解除后新 turn 正常入队，且能真的跑完一轮：
      // 日志里已有 `safety/halt` / `safety/unfreeze` 两个非平台事件，`deriveMessages`
      // 必须按 `ignorable` 跳过它们（否则下一条请求会报 session-unknown-event）。
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      expect(() => agent.send('查一下余额')).not.toThrow()
      await expect(agent.run()).resolves.toBeUndefined()
      const afterTurn = eventsOf(app)
      expect(afterTurn.filter((event) => event.type === 'turn/start')).toHaveLength(1)
      expect(afterTurn.filter((event) => event.type === 'turn/end')).toHaveLength(1)
      // 工具也恢复（黄级转账走审批 → headless 自动放行）
      const execution = await pipelineOf(app).execute({
        callId: 'after-unfreeze',
        name: 'transfer_create',
        args: TRANSFER,
      })
      expect(execution.result.isError).toBe(false)
    } finally {
      await app.dispose('test')
    }
  })

  it('没有应答者（responder: none）→ 不签票，返回 halt-approval-rejected', async () => {
    const { app } = await bootWith({ responder: 'none' })
    try {
      const halt = haltOf(app)
      halt.halt('manual')
      expect(await halt.requestUnfreeze()).toEqual({
        ok: false,
        code: 'halt-approval-rejected',
      })
      expect(halt.halted).toBe(true)
    } finally {
      await app.dispose('test')
    }
  })
})

describe('P0 命中 3 次触发 HALT（写死阈值）', () => {
  it('destructive 族连续 3 次 → safety/halt reason=p0-threshold', async () => {
    const { app } = await bootWith()
    try {
      for (let index = 1; index <= 3; index += 1) {
        const execution = await pipelineOf(app).execute({
          callId: `p0-${String(index)}`,
          name: 'account_balance',
          args: { note: 'sudo rm -rf /' },
        })
        expect(execution.result.isError).toBe(true)
      }
      const halt = haltOf(app)
      expect(halt.halted).toBe(true)
      expect(halt.reason).toBe('p0-threshold')
      const event = eventsOf(app).find((item) => item.type === 'safety/halt')
      expect(event?.data).toMatchObject({ reason: 'p0-threshold' })
    } finally {
      await app.dispose('test')
    }
  })
})

describe('惰性缺省与 fail-closed 边界', () => {
  it('没有 safety:sentry 的装配：plan 照常执行（不因缺服务起不来 / 不误拦）', async () => {
    const { app } = await bootWith({ sentry: false })
    try {
      const plan = app.ctx.get(PLAN_SERVICE) as PlanApi
      const summary = await plan.run({
        planId: 'no-halt-plan',
        nodes: [{ id: 'balance', tool: 'account_balance', args: {}, deps: [] }],
      })
      expect(summary.status).toBe('succeeded')
      expect(summary.succeeded).toBe(1)
      expect(countOf(eventsOf(app), 'plan/node-started')).toBe(1)
    } finally {
      await app.dispose('test')
    }
  })

  it('没有 interaction:approval：申请解除 → halt-approval-rejected（不造票）', async () => {
    const { app } = await bootWith({ approval: false })
    try {
      const halt = haltOf(app)
      halt.halt('manual')
      expect(await halt.requestUnfreeze()).toEqual({
        ok: false,
        code: 'halt-approval-rejected',
      })
      expect(halt.halted).toBe(true)
      expect(countOf(eventsOf(app), 'approval/asked')).toBe(0)
    } finally {
      await app.dispose('test')
    }
  })

  it('审批被拒：approval/decided 带 reason 与 code，申请解除 fail-closed', async () => {
    const { app } = await bootWith({ decision: 'reject' })
    try {
      const halt = haltOf(app)
      halt.halt('manual')
      expect(await halt.requestUnfreeze()).toEqual({
        ok: false,
        code: 'halt-approval-rejected',
      })
      const decided = eventsOf(app).find((event) => event.type === 'approval/decided')
      expect(decided?.data).toMatchObject({
        decision: 'rejected',
        reason: 'headless-reject',
        code: 'approval-rejected',
      })
      expect(halt.halted).toBe(true)
    } finally {
      await app.dispose('test')
    }
  })
})
