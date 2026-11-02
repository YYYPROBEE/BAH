/**
 * 引擎单测（方案 §4.6：engine 7 例 + 3 例补充）。
 *
 * 必测的那一条：菱形图 `A → B,C → D`，A 失败时 `D.blockedBy = ['B','C']` 且 `D` 是
 * `blocked` 而不是 `pending`——它能抓出 90% 的传播 bug（只传一层 / 只记直接 failed 上游）。
 */

import { describe, expect, it } from 'vitest'

import { PlanEngine, planDigest, replayPlan, type PlanEngineOptions } from './engine.ts'
import { PLAN_ARGS_UNRESOLVED_CODE, PLAN_INCIDENT_CODE, PLAN_RESUME_ERRORS } from './types.ts'

import type { PlanEventRecord, PlanEventType } from './events.ts'
import type { Plan, PlanInvoker, PlanNode, PlanNodeState } from './types.ts'

interface Recorded {
  readonly type: PlanEventType
  readonly data: Record<string, unknown>
}

const node = (
  id: string,
  deps: readonly string[] = [],
  extra: Partial<PlanNode> = {},
): PlanNode => ({ id, tool: 'account_balance', args: {}, deps, ...extra })

const linear = (): Plan => ({
  planId: 'p-linear',
  nodes: [
    node('check', [], { tool: 'account_balance' }),
    node(
      'preview',
      ['check'],
      { tool: 'transfer_preview', args: { amount: 800, payee: { name: '王建国' } } },
    ),
    node('pay', ['preview'], { tool: 'transfer_create', args: { amount: 800 } }),
  ],
})

/** A 失败会向下传两级：B/C（dep A）→ D（dep B,C）。 */
const diamond = (): Plan => ({
  planId: 'p-diamond',
  nodes: [
    node('A'),
    node('B', ['A']),
    node('C', ['A']),
    node('D', ['B', 'C']),
  ],
})

interface HarnessOptions {
  readonly fail?: readonly string[]
  /** 这些节点返回 `incident: true`（宿主声明"外部不可用"），并带一个**故意不同**的 code。 */
  readonly incident?: readonly string[]
  /** 节点 id → 审批等待毫秒数（由 invoker 回传，模拟宿主用注入钟测出来的值）。 */
  readonly waited?: Readonly<Record<string, number>>
  /** 节点 id → 工具返回值（动态 args 的取值源）。 */
  readonly output?: Readonly<Record<string, unknown>>
  readonly invoker?: PlanInvoker
  readonly shouldPersist?: PlanEngineOptions['shouldPersist']
}

function harness(options: HarnessOptions = {}) {
  const events: Recorded[] = []
  const calls: string[] = []
  const failing = new Set(options.fail ?? [])
  const incident = new Set(options.incident ?? [])
  const fallback: PlanInvoker = async (target) => {
    calls.push(target.id)
    const waited = options.waited?.[target.id]
    const wait = waited === undefined ? {} : { waitedMs: waited }
    // code 故意给 `provider-down`：引擎必须**自己**把它改写成 `PLAN_INCIDENT_CODE`，
    // 否则"码的集合由引擎封闭"这句话就是空话（工具返回什么都可能污染状态）。
    if (incident.has(target.id))
      return { isError: true, incident: true, code: 'provider-down', summary: 'down', ...wait }
    if (failing.has(target.id)) return { isError: true, code: 'tool-failed', summary: 'boom', ...wait }
    return { isError: false, summary: `sha:${target.id}`, output: options.output?.[target.id], ...wait }
  }
  let tick = 1_000
  const engine = new PlanEngine({
    invoker: options.invoker ?? fallback,
    emit: (type, data) => {
      events.push({ type, data: data as unknown as Record<string, unknown> })
    },
    now: () => {
      tick += 10
      return tick
    },
    maxNodes: 32,
    maxEdges: 128,
    hasTool: () => true,
    // 生产装配里这里是 `() => session.events()`：**引擎读到的就是自己刚落的事件**
    history: () => events,
    maxNodeAttempts: 3,
    ...(options.shouldPersist === undefined ? {} : { shouldPersist: options.shouldPersist }),
  })
  return { engine, events, calls }
}

const blockedEventOf = (events: readonly Recorded[], nodeId: string): Recorded | undefined =>
  events.find((event) => event.type === 'plan/node-blocked' && event.data['nodeId'] === nodeId)

describe('PlanEngine · 正向执行', () => {
  it('3 节点链全成功：拓扑序串行、6 类事件齐全、args 原文不进事件', async () => {
    const { engine, events, calls } = harness()
    const summary = await engine.run(linear(), { initiator: 's-session' })

    expect(calls).toEqual(['check', 'preview', 'pay'])
    expect(summary.status).toBe('succeeded')
    expect(summary.total).toBe(3)
    expect(summary.succeeded).toBe(3)
    expect(summary.blocked + summary.failed + summary.skipped + summary.cancelled).toBe(0)

    expect(events.map((event) => event.type)).toEqual([
      'plan/created',
      'plan/node-started',
      'plan/node-result',
      'plan/node-started',
      'plan/node-result',
      'plan/node-started',
      'plan/node-result',
      'plan/completed',
    ])

    const created = events[0]?.data ?? {}
    expect(created['initiator']).toBe('s-session')
    expect(created['digest']).toBe(planDigest(linear()))
    expect(created['dryRun']).toBe(false)
    expect(created['edges']).toBe(2)

    // 陷阱 7：金额与收款人不得进 append-only 日志
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('王建国')
    expect(serialized).not.toContain('payee')
  })

  it('planDigest 与键序无关，且 meta 不参与身份', () => {
    const base = linear()
    const reordered: Plan = {
      nodes: base.nodes.map((item) => ({
        deps: item.deps,
        args: item.args,
        tool: item.tool,
        id: item.id,
      })),
      planId: base.planId,
    }

    expect(planDigest(reordered)).toBe(planDigest(base))
    expect(planDigest({ ...base, meta: { title: '改个标题' } })).toBe(planDigest(base))
  })
})

describe('PlanEngine · 失败传播', () => {
  it('菱形图 A 失败：D 的 blockedBy 是直接上游 B、C，且状态是 blocked 不是 pending', async () => {
    const { engine, events, calls } = harness({ fail: ['A'] })
    const summary = await engine.run(diamond(), { initiator: 's-1' })

    expect(calls).toEqual(['A'])
    expect(summary.status).toBe('failed')
    expect(summary.failed).toBe(1)
    expect(summary.blocked).toBe(3)

    const blocked = blockedEventOf(events, 'D')
    expect(blocked?.data['blockedBy']).toEqual(['B', 'C'])
    expect(blocked?.data['reason']).toBe('upstream-blocked')

    const snapshot = engine.snapshot('p-diamond')
    expect(snapshot?.nodes.map((item) => item.state)).toEqual([
      'failed',
      'blocked',
      'blocked',
      'blocked',
    ])
    expect(snapshot?.status).toBe('failed')
  })

  it('optional 上游失败 → skipped，且 skipped 视为依赖满足（下游照跑）', async () => {
    const plan: Plan = {
      planId: 'p-optional',
      nodes: [node('A'), node('B', ['A'], { optional: true }), node('C', ['B'])],
    }
    const { engine, events, calls } = harness({ fail: ['A'] })
    const summary = await engine.run(plan, { initiator: 's-1' })

    expect(calls).toEqual(['A', 'C'])
    expect(summary.skipped).toBe(1)
    expect(summary.blocked).toBe(0)
    // 有 failed 就是 failed，不因为 optional 兜住了就报成功
    expect(summary.status).toBe('failed')

    const skipped = events.find(
      (event) => event.type === 'plan/node-result' && event.data['nodeId'] === 'B',
    )
    expect(skipped?.data['status']).toBe('skipped')
    expect(skipped?.data['code']).toBe('upstream-failed')
  })

  it('全被 block 的计划判 failed（blocked 必须计入失败）', async () => {
    const plan: Plan = { planId: 'p-allblocked', nodes: [node('A'), node('B', ['A'])] }
    const { engine } = harness({ fail: ['A'] })
    const summary = await engine.run(plan, { initiator: 's-1' })

    expect(summary.blocked).toBe(1)
    expect(summary.status).toBe('failed')
  })
})

describe('PlanEngine · 取消与超时', () => {
  it('cancel：已进入的节点跑完，剩余节点 cancelled，plan/aborted 恰好 1 条', async () => {
    const holder: { engine?: PlanEngine } = {}
    const calls: string[] = []
    const plan: Plan = {
      planId: 'p-cancel',
      nodes: [node('a'), node('b', ['a']), node('c', ['a'])],
    }
    const { engine, events } = harness({
      invoker: async (target) => {
        calls.push(target.id)
        // 第一个节点执行中收到取消：它必须跑完（不伪造半途中断）
        if (target.id === 'a') holder.engine?.cancel('p-cancel')
        return { isError: false, summary: `sha:${target.id}` }
      },
    })
    holder.engine = engine

    const summary = await engine.run(plan, { initiator: 's-1' })

    expect(calls).toEqual(['a'])
    expect(summary.status).toBe('aborted')
    expect(summary.succeeded).toBe(1)
    expect(summary.cancelled).toBe(2)
    expect(events.filter((event) => event.type === 'plan/aborted')).toHaveLength(1)

    const aborted = events.find((event) => event.type === 'plan/aborted')
    expect(aborted?.data['reason']).toBe('cancelled')
    expect(aborted?.data['atNode']).toBe('a')
    expect(events.at(-1)?.data['status']).toBe('aborted')
  })

  it('外部信号已 abort（超时先到）：一个节点都不跑，reason 记 timeout', async () => {
    const { engine, calls } = harness()
    const controller = new AbortController()
    controller.abort()

    const summary = await engine.run(linear(), { initiator: 's-1', signal: controller.signal })

    expect(calls).toEqual([])
    expect(summary.status).toBe('aborted')
    expect(summary.cancelled).toBe(3)
    expect(engine.snapshot('p-linear')?.abortReason).toBe('timeout')
  })
})

describe('PlanEngine · dry-run', () => {
  it('不调 invoker、不落 node-started、节点全 skipped', async () => {
    const { engine, events, calls } = harness({ shouldPersist: (state) => state.dryRun !== true })
    const summary = await engine.run(linear(), { initiator: 's-1', dryRun: true })

    expect(calls).toEqual([])
    expect(summary.status).toBe('succeeded')
    expect(summary.skipped).toBe(3)

    // 没有"开始执行"这个事实，就不落 node-started
    expect(events.filter((event) => event.type === 'plan/node-started')).toHaveLength(0)

    const results = events.filter((event) => event.type === 'plan/node-result')
    expect(results).toHaveLength(3)
    expect(results.every((event) => event.data['code'] === 'plan-dry-run')).toBe(true)
    // 遍历顺序 = 拓扑序（dry-run 的可观测价值就在这条序列上）
    expect(results.map((event) => event.data['nodeId'])).toEqual(['check', 'preview', 'pay'])

    // shouldPersist 拦住：dry-run 不进"已完成的 run 表"，不会被当成真实执行留档
    expect(engine.snapshot('p-linear')).toBeUndefined()
  })
})

describe('PlanEngine · 边界', () => {
  it('单写者：同一 plan 重复 run 抛 plan-already-running', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const plan: Plan = { planId: 'p-inflight', nodes: [node('a')] }
    const { engine } = harness({
      invoker: async () => {
        await gate
        return { isError: false, summary: 'sha' }
      },
    })

    const first = engine.run(plan, { initiator: 's-1' })
    await expect(engine.run(plan, { initiator: 's-1' })).rejects.toMatchObject({
      code: 'plan-already-running',
    })
    release?.()
    await expect(first).resolves.toMatchObject({ status: 'succeeded' })

    // 结束后可以再跑（in-flight 已释放）
    await expect(engine.run(plan, { initiator: 's-1' })).resolves.toMatchObject({
      status: 'succeeded',
    })
  })

  it('dispose 后在跑的 run 被 abort，新的 run 直接抛 plan-disposed', async () => {
    const holder: { engine?: PlanEngine } = {}
    const plan: Plan = { planId: 'p-dispose', nodes: [node('a'), node('b', ['a'])] }
    const { engine } = harness({
      invoker: async (target) => {
        if (target.id === 'a') holder.engine?.dispose()
        return { isError: false, summary: 'sha' }
      },
    })
    holder.engine = engine

    const summary = await engine.run(plan, { initiator: 's-1' })
    expect(summary.status).toBe('aborted')
    expect(engine.snapshot('p-dispose')?.abortReason).toBe('disposed')

    await expect(
      engine.run({ planId: 'p-other', nodes: [node('x')] }, { initiator: 's-1' }),
    ).rejects.toMatchObject({ code: 'plan-disposed' })
  })

  it('校验失败抛 plan-invalid（带全量 issues），且一条事件都不落', async () => {
    const { engine, events, calls } = harness()
    const cyclic: Plan = {
      planId: 'p-cycle',
      nodes: [node('a', ['b']), node('b', ['a'])],
    }

    await expect(engine.run(cyclic, { initiator: 's-1' })).rejects.toMatchObject({
      code: 'plan-invalid',
    })
    expect(calls).toEqual([])
    expect(events).toEqual([])
  })

  it('invoker 意外抛错也归一化为 failed，不把整个 plan 拖死', async () => {
    const plan: Plan = { planId: 'p-throw', nodes: [node('a'), node('b')] }
    const { engine } = harness({
      invoker: async (target) => {
        if (target.id === 'a') throw new Error('boom')
        return { isError: false, summary: 'sha' }
      },
    })
    const summary = await engine.run(plan, { initiator: 's-1' })

    expect(summary.failed).toBe(1)
    expect(summary.succeeded).toBe(1)
    expect(engine.snapshot('p-throw')?.nodes[0]?.code).toBe('plan-invoker-failed')
  })
})

/* ── W10：重放（replayPlan）与续跑（resume）──────────────────────────── */

type NodeTrace = 'succeeded' | 'failed' | 'skipped' | 'blocked' | 'incident'

interface HistorySpec {
  /** 每条 per-node 终态；没列出的节点 = 上次没留下任何结论（被 cancel 的节点就不落事件）。 */
  readonly traces: Readonly<Record<string, NodeTrace>>
  /** `false` = 只剩开头没有收尾（模拟窗口被裁剪 / 进程中断）。 */
  readonly closed?: boolean
  /** 覆盖 `plan/completed.total`（模拟"声明 3 个、只重放到 2 个"）。 */
  readonly total?: number
  /** 覆盖 `plan/completed.cancelled`（缺省 = total - 已落终态数）。 */
  readonly cancelled?: number
}

/**
 * 手工拼一段历史（不跑真实 run）。
 *
 * 为什么可以手拼：`replayPlan` 的输入就是"事件数组"，它不认识"事件怎么来的"。
 * 真实链路（run → session.events → resume）由 `plan.test.ts` 的集成用例兜住。
 */
function historyOf(plan: Plan, spec: HistorySpec): Recorded[] {
  const at = 1
  const events: Recorded[] = [
    {
      type: 'plan/created',
      data: {
        planId: plan.planId,
        nodes: plan.nodes.length,
        edges: plan.nodes.reduce((sum, item) => sum + item.deps.length, 0),
        dryRun: false,
        digest: planDigest(plan),
        initiator: 's-history',
        at,
      },
    },
  ]

  const tally = { succeeded: 0, failed: 0, blocked: 0, skipped: 0 }
  for (const item of plan.nodes) {
    const trace = spec.traces[item.id]
    if (trace === undefined) continue
    // `incident` 在载荷里就是 `failed` + `code`：桶记 failed（与引擎的 counts() 同口径）
    tally[trace === 'incident' ? 'failed' : trace] += 1
    if (trace === 'blocked') {
      // ★ blocked 只落 node-blocked、不落 node-result —— 重放漏了它就等于漏了整类节点
      events.push({
        type: 'plan/node-blocked',
        data: {
          planId: plan.planId,
          nodeId: item.id,
          blockedBy: [...item.deps],
          reason: 'upstream-failed',
          at,
        },
      })
      continue
    }
    events.push({
      type: 'plan/node-result',
      data: {
        planId: plan.planId,
        nodeId: item.id,
        // ★ incident 落 failed + 引擎所有的那个码（读侧靠 code 还原，见 nodeStateFromResult）
        status: trace === 'incident' ? 'failed' : trace,
        ...(trace === 'incident' ? { code: PLAN_INCIDENT_CODE } : {}),
        durationMs: 1,
        at,
      },
    })
  }

  if (spec.closed === false) return events

  const total = spec.total ?? plan.nodes.length
  const settled = tally.succeeded + tally.failed + tally.blocked + tally.skipped
  events.push({
    type: 'plan/completed',
    data: {
      planId: plan.planId,
      status: tally.failed + tally.blocked > 0 ? 'failed' : 'succeeded',
      total,
      ...tally,
      cancelled: spec.cancelled ?? total - settled,
      durationMs: 5,
      at,
    },
  })
  return events
}

const asObject = (states: ReadonlyMap<string, PlanNodeState>): Record<string, PlanNodeState> =>
  Object.fromEntries(states)

describe('replayPlan · 纯函数（事件 → 上次状态）', () => {
  it('全成功：三个节点都是 succeeded，窗口闭合、声明 3 个终态', () => {
    const plan = linear()
    const replay = replayPlan(
      historyOf(plan, { traces: { check: 'succeeded', preview: 'succeeded', pay: 'succeeded' } }),
      plan.planId,
    )

    expect(replay.sawCreated).toBe(true)
    expect(replay.digest).toBe(planDigest(plan))
    expect(replay.closed).toBe(true)
    expect(replay.expectedTerminals).toBe(3)
    expect(asObject(replay.states)).toEqual({
      check: 'succeeded',
      preview: 'succeeded',
      pay: 'succeeded',
    })
  })

  it('中间失败 + 下游 blocked：blocked 只出现在 node-blocked，必须一并重放', () => {
    const plan = linear()
    const replay = replayPlan(
      historyOf(plan, { traces: { check: 'succeeded', preview: 'failed', pay: 'blocked' } }),
      plan.planId,
    )

    expect(asObject(replay.states)).toEqual({
      check: 'succeeded',
      preview: 'failed',
      pay: 'blocked',
    })
    // 三个节点都落过终态（succeeded/failed/blocked），所以 total - cancelled = 3
    expect(replay.expectedTerminals).toBe(3)
  })

  it('缺中间结果：states 只重放到 2 个，但 completed 声明 3 个（判据留给 resume）', () => {
    const plan = linear()
    const replay = replayPlan(
      historyOf(plan, {
        traces: { check: 'succeeded', pay: 'succeeded' },
        total: 3,
        cancelled: 0,
      }),
      plan.planId,
    )

    expect(replay.states.size).toBe(2)
    expect(replay.expectedTerminals).toBe(3)
    expect(replay.closed).toBe(true)
  })

  it('空事件：没 plan/created、无状态、未闭合', () => {
    const replay = replayPlan([], 'p-never')

    expect(replay.sawCreated).toBe(false)
    expect(replay.digest).toBeUndefined()
    expect(replay.states.size).toBe(0)
    expect(replay.closed).toBe(false)
    expect(replay.expectedTerminals).toBeUndefined()
  })

  it('跨窗口累积：后一次 run 覆盖同节点结论，没碰到的保留上一次的', () => {
    const plan = linear()
    const first = historyOf(plan, {
      traces: { check: 'succeeded', preview: 'succeeded', pay: 'succeeded' },
    })
    // 第二次 run 只跑到 preview 就失败，pay 被 cancel（不落 per-node 事件）
    const second = historyOf(plan, {
      traces: { check: 'succeeded', preview: 'failed' },
      total: 3,
      cancelled: 1,
    })
    const replay = replayPlan([...first, ...second], plan.planId)

    // preview 被第二次覆盖成 failed；pay 保留第一次的 succeeded —— 这正是"接着上次跑"的语义
    expect(asObject(replay.states)).toEqual({
      check: 'succeeded',
      preview: 'failed',
      pay: 'succeeded',
    })
    expect(replay.expectedTerminals).toBe(2)
  })

  it('过滤：别的 planId 与非 plan 域事件都不参与重建', () => {
    const plan = linear()
    const other = historyOf({ planId: 'p-other', nodes: linear().nodes }, {
      traces: { check: 'failed' },
    })
    const noise: PlanEventRecord[] = [
      { type: 'tool/call', data: { planId: plan.planId, nodeId: 'pay' } },
      { type: 'approval/asked', data: { planId: plan.planId } },
    ]
    const replay = replayPlan([...noise, ...other], plan.planId)

    expect(replay.sawCreated).toBe(false)
    expect(replay.states.size).toBe(0)
  })
})

/** 可以从外部 resolve 的 promise：把一次 run 卡在节点内部，制造"正在跑"。 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('PlanEngine · resume（TC-W10）', () => {
  it('TC-W10-01 改一个字节的 args → plan-identity-mismatch，且不执行任何节点、不落任何事件', async () => {
    const { engine, events, calls } = harness()
    const plan = linear()
    await engine.run(plan, { initiator: 's-1' })
    const settled = events.length

    const tampered: Plan = {
      planId: plan.planId,
      nodes: plan.nodes.map((item) =>
        item.id === 'pay' ? { ...item, args: { amount: 801 } } : item,
      ),
    }
    await expect(engine.resume(tampered, { initiator: 's-1' })).rejects.toMatchObject({
      code: 'plan-identity-mismatch',
    })

    expect(calls).toEqual(['check', 'preview', 'pay'])
    expect(events).toHaveLength(settled)
  })

  it('TC-W10-02 已 succeeded 的节点不重跑：只调度剩下的那个', async () => {
    const plan = linear()
    const { engine, events, calls } = harness()
    events.push(...historyOf(plan, { traces: { check: 'succeeded', preview: 'succeeded' } }))

    const summary = await engine.resume(plan, { initiator: 's-1' })

    expect(calls).toEqual(['pay'])
    expect(summary.status).toBe('succeeded')
    expect(summary.succeeded).toBe(3)
    // 跳过只能是"按状态"，落实在事件上就是：没跑过的节点一条 node-started 都没有
    expect(
      events.filter((event) => event.type === 'plan/node-started').map((event) => event.data['nodeId']),
    ).toEqual(['pay'])
  })

  it('TC-W10-03 双分支：A 已完成不重跑，只跑没结论的那条分支', async () => {
    const plan: Plan = {
      planId: 'p-branch',
      nodes: [node('A'), node('B1', ['A']), node('B2', ['A'])],
    }
    const { engine, events, calls } = harness()
    // B2 上次被 cancel：不落任何 per-node 事件
    events.push(
      ...historyOf(plan, {
        traces: { A: 'succeeded', B1: 'succeeded' },
        total: 3,
        cancelled: 1,
      }),
    )

    const summary = await engine.resume(plan, { initiator: 's-1' })

    expect(calls).toEqual(['B2'])
    expect(summary.succeeded).toBe(3)
  })

  it('TC-W10-04 failed 无 from 时不重试：一个节点都不执行，计划仍判 failed', async () => {
    const plan = linear()
    const { engine, events, calls } = harness()
    events.push(
      ...historyOf(plan, { traces: { check: 'succeeded', preview: 'failed', pay: 'blocked' } }),
    )

    const summary = await engine.resume(plan, { initiator: 's-1' })

    expect(calls).toEqual([])
    expect(summary.status).toBe('failed')
    expect(summary.failed).toBe(1)
    // pay 被重新判一次 blocked（上游还是 failed），归因是新的而不是继承来的
    expect(summary.blocked).toBe(1)
  })

  it('TC-W10-05 from 点名：只重置该节点，下游 blocked 一并重跑，独立分支不动', async () => {
    const plan: Plan = {
      planId: 'p-from',
      nodes: [node('A'), node('B1', ['A']), node('C1', ['B1']), node('B2', ['A'])],
    }
    const { engine, events, calls } = harness()
    events.push(
      ...historyOf(plan, {
        traces: { A: 'succeeded', B1: 'failed', C1: 'blocked', B2: 'succeeded' },
      }),
    )

    const summary = await engine.resume(plan, { initiator: 's-1', from: ['B1'] })

    expect(calls).toEqual(['B1', 'C1'])
    expect(summary.status).toBe('succeeded')
    expect(summary.succeeded).toBe(4)
  })

  it('TC-W10-06 同 planId 再次 run / resume → plan-already-running', async () => {
    const gate = deferred()
    const { engine } = harness({
      invoker: async () => {
        await gate.promise
        return { isError: false, summary: 'sha:slow' }
      },
    })
    const plan = linear()
    const running = engine.run(plan, { initiator: 's-1' })

    await expect(engine.resume(plan, { initiator: 's-1' })).rejects.toMatchObject({
      code: 'plan-already-running',
    })
    await expect(engine.run(plan, { initiator: 's-1' })).rejects.toMatchObject({
      code: 'plan-already-running',
    })

    gate.resolve()
    expect((await running).status).toBe('succeeded')
  })

  it('TC-W10-08 事件窗口被裁剪（缺中间结果）→ plan-replay-incomplete，且一个节点都不执行', async () => {
    const plan = linear()
    const { engine, events, calls } = harness()
    // 只剩 check 与 pay 的结果，completed 仍声明 3 个终态
    events.push(
      ...historyOf(plan, {
        traces: { check: 'succeeded', pay: 'succeeded' },
        total: 3,
        cancelled: 0,
      }),
    )

    await expect(engine.resume(plan, { initiator: 's-1' })).rejects.toMatchObject({
      code: 'plan-replay-incomplete',
    })
    expect(calls).toEqual([])
  })

  it('TC-W10-09 from 指向不存在的节点 → plan-resume-target-missing', async () => {
    const plan = linear()
    const { engine, events, calls } = harness()
    events.push(...historyOf(plan, { traces: { check: 'succeeded' } }))

    await expect(
      engine.resume(plan, { initiator: 's-1', from: ['no-such-node'] }),
    ).rejects.toMatchObject({ code: 'plan-resume-target-missing' })
    expect(calls).toEqual([])
  })

  it('TC-W10-10 全部 succeeded → skipped === total，一条 node-started 都不落', async () => {
    const plan = linear()
    const { engine, events, calls } = harness()
    events.push(
      ...historyOf(plan, {
        traces: { check: 'succeeded', preview: 'succeeded', pay: 'succeeded' },
      }),
    )
    const before = events.length

    const summary = await engine.resume(plan, { initiator: 's-1' })

    expect(calls).toEqual([])
    expect(summary.status).toBe('succeeded')
    expect(summary.succeeded).toBe(3)

    const appended = events.slice(before)
    expect(appended.filter((event) => event.type === 'plan/node-started')).toEqual([])
    // TC-W10-07 的载荷面：plan/resumed 恰好 1 条，字段与冻结载荷逐字一致
    expect(appended.filter((event) => event.type === 'plan/resumed')).toHaveLength(1)
    expect(appended.find((event) => event.type === 'plan/resumed')?.data).toMatchObject({
      planId: plan.planId,
      digest: planDigest(plan),
      skipped: 3,
      resumedFrom: [],
    })
    expect(typeof appended.find((event) => event.type === 'plan/resumed')?.data['at']).toBe(
      'number',
    )
  })

  it('succeeded 的节点即使被 from 点名也绝不重跑（二次扣款不变量）', async () => {
    const plan: Plan = { planId: 'p-one', nodes: [node('only')] }
    const { engine, events, calls } = harness()
    events.push(...historyOf(plan, { traces: { only: 'succeeded' } }))

    const summary = await engine.resume(plan, { initiator: 's-1', from: ['only'] })

    expect(calls).toEqual([])
    expect(summary.succeeded).toBe(1)
  })

  it('C2：resume(from) 重跑同一节点，callId 的 attempt 段递增（票据不撞号）', async () => {
    const plan: Plan = { planId: 'p-attempt', nodes: [node('only')] }
    const seen: string[] = []
    const { engine, events } = harness({
      invoker: async (target, context) => {
        seen.push(context.callId)
        return seen.length === 1
          ? { isError: true, code: 'tool-failed', summary: 'boom' }
          : { isError: false, summary: `sha:${target.id}` }
      },
    })

    const first = await engine.run(plan, { initiator: 's-1' })
    expect(first.status).toBe('failed')

    const second = await engine.resume(plan, { initiator: 's-1', from: ['only'] })
    expect(second.status).toBe('succeeded')

    // 票据 ID 由 callId 派生（`boot.ts` 的 `ticket:` 前缀）：两次执行若都是 `#1`，
    // 第二次就复用了第一张票据的账本行，审批与审计都会指向错误的执行。
    expect(seen).toEqual(['p-attempt#only#1', 'p-attempt#only#2'])

    // 事件面同口径：两条 node-started 的 callId 互不相同（审计可分辨）
    const started = events.filter((event) => event.type === 'plan/node-started')
    expect(started.map((event) => event.data['callId'])).toEqual([
      'p-attempt#only#1',
      'p-attempt#only#2',
    ])
  })

  it('C2：dry-run 不消耗 attempt 序号（之后的真跑仍是 #1）', async () => {
    const plan: Plan = { planId: 'p-dry', nodes: [node('only')] }
    const seen: string[] = []
    const { engine, events } = harness({
      invoker: async (target, context) => {
        seen.push(context.callId)
        return { isError: false, summary: `sha:${target.id}` }
      },
    })

    const dry = await engine.run(plan, { initiator: 's-1', dryRun: true })
    expect(dry.failed + dry.blocked).toBe(0)
    // dry-run 走 `pending → skipped`，**不落 node-started**，因此没有 attempt 可言
    expect(events.filter((event) => event.type === 'plan/node-started')).toEqual([])

    await engine.run(plan, { initiator: 's-1' })
    expect(seen).toEqual(['p-dry#only#1'])
  })

  it('从未跑过 / 上次没收尾 → plan-replay-incomplete（都一条事件都不落）', async () => {
    const plan = linear()

    const never = harness()
    await expect(never.engine.resume(plan, { initiator: 's-1' })).rejects.toMatchObject({
      code: 'plan-replay-incomplete',
    })
    expect(never.events).toEqual([])

    const open = harness()
    open.events.push(...historyOf(plan, { traces: { check: 'succeeded' }, closed: false }))
    const before = open.events.length
    await expect(open.engine.resume(plan, { initiator: 's-1' })).rejects.toMatchObject({
      code: 'plan-replay-incomplete',
    })
    expect(open.events).toHaveLength(before)
  })
})

describe('PlanEngine · resume 重试上限（maxNodeAttempts）', () => {
  /** 单节点计划：把"失败次数"和"节点数"这两个变量拆开，避免用例自己算错。 */
  const one = (): Plan => ({ planId: 'p-retry', nodes: [node('only')] })

  it('replayPlan 的 failures 只增不减：失败 2 次后成功，states=succeeded 但 failures=2', () => {
    const plan = one()
    const replay = replayPlan(
      [
        ...historyOf(plan, { traces: { only: 'failed' } }),
        ...historyOf(plan, { traces: { only: 'failed' } }),
        ...historyOf(plan, { traces: { only: 'succeeded' } }),
      ],
      plan.planId,
    )

    expect(replay.states.get('only')).toBe('succeeded')
    expect(replay.failures.get('only')).toBe(2)
  })

  it('失败 3 次（= 默认上限）后 from 被拒：plan-resume-retry-exhausted，一个节点都不跑', async () => {
    const plan = one()
    const { engine, events, calls } = harness()
    for (let round = 0; round < 3; round += 1) {
      events.push(...historyOf(plan, { traces: { only: 'failed' } }))
    }

    await expect(engine.resume(plan, { initiator: 's-1', from: ['only'] })).rejects.toMatchObject({
      code: 'plan-resume-retry-exhausted',
    })
    expect(calls).toEqual([])
  })

  it('失败 2 次仍可重试：上限口径是"最多失败 3 次"，不是"重试 3 次"', async () => {
    const plan = one()
    const { engine, events, calls } = harness()
    events.push(...historyOf(plan, { traces: { only: 'failed' } }))
    events.push(...historyOf(plan, { traces: { only: 'failed' } }))

    const summary = await engine.resume(plan, { initiator: 's-1', from: ['only'] })

    expect(calls).toEqual(['only'])
    expect(summary.status).toBe('succeeded')
  })

  it('上限只判"真的会被重试"的节点：succeeded 的节点失败过 3 次也不会被拒', async () => {
    const plan = one()
    const { engine, events, calls } = harness()
    for (let round = 0; round < 3; round += 1) {
      events.push(...historyOf(plan, { traces: { only: 'failed' } }))
    }
    // 第 4 次成功了：failures 仍是 3，但状态是 succeeded
    events.push(...historyOf(plan, { traces: { only: 'succeeded' } }))

    const summary = await engine.resume(plan, { initiator: 's-1', from: ['only'] })

    // 它根本不会被重跑，所以"重试超限"是纯噪音，不该抛
    expect(calls).toEqual([])
    expect(summary.succeeded).toBe(1)
  })
})

/* ── W11：incident（第 9 态）────────────────────────────────────────── */

describe('PlanEngine · W11 incident', () => {
  it('TC-W11-07 前半：载荷是 failed + 引擎写的码，completed 判 failed，五计数仍等于 total', async () => {
    const plan: Plan = { planId: 'p-incident', nodes: [node('a'), node('b', ['a'])] }
    const { engine, events } = harness({ incident: ['a'] })

    const summary = await engine.run(plan, { initiator: 's-1' })

    const result = events.find(
      (event) => event.type === 'plan/node-result' && event.data['nodeId'] === 'a',
    )
    // ① 载荷仍是冻结的三值之一；② code 被引擎改写成自己的常量（invoker 给的是 provider-down）
    expect(result?.data['status']).toBe('failed')
    expect(result?.data['code']).toBe(PLAN_INCIDENT_CODE)
    // ③ 收尾判 failed（TC-W11-07 原文；若漏记 counts 桶，这里会变成 succeeded）
    expect(summary.status).toBe('failed')
    // ④ 五计数之和 = total：incident 必须落在 failed 桶，不能"凭空少一个"
    expect(
      summary.succeeded + summary.failed + summary.blocked + summary.skipped + summary.cancelled,
    ).toBe(summary.total)
    // ⑤ 内存快照里是第 9 态；下游照常被 blocked（incident 也是"上游没成功"）
    const states = engine.snapshot('p-incident')?.nodes.map((item) => [item.nodeId, item.state])
    expect(states).toEqual([
      ['a', 'incident'],
      ['b', 'blocked'],
    ])
  })

  it('重放：incident 还原成 incident（不是 failed），且不记失败次数', () => {
    const plan: Plan = { planId: 'p-inc-replay', nodes: [node('a')] }
    const replay = replayPlan(historyOf(plan, { traces: { a: 'incident' } }), plan.planId)

    expect(replay.states.get('a')).toBe('incident')
    // ★ 外部不可用不是"这个节点不行"：记进 failures 会提前打满 maxNodeAttempts
    expect(replay.failures.get('a')).toBeUndefined()
  })

  it('TC-W11-07 后半：resume 把 incident 自动重置为 pending 并重跑（不需要 from）', async () => {
    const plan: Plan = { planId: 'p-inc-resume', nodes: [node('a')] }
    const { engine, events, calls } = harness()
    events.push(...historyOf(plan, { traces: { a: 'incident' } }))

    const summary = await engine.resume(plan, { initiator: 's-1' })

    expect(calls).toEqual(['a'])
    expect(summary.status).toBe('succeeded')
  })

  it('incident 不吃重试预算：连续 3 次 incident 之后仍可续（不报 retry-exhausted）', async () => {
    const plan: Plan = { planId: 'p-inc-budget', nodes: [node('a')] }
    const { engine, events, calls } = harness()
    for (let round = 0; round < 3; round += 1) {
      events.push(...historyOf(plan, { traces: { a: 'incident' } }))
    }

    const summary = await engine.resume(plan, { initiator: 's-1', from: ['a'] })

    expect(calls).toEqual(['a'])
    expect(summary.succeeded).toBe(1)
  })
})

/* ── W11：plan/node-waiting ────────────────────────────────────────── */

describe('PlanEngine · W11 node-waiting', () => {
  it('TC-W11-06 审批等待：恰好 1 条，waitedMs 取宿主回传值，且落在 node-result 之前', async () => {
    const plan: Plan = { planId: 'p-wait', nodes: [node('a')] }
    const { engine, events } = harness({ waited: { a: 1234 } })

    await engine.run(plan, { initiator: 's-1' })

    const waiting = events.filter((event) => event.type === 'plan/node-waiting')
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.data['nodeId']).toBe('a')
    expect(waiting[0]?.data['waitedMs']).toBe(1234)
    const order = events.map((event) => event.type)
    expect(order.indexOf('plan/node-waiting')).toBeLessThan(order.indexOf('plan/node-result'))
  })

  it('没走审批（waitedMs 缺省）→ 一条 node-waiting 都不落', async () => {
    const plan: Plan = { planId: 'p-nowait', nodes: [node('a')] }
    const { engine, events } = harness()

    await engine.run(plan, { initiator: 's-1' })

    expect(events.some((event) => event.type === 'plan/node-waiting')).toBe(false)
  })

  it('NaN / 负数一律夹成 0（载荷里出现 NaN 会让 JSONL 回放不可解析）', async () => {
    const plan: Plan = { planId: 'p-wait-bad', nodes: [node('a')] }
    const { engine, events } = harness({ waited: { a: Number.NaN } })

    await engine.run(plan, { initiator: 's-1' })

    expect(events.find((event) => event.type === 'plan/node-waiting')?.data['waitedMs']).toBe(0)
  })

  it('审批被拒也落 node-waiting：那是"等人看过"的事实，不是成功专属', async () => {
    const plan: Plan = { planId: 'p-wait-deny', nodes: [node('a')] }
    const { engine, events } = harness({ fail: ['a'], waited: { a: 7 } })

    await engine.run(plan, { initiator: 's-1' })

    expect(events.filter((event) => event.type === 'plan/node-waiting')).toHaveLength(1)
  })
})

/* ── W11：动态 args ────────────────────────────────────────────────── */

describe('PlanEngine · W11 动态 args', () => {
  /** `b` 的 txnId 来自 `a` 的 output。 */
  const chained = (): Plan => ({
    planId: 'p-args',
    nodes: [
      node('a'),
      node('b', ['a'], { args: { txnId: '${node.a.txnId}', amount: 800 } }),
    ],
  })

  it('TC-W11-01 整串模板：执行期替换成上游 output 的字段，且模板原文不进事件', async () => {
    const plan = chained()
    const seen: unknown[] = []
    const { engine, events } = harness({
      invoker: async (target) => {
        seen.push(target.args)
        return {
          isError: false,
          summary: `sha:${target.id}`,
          output: target.id === 'a' ? { txnId: 'T-999' } : undefined,
        }
      },
    })

    await engine.run(plan, { initiator: 's-1' })

    expect(seen[0]).toEqual({})
    expect(seen[1]).toEqual({ txnId: 'T-999', amount: 800 })
    expect(JSON.stringify(events)).not.toContain('${node.')
  })

  it('TC-W11-04 上游 output 缺字段 → 运行期 plan-args-unresolved，且不落 node-started', async () => {
    const plan = chained()
    const { engine, events, calls } = harness({ output: { a: {} } })

    const summary = await engine.run(plan, { initiator: 's-1' })

    // b 从未被派发：args 解析不出来就不该进管线
    expect(calls).toEqual(['a'])
    const result = events.find(
      (event) => event.type === 'plan/node-result' && event.data['nodeId'] === 'b',
    )
    expect(result?.data['status']).toBe('failed')
    expect(result?.data['code']).toBe(PLAN_ARGS_UNRESOLVED_CODE)
    expect(summary.status).toBe('failed')
    // 没派发就不该有"开始了"的痕迹
    expect(
      events.filter((event) => event.type === 'plan/node-started').map((event) => event.data['nodeId']),
    ).toEqual(['a'])
  })

  it('TC-W11-05 表达式按字面串处理：不求值、不报错', async () => {
    const plan: Plan = { planId: 'p-expr', nodes: [node('a', [], { args: { note: '${a + b}' } })] }
    const seen: unknown[] = []
    const { engine } = harness({
      invoker: async (target) => {
        seen.push(target.args)
        return { isError: false, summary: 'sha' }
      },
    })

    const summary = await engine.run(plan, { initiator: 's-1' })

    expect(seen[0]).toEqual({ note: '${a + b}' })
    expect(summary.status).toBe('succeeded')
  })

  it('前缀里带别的字符就不是模板：只有整串才替换', async () => {
    const plan: Plan = {
      planId: 'p-partial',
      nodes: [node('a'), node('b', ['a'], { args: { label: '单号-${node.a.txnId}' } })],
    }
    const seen: unknown[] = []
    const { engine } = harness({
      invoker: async (target) => {
        seen.push(target.args)
        return { isError: false, summary: 'sha', output: { txnId: 'T-1' } }
      },
    })

    await engine.run(plan, { initiator: 's-1' })

    expect(seen[1]).toEqual({ label: '单号-${node.a.txnId}' })
  })

  it('数组下标走位：${node.a.content.0.text} 取到嵌套字段', async () => {
    const plan: Plan = {
      planId: 'p-index',
      nodes: [node('a'), node('b', ['a'], { args: { text: '${node.a.content.0.text}' } })],
    }
    const seen: unknown[] = []
    const { engine } = harness({
      invoker: async (target) => {
        seen.push(target.args)
        return {
          isError: false,
          summary: 'sha',
          output: target.id === 'a' ? { content: [{ type: 'text', text: '余额 800 元' }] } : undefined,
        }
      },
    })

    await engine.run(plan, { initiator: 's-1' })

    expect(seen[1]).toEqual({ text: '余额 800 元' })
  })

  it('resume：待执行节点引用本次会被跳过的上游 → plan-resume-args-unresolved，一个节点都不跑', async () => {
    const plan = chained()
    const { engine, events, calls } = harness()
    events.push(...historyOf(plan, { traces: { a: 'succeeded' } }))

    await expect(engine.resume(plan, { initiator: 's-1' })).rejects.toMatchObject({
      code: PLAN_RESUME_ERRORS.argsUnresolved,
    })
    expect(calls).toEqual([])
  })

  it('resume 不误拒：引用方自己已 succeeded（本次不执行）时照常续跑', async () => {
    const plan = chained()
    const { engine, events, calls } = harness()
    events.push(...historyOf(plan, { traces: { a: 'succeeded', b: 'succeeded' } }))

    const summary = await engine.resume(plan, { initiator: 's-1' })

    expect(calls).toEqual([])
    // 两个节点都因"succeeded 跳过"而没有执行：`plan/resumed.skipped` 记的是这个数
    // （`summary.skipped` 是"状态为 skipped 的节点数"，两者不是一回事）
    expect(events.find((event) => event.type === 'plan/resumed')?.data['skipped']).toBe(2)
    expect(summary.succeeded).toBe(2)
    expect(summary.status).toBe('succeeded')
  })

  it('resume 不误拒：上游也会重跑（pending）时模板能解析，照常续', async () => {
    const plan = chained()
    const { engine, events, calls } = harness({ output: { a: { txnId: 'T-2' } } })
    // a 上次被 cancel（不落 per-node 事件）→ 本次会重跑，output 可得
    events.push(...historyOf(plan, { traces: {}, total: 2, cancelled: 2 }))

    const summary = await engine.resume(plan, { initiator: 's-1' })

    expect(calls).toEqual(['a', 'b'])
    expect(summary.status).toBe('succeeded')
  })
})

/* ── W11：二次 completed 的读侧口径（TC-W11-11）───────────────────── */

describe('PlanEngine · TC-W11-11 同一 planId 的两次 completed', () => {
  it('读侧以最后一条为准，plan/resumed 是两次窗口的分隔符', async () => {
    const plan: Plan = { planId: 'p-last', nodes: [node('a')] }
    let attempt = 0
    const { engine, events } = harness({
      invoker: async () => {
        attempt += 1
        if (attempt === 1) return { isError: true, code: 'tool-failed', summary: 'boom' }
        return { isError: false, summary: 'ok' }
      },
    })

    const first = await engine.run(plan, { initiator: 's-1' })
    const second = await engine.resume(plan, { initiator: 's-1', from: ['a'] })

    expect(first.status).toBe('failed')
    expect(second.status).toBe('succeeded')

    const completed = events.filter((event) => event.type === 'plan/completed')
    expect(completed).toHaveLength(2)
    expect(completed.at(-1)?.data['status']).toBe('succeeded')
    // 分隔符在两条 completed 之间：它之前属上一次 run
    const order = events.map((event) => event.type)
    expect(order.indexOf('plan/resumed')).toBeGreaterThan(order.indexOf('plan/completed'))
    expect(order.lastIndexOf('plan/completed')).toBeGreaterThan(order.indexOf('plan/resumed'))
  })
})
