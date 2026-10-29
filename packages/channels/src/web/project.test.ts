/**
 * 投影器用例（施工单 13 §5 T-WEB-002 / 005 / 006 / 007 + 审批六要素 / 审计 / 幂等）。
 *
 * 纪律：这里只喂**事件**，断言**帧**。不碰 DOM、不碰 HTTP、不读时钟——
 * 一旦某条断言需要真实时间，说明投影层混进了副作用。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { projectEffects, projectSession, projectTodo, WebProjector } from './project.ts'
import type {
  ApprovalFrame,
  AuditFrame,
  DagFrame,
  DagNode,
  EffectsFrame,
  TodoFrame,
  ToolFrame,
  TurnFrame,
} from './frames.ts'

/** 造事件的游标。 */
let cursor = 0

/** 造一条事件（`seq` 自增；`formatVersion` 固定 1）。 */
function ev(type: string, data: unknown, at = 1_700_000_000_000): AnySessionEvent {
  cursor += 1
  return { seq: cursor, at, formatVersion: 1, type, data } as unknown as AnySessionEvent
}

/** 重置游标（每个用例独立编号）。 */
function reset(): void {
  cursor = 0
}

/** 幕 3 的关键事件序列：用户问 → 工具调用（黄级 800 元）→ 审批 → 结果 → 文本收尾。 */
function transferEvents(): AnySessionEvent[] {
  reset()
  return [
    ev('turn/start', { turn: 1 }),
    ev('step/start', { turn: 1, step: 1 }),
    ev('user/message', { content: '给王建国转 800 元' }),
    ev('tool/call', {
      callId: 'call-1',
      name: 'transfer_create',
      args: { amount: 800, payee: { name: '王建国', phone: '13900002222' }, remark: '房租' },
      fingerprint: 'fp-1',
      tier: { level: 'yellow', amountPath: 'amount' },
      at: 1_700_000_000_000,
    }),
    ev('approval/asked', {
      ticketId: 'ticket:call-1',
      callId: 'call-1',
      name: 'transfer_create',
      amount: 80_000,
      challenge: undefined,
    }),
    ev('approval/decided', {
      ticketId: 'ticket:call-1',
      decision: 'allowed-once',
    }),
    ev('tool/result', {
      callId: 'call-1',
      name: 'transfer_create',
      isError: false,
      content: [{ type: 'text', text: '已转账 ¥800.00 给王建国，余额 ¥12,345.00' }],
      durationMs: 12,
    }),
    ev('assistant/message', {
      content: [{ type: 'text', text: '已为你在模拟环境完成 800 元转账。' }],
      toolCalls: [{ callId: 'call-1', name: 'transfer_create', args: {} }],
    }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

describe('WebProjector · 三态（T-WEB-002）', () => {
  it('同一调用三事件 → 三个状态、一个节点', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('step/start', { turn: 1, step: 1 }))
    projector.apply(
      ev('tool/call', {
        callId: 'call-1',
        name: 'transfer_create',
        args: { amount: 800, payee: { name: '王建国' } },
        fingerprint: 'fp',
        tier: { level: 'yellow' },
        at: 1,
      }),
    )

    const states: string[] = []
    const frame = projector.frames().find((item) => item.kind === 'tool')
    states.push(frame?.kind === 'tool' ? frame.state : 'missing')

    projector.apply(
      ev('tool/result', {
        callId: 'call-1',
        name: 'transfer_create',
        isError: true,
        content: [{ type: 'text', text: '拒绝' }],
        code: 'PRV-002',
        reason: '危险指令',
      }),
    )
    const denied = projector.frames().find((item) => item.kind === 'tool')
    states.push(denied?.kind === 'tool' ? denied.state : 'missing')

    // 第二个调用走成功路径 → 第三种状态
    projector.apply(
      ev('tool/call', {
        callId: 'call-2',
        name: 'transfer_create',
        args: { amount: 100, payee: { name: '李雷' } },
        fingerprint: 'fp-2',
        tier: { level: 'green' },
        at: 2,
      }),
    )
    projector.apply(
      ev('tool/result', {
        callId: 'call-2',
        name: 'transfer_create',
        isError: false,
        content: [{ type: 'text', text: '已转账' }],
      }),
    )
    const tools = projector.frames().filter((item) => item.kind === 'tool') as ToolFrame[]
    expect(tools).toHaveLength(2)
    expect(states).toEqual(['pending', 'denied'])
    expect(tools.map((item) => item.state)).toEqual(['denied', 'done'])
    expect(denied?.kind === 'tool' ? denied.reasonKind : undefined).toBe('denied')
    expect(denied?.kind === 'tool' ? denied.code : undefined).toBe('PRV-002')
  })

  it('执行期错误码判 failed，判决拦截码判 denied（不把内部错误讲成拦截）', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('step/start', { turn: 1, step: 1 }))
    const cases = [
      { callId: 'call-failed', code: 'tool-failed', expected: 'failed' },
      { callId: 'call-invalid', code: 'tool-result-invalid', expected: 'failed' },
      { callId: 'call-denied', code: 'PRV-002', expected: 'denied' },
    ]
    for (const item of cases) {
      projector.apply(
        ev('tool/call', {
          callId: item.callId,
          name: 'balance_query',
          args: {},
          fingerprint: `fp-${item.callId}`,
          tier: { level: 'green' },
          at: 1,
        }),
      )
      projector.apply(
        ev('tool/result', {
          callId: item.callId,
          name: 'balance_query',
          isError: true,
          content: [{ type: 'text', text: '失败' }],
          code: item.code,
        }),
      )
    }

    const tools = projector.frames().filter((frame) => frame.kind === 'tool') as ToolFrame[]
    expect(tools.map((item) => item.reasonKind)).toEqual(['failed', 'failed', 'denied'])
  })
})

describe('WebProjector · 审批六要素', () => {
  it('操作类型 / 金额 / 收款人 / 风险级别 / 截止 / 拒绝理由必填', () => {
    const frames = projectSession(transferEvents()).frames
    const approval = frames.find((frame) => frame.kind === 'approval') as ApprovalFrame

    expect(approval.operation).toBe('转账')
    expect(approval.amountText).toBe('¥800.00')
    expect(approval.payeeName).toBe('王建国')
    expect(approval.tier).toBe('yellow')
    // 票据 TTL 不在 approval/asked 里（偏差 R-WEB-D8）：帧不得编造 expiresAt
    expect(approval.expiresAt).toBeUndefined()
    expect(approval.rejectReasonRequired).toBe(true)
    // 审批时还没有结果 → 金额未确认
    expect(approval.amountConfirmed).toBe(false)
  })

  it('手机号脱敏后才进帧；手续费来自本 turn 的预演结果', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('step/start', { turn: 1, step: 1 }))
    projector.apply(
      ev('tool/call', {
        callId: 'call-p',
        name: 'transfer_preview',
        args: { amount: 800, payee: { name: '王建国', phone: '13900002222' } },
        fingerprint: 'fp-p',
        tier: { level: 'green' },
        at: 1,
      }),
    )
    projector.apply(
      ev('tool/result', {
        callId: 'call-p',
        name: 'transfer_preview',
        isError: false,
        content: [
          {
            type: 'text',
            text: '试算：向 王建国（已绑定）转账 ¥800.00，手续费 ¥0.00。当日已用 ¥0.00，剩余 ¥1,000.00。',
          },
        ],
        durationMs: 1,
      }),
    )
    projector.apply(
      ev('tool/call', {
        callId: 'call-1',
        name: 'transfer_create',
        args: { amount: 800, payee: { name: '王建国', phone: '13900002222' } },
        fingerprint: 'fp-1',
        tier: { level: 'yellow' },
        at: 2,
      }),
    )
    projector.apply(
      ev('approval/asked', {
        ticketId: 'ticket:call-1',
        callId: 'call-1',
        name: 'transfer_create',
        amount: 800,
      }),
    )

    const approval = projector.frames().find((frame) => frame.kind === 'approval') as ApprovalFrame
    expect(approval.payeePhone).toBe('139****2222')
    expect(approval.feeText).toBe('¥0.00')
    // 帧里不得出现完整号码（脱敏发生在上游，前端拿不到原值）
    expect(JSON.stringify(approval)).not.toContain('13900002222')
  })

  it('没有预演结果时不编手续费（少一行比编一个数安全）', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(
      ev('tool/call', {
        callId: 'call-1',
        name: 'transfer_create',
        args: { amount: 800, payee: { name: '王建国', phone: '13900002222' } },
        fingerprint: 'fp-1',
        tier: { level: 'yellow' },
        at: 1,
      }),
    )
    projector.apply(
      ev('approval/asked', { ticketId: 'ticket:call-1', callId: 'call-1', name: 'transfer_create', amount: 800 }),
    )
    const approval = projector.frames().find((frame) => frame.kind === 'approval') as ApprovalFrame
    expect(approval.feeText).toBeUndefined()
    expect(approval.payeePhone).toBe('139****2222')
  })

  it('参数里没有金额时退回事件值，且仍按"元"格式化（￥8.00 是事故，不是精度）', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(
      ev('tool/call', {
        callId: 'call-x',
        name: 'wealth_purchase',
        args: { productId: 'W-1' },
        fingerprint: 'fp-x',
        tier: { level: 'red' },
        at: 1,
      }),
    )
    projector.apply(
      ev('approval/asked', { ticketId: 'ticket:call-x', callId: 'call-x', name: 'wealth_purchase', amount: 800 }),
    )
    const approval = projector.frames().find((frame) => frame.kind === 'approval') as ApprovalFrame
    expect(approval.amountText).toBe('¥800.00')
  })

  it('结论帧与工具帧各自收尾', () => {
    const frames = projectSession(transferEvents()).frames
    const closed = frames.find((frame) => frame.kind === 'approval-closed')
    const tool = frames.find((frame) => frame.kind === 'tool') as ToolFrame

    expect(closed?.kind).toBe('approval-closed')
    expect(closed?.kind === 'approval-closed' ? closed.label : '').toBe('已批准（一次性）')
    expect(tool.state).toBe('done')
    expect(tool.amountConfirmed).toBe(true)
  })
})

describe('WebProjector · 金额降级（T-WEB-005）', () => {
  it('没有结果时金额未确认（待确认由视图渲染）', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(
      ev('tool/call', {
        callId: 'call-9',
        name: 'wealth_purchase',
        args: { productId: 'W-1', amount: 50_000 },
        fingerprint: 'fp',
        tier: { level: 'red' },
        at: 1,
      }),
    )
    const tool = projector.frames().find((frame) => frame.kind === 'tool') as ToolFrame
    expect(tool.amountConfirmed).toBe(false)
    expect(tool.card?.fields.find((field) => field.amount)?.value).toBe('¥50,000.00')
  })

  it('理财结果的风险提示从正文抽出且永不折叠', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(
      ev('tool/call', {
        callId: 'call-w',
        name: 'wealth_list',
        args: {},
        fingerprint: 'fp',
        tier: { level: 'green' },
        at: 1,
      }),
    )
    projector.apply(
      ev('tool/result', {
        callId: 'call-w',
        name: 'wealth_list',
        isError: false,
        content: [
          {
            type: 'text',
            text: '共 1 个产品：\n- 稳盈90天（W-1）：R2，90 天，预期年化 3.1%，起投 ¥1,000.00\n风险提示：wealth.disclaimer.v1（必须向用户展示，理财非存款、投资有风险）',
          },
        ],
      }),
    )
    const tool = projector.frames().find((frame) => frame.kind === 'tool') as ToolFrame
    expect(tool.card?.disclaimer?.id).toBe('wealth.disclaimer.v1')
    // 正文里不再重复风险提示行
    expect(tool.card?.body ?? '').not.toContain('wealth.disclaimer.v1')
    expect(tool.card?.tags.map((tag) => tag.text)).toContain('理财非存款')
  })
})

describe('WebProjector · DAG（T-WEB-006）', () => {
  it('失败节点下游标记 blocked，已执行节点事实优先', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('step/start', { turn: 1, step: 1 }))
    for (const callId of ['call-a', 'call-b']) {
      projector.apply(
        ev('tool/call', {
          callId,
          name: 'transfer_preview',
          args: {},
          fingerprint: callId,
          tier: { level: 'green' },
          at: 1,
        }),
      )
    }
    // A 执行成功、B 仍在等 → A 失败不会把已 ok 的节点改写
    projector.apply(
      ev('tool/result', {
        callId: 'call-a',
        name: 'transfer_preview',
        isError: true,
        content: [{ type: 'text', text: '拒' }],
        code: 'PRV-001',
      }),
    )

    const dag = projector.frames().find((frame) => frame.kind === 'dag') as DagFrame
    const byId = new Map(dag.nodes.map((node) => [node.id, node]))
    expect(byId.get('call:call-a')?.state).toBe('denied')
    expect(byId.get('call:call-b')?.state).toBe('blocked')
    expect(dag.summary).toContain('下游已阻断')
  })

  it('节点带权限级别，边按事件顺序连接', () => {
    const frames = projectSession(transferEvents()).frames
    const dag = frames.find((frame) => frame.kind === 'dag') as DagFrame
    const call = dag.nodes.find((node) => node.kind === 'call')
    expect(call?.tier).toBe('yellow')
    expect(dag.edges.length).toBeGreaterThan(0)
    expect(dag.summary).toContain('第 1 轮')
  })
})

describe('WebProjector · 帧不可变性与幂等（T-WEB-001 的"不重"）', () => {
  it('重复喂同一条事件不产生第二帧', () => {
    const events = transferEvents()
    const projector = new WebProjector()
    for (const event of events) projector.apply(event)
    const before = projector.frames().length
    for (const event of events.slice(0, 4)) expect(projector.apply(event)).toEqual([])
    expect(projector.frames()).toHaveLength(before)
    expect(projector.maxSeq()).toBe(events.length)
  })

  it('两次归约深度相等（T-WEB-007）', () => {
    const a = projectSession(transferEvents())
    const b = projectSession(transferEvents())
    expect(a.frames).toEqual(b.frames)
    expect(a.maxSeq).toBe(b.maxSeq)
  })
})

describe('WebProjector · 轮次与提示', () => {
  it('判停不伪装成完成：guard-stopped 出 warning 提示且带理由码', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('turn/end', { turn: 1, reason: { kind: 'guard-stopped', reason: '预算耗尽' } }))

    const turn = projector.frames().filter((frame) => frame.kind === 'turn').pop() as TurnFrame
    const notice = projector.frames().find((frame) => frame.kind === 'notice')
    expect(turn.phase).toBe('end')
    expect(notice?.kind === 'notice' ? notice.level : '').toBe('warning')
    expect(notice?.kind === 'notice' ? notice.text : '').toBe('预算耗尽')
  })

  it('审计时间线只收判决类事件', () => {
    const frames = projectSession(transferEvents()).frames
    const audits = frames.filter((frame) => frame.kind === 'audit') as AuditFrame[]
    const labels = audits.map((item) => item.label)

    expect(labels).toContain('审批请求')
    expect(labels).toContain('审批结论')
    expect(labels).toContain('工具完成')
    expect(labels).toContain('轮次结束')
    // 用户发言不是"决定"
    expect(labels).not.toContain('用户发言')
    // 审计条目必须带可回跳的 seq
    expect(audits.every((item) => item.seq > 0)).toBe(true)
  })

  it('票据领域事件进时间线（宽松读取，不因未知字段抛错）', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('ticket/issued', { ticketId: 'ticket:call-1', callId: 'call-1', name: 'transfer_create' }))
    const audit = projector.frames().find((frame) => frame.kind === 'audit') as AuditFrame
    expect(audit.category).toBe('ticket')
    expect(audit.label).toBe('票据已签发')
  })

  it('快照携带全量帧与 maxSeq', () => {
    const { snapshot } = projectSession(transferEvents(), 's-1')
    expect(snapshot.kind).toBe('snapshot')
    expect(snapshot.sessionId).toBe('s-1')
    expect(snapshot.maxSeq).toBe(9)
    expect(snapshot.frames.length).toBeGreaterThan(0)
  })
})

describe('WebProjector · 消息与流式', () => {
  it('助手消息保留工具调用引用，用户来源标记透传', () => {
    const frames = projectSession(transferEvents()).frames
    const assistant = frames.filter((frame) => frame.kind === 'message').pop()
    expect(assistant?.kind === 'message' ? assistant.role : '').toBe('assistant')
    expect(assistant?.kind === 'message' ? assistant.toolCalls?.[0]?.callId : '').toBe('call-1')
  })

  it('纠正文本（source=context）不冒充用户发言', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('user/message', { content: '已按最新结果更正', source: 'context' }))
    const frame = projector.frames()[0]
    expect(frame?.kind === 'message' ? frame.source : '').toBe('context')
  })
})

describe('WebProjector · plan 节点图（B2）', () => {
  /** 一张两节点计划的事件：n1 成功、n2 失败（非 incident）。 */
  function planEvents(): AnySessionEvent[] {
    reset()
    return [
      ev('turn/start', { turn: 1 }),
      ev('plan/created', { planId: 'p-1', nodes: 2, edges: 1, dryRun: false, digest: 'd1' }),
      ev('plan/node-started', { planId: 'p-1', nodeId: 'n1', tool: 'account_balance', ordinal: 1, callId: 'pc-1' }),
      ev('plan/node-result', { planId: 'p-1', nodeId: 'n1', status: 'succeeded', durationMs: 5 }),
      ev('plan/node-started', { planId: 'p-1', nodeId: 'n2', tool: 'transfer_create', ordinal: 2, callId: 'pc-2' }),
      ev('plan/node-result', { planId: 'p-1', nodeId: 'n2', status: 'failed', code: 'insufficient-funds', durationMs: 3 }),
      ev('plan/completed', { planId: 'p-1', status: 'failed', total: 2, succeeded: 1, failed: 1, blocked: 0, skipped: 0, cancelled: 0, durationMs: 8 }),
    ]
  }

  it('plan 节点入图：状态与 plan/* 事件一致，按 ordinal 串联', () => {
    const frames = projectSession(planEvents()).frames
    const dag = frames.filter((frame) => frame.kind === 'dag').pop() as DagFrame
    const planNodes = dag.nodes.filter((node) => node.kind === 'plan')
    expect(planNodes).toHaveLength(2)
    const byNode = new Map(planNodes.map((node) => [node.planId === undefined ? '' : node.id, node]))
    const n1 = [...byNode.values()].find((node) => node.label.includes('n1'))
    const n2 = [...byNode.values()].find((node) => node.label.includes('n2'))
    expect(n1?.state).toBe('ok')
    expect(n2?.state).toBe('failed')
    expect(n2?.code).toBe('insufficient-funds')
    // 按 ordinal 串联成边（执行序，如实登记不是 deps 边）
    expect(dag.edges).toEqual([
      { from: expect.stringContaining('plan:p-1:n1'), to: expect.stringContaining('plan:p-1:n2') },
    ])
    expect(dag.summary).toContain('计划节点 2 个')
    expect(dag.summary).toContain('1 个失败')
  })

  it('incident（status=failed + PLAN_INCIDENT_CODE）与 failed 在视图上可区分', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('plan/node-started', { planId: 'p-1', nodeId: 'nX', tool: 'pay', ordinal: 1, callId: 'pc-9' }))
    projector.apply(ev('plan/node-result', { planId: 'p-1', nodeId: 'nX', status: 'failed', code: 'upstream-unavailable', durationMs: 1 }))
    const dag = projector.frames().filter((frame) => frame.kind === 'dag').pop() as DagFrame
    const node = dag.nodes.find((candidate) => candidate.kind === 'plan')
    expect(node?.state).toBe('incident')
    expect(dag.summary).toContain('incident')
  })

  it('blocked 只落 node-blocked：无 result 也置 blocked，blockedBy 进 code', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('plan/node-started', { planId: 'p-1', nodeId: 'nB', tool: 'pay', ordinal: 2, callId: 'pc-3' }))
    projector.apply(ev('plan/node-blocked', { planId: 'p-1', nodeId: 'nB', blockedBy: ['n1'], reason: 'upstream-failed' }))
    const dag = projector.frames().filter((frame) => frame.kind === 'dag').pop() as DagFrame
    const node = dag.nodes.find((candidate) => candidate.kind === 'plan')
    expect(node?.state).toBe('blocked')
    expect(node?.code).toBe('blocked-by:n1')
  })

  it('skipped 与 cancelled 与 failed 三态互不混淆', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('plan/node-started', { planId: 'p-1', nodeId: 'a', tool: 'pay', ordinal: 1, callId: 'c1' }))
    projector.apply(ev('plan/node-result', { planId: 'p-1', nodeId: 'a', status: 'skipped', code: 'plan-dry-run' }))
    projector.apply(ev('plan/node-started', { planId: 'p-1', nodeId: 'b', tool: 'pay', ordinal: 2, callId: 'c2' }))
    projector.apply(ev('plan/node-result', { planId: 'p-1', nodeId: 'b', status: 'cancelled' }))
    const dag = projector.frames().filter((frame) => frame.kind === 'dag').pop() as DagFrame
    const states = dag.nodes.filter((node) => node.kind === 'plan').map((node) => node.state)
    expect(states).toEqual(['skipped', 'cancelled'])
  })

  it('plan/aborted 把还在 running 的节点置为 cancelled', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('plan/node-started', { planId: 'p-1', nodeId: 'n1', tool: 'pay', ordinal: 1, callId: 'c1' }))
    projector.apply(ev('plan/aborted', { planId: 'p-1', reason: 'halted' }))
    const dag = projector.frames().filter((frame) => frame.kind === 'dag').pop() as DagFrame
    const node = dag.nodes.find((candidate) => candidate.kind === 'plan')
    expect(node?.state).toBe('cancelled')
    expect(node?.code).toBe('plan-aborted')
  })

  it('plan/created 与 plan/resumed 不产空帧（节点要等 node-started）', () => {
    reset()
    const projector = new WebProjector()
    const a = projector.apply(ev('turn/start', { turn: 1 }))
    const before = projector.frames().length
    const created = projector.apply(ev('plan/created', { planId: 'p-1', nodes: 0, edges: 0, digest: 'd' }))
    const resumed = projector.apply(ev('plan/resumed', { planId: 'p-1', digest: 'd' }))
    // created/resumed 各产一帧收尾 DAG（同一帧 upsert），但不新增空 plan 节点
    expect(projector.frames().filter((frame) => frame.kind === 'dag').every(
      (frame) => frame.kind === 'dag' && frame.nodes.every((node) => node.kind !== 'plan'),
    )).toBe(true)
    expect(a.length + created.length + resumed.length).toBeGreaterThan(0)
    expect(projector.frames().length).toBeGreaterThanOrEqual(before)
  })
})

/** 造一个 plan 节点（`projectTodo` 的输入项；默认 running）。 */
function planNode(id: string, state: DagNode['state'], overrides: Partial<DagNode> = {}): DagNode {
  return {
    id,
    label: `${id} · transfer_create`,
    kind: 'plan',
    step: 0,
    tier: 'unknown',
    state,
    planId: 'p-1',
    ...overrides,
  }
}

describe('projectTodo · 待办派生（TC-MCH-22..24，施工单 01 §3.5）', () => {
  it('同输入连调两次逐字节相同；nodes 逆序后仍相同（确定性）', () => {
    const nodes = [planNode('b', 'running'), planNode('a', 'ok'), planNode('c', 'blocked')]
    const input = { turn: 1, seq: 9, at: 9, planId: 'p-1', nodes }
    const first = JSON.stringify(projectTodo(input))
    const second = JSON.stringify(projectTodo(input))
    const reversed = JSON.stringify(projectTodo({ ...input, nodes: [...nodes].reverse() }))
    expect(second).toBe(first)
    expect(reversed).toBe(first)
  })

  it('openCount = 未完成条数；排序为「未完成在前，再按 id 字典序」', () => {
    const frame = projectTodo({
      turn: 1,
      seq: 5,
      at: 5,
      planId: 'p-1',
      nodes: [planNode('d', 'failed'), planNode('a', 'ok'), planNode('c', 'pending'), planNode('b', 'skipped')],
    })
    expect(frame).not.toBeNull()
    expect(frame?.items.map((item) => item.id)).toEqual(['c', 'd', 'a', 'b'])
    expect(frame?.openCount).toBe(frame?.items.filter((item) => !item.done).length)
    expect(frame?.openCount).toBe(2)
  })

  it('无 plan 节点或无匹配 planId ⇒ null（不产空清单）', () => {
    expect(projectTodo({ turn: 1, seq: 1, at: 1, planId: 'p-1', nodes: [] })).toBeNull()
    expect(
      projectTodo({
        turn: 1,
        seq: 1,
        at: 1,
        planId: 'p-1',
        nodes: [{ ...planNode('a', 'ok'), kind: 'call' }],
      }),
    ).toBeNull()
    expect(
      projectTodo({ turn: 1, seq: 1, at: 1, planId: 'p-2', nodes: [planNode('a', 'ok')] }),
    ).toBeNull()
  })

  it('blockedBy 只出现在提供了依赖的节点上（其余无该键）', () => {
    const frame = projectTodo({
      turn: 1,
      seq: 3,
      at: 3,
      planId: 'p-1',
      nodes: [planNode('n1', 'failed'), planNode('n2', 'blocked')],
      blockedBy: { n2: ['n1'] },
    })
    const byId = new Map(frame?.items.map((item) => [item.id, item]))
    expect(byId.get('n2')?.blockedBy).toEqual(['n1'])
    const n1 = byId.get('n1')
    expect(n1 !== undefined && 'blockedBy' in n1).toBe(false)
  })

  it('9 态映射穷尽：done/tone 按 §3.5 表逐条断言', () => {
    const expected: ReadonlyArray<[DagNode['state'], boolean, string]> = [
      ['ok', true, 'success'],
      ['pending', false, 'default'],
      ['running', false, 'default'],
      ['blocked', false, 'warning'],
      ['denied', false, 'danger'],
      ['failed', false, 'danger'],
      ['incident', false, 'danger'],
      ['skipped', true, 'muted'],
      ['cancelled', true, 'muted'],
    ]
    const frame = projectTodo({
      turn: 1,
      seq: 2,
      at: 2,
      planId: 'p-1',
      nodes: expected.map(([state], index) => planNode(`n${String(index)}`, state)),
    })
    const byId = new Map(frame?.items.map((item) => [item.id, item]))
    for (const [index, [state, done, tone]] of expected.entries()) {
      const item = byId.get(`n${String(index)}`)
      expect({ state, done: item?.done, tone: item?.tone }).toEqual({ state, done, tone })
    }
    expect(frame?.items).toHaveLength(9)
  })

  it('projectPlan 接线：plan 事件产出 todo 帧，且 frameKey 按 turn+planId 替换', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('plan/node-started', { planId: 'p-1', nodeId: 'n1', tool: 'pay', ordinal: 1 }))
    projector.apply(ev('plan/node-result', { planId: 'p-1', nodeId: 'n1', status: 'succeeded' }))
    const todos = projector.frames().filter((frame) => frame.kind === 'todo') as TodoFrame[]
    expect(todos).toHaveLength(1)
    expect(todos[0]?.planId).toBe('p-1')
    expect(todos[0]?.items.map((item) => item.done)).toEqual([true])
    expect(todos[0]?.openCount).toBe(0)
  })

  it('projectPlan 接线：plan/node-blocked 的 blockedBy 出现在 todo 帧上', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('plan/node-started', { planId: 'p-1', nodeId: 'n1', tool: 'pay', ordinal: 1 }))
    projector.apply(ev('plan/node-started', { planId: 'p-1', nodeId: 'n2', tool: 'pay', ordinal: 2 }))
    projector.apply(ev('plan/node-blocked', { planId: 'p-1', nodeId: 'n2', blockedBy: ['n1'] }))
    const todo = projector.frames().filter((frame) => frame.kind === 'todo').pop() as TodoFrame
    const n2 = todo.items.find((item) => item.id.endsWith(':n2'))
    expect(n2?.blockedBy).toEqual(['n1'])
    expect(n2?.tone).toBe('warning')
  })
})

describe('projectEffects · 影响面派生（TC-MCH-25..26，施工单 01 §3.5 / V3）', () => {
  const base = { turn: 1, seq: 4, at: 4 }

  it('黄级成功 ⇒ 产出；红级 ⇒ 产出', () => {
    const yellow = projectEffects({
      ...base,
      items: [{ callId: 'c1', name: 'transfer_create', tier: 'yellow', args: { amount: 800 } }],
    })
    expect(yellow?.items.map((item) => item.name)).toEqual(['transfer_create'])
    const red = projectEffects({
      ...base,
      items: [{ callId: 'c2', name: 'card_report_lost', tier: 'red', args: {} }],
    })
    expect(red?.items).toHaveLength(1)
  })

  it('绿级 + 名字在注入名单 ⇒ 产出；绿级 + 不在名单 ⇒ 不产出（诚实边界）', () => {
    const input = {
      ...base,
      items: [
        { callId: 'c1', name: 'verify_sms', tier: 'green' as const, args: {} },
        { callId: 'c2', name: 'balance_query', tier: 'green' as const, args: {} },
      ],
    }
    // 未注入名单：绿级一律不产（含 verify_sms 的已知缺口，§9 V3 诚实边界）
    expect(projectEffects(input)).toBeNull()
    const injected = projectEffects({ ...input, writeToolNames: ['verify_sms'] })
    expect(injected?.items.map((item) => item.name)).toEqual(['verify_sms'])
  })

  it('tier 为 unknown 不产出（"不知道"不能当成"写"，§9 V8）', () => {
    expect(
      projectEffects({
        ...base,
        items: [{ callId: 'c', name: 'transfer_create', tier: 'unknown', args: {} }],
      }),
    ).toBeNull()
  })

  it('无候选 ⇒ null（不产空帧）；金额走 formatCents（与审批帧同款）', () => {
    expect(projectEffects({ ...base, items: [] })).toBeNull()
    const frame = projectEffects({
      ...base,
      items: [
        {
          callId: 'c1',
          name: 'transfer_create',
          tier: 'yellow',
          args: { amount: 800, payee: { name: '王建国' } },
          durationMs: 12,
          ticketId: 'ticket:call-1',
        },
      ],
    })
    expect(frame?.items[0]?.amountText).toBe('¥800.00')
    expect(frame?.items[0]?.durationMs).toBe(12)
    expect(frame?.ticketId).toBe('ticket:call-1')
  })

  it('projector 接线：成功写操作产出 effects 帧并按 turn 累积替换', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('step/start', { turn: 1, step: 1 }))
    for (const [callId, tier] of [
      ['c1', 'yellow'],
      ['c2', 'red'],
    ] as const) {
      projector.apply(
        ev('tool/call', {
          callId,
          name: 'transfer_create',
          args: { amount: 1 },
          fingerprint: `fp-${callId}`,
          tier: { level: tier },
        }),
      )
      projector.apply(
        ev('tool/result', { callId, name: 'transfer_create', isError: false, content: [], durationMs: 1 }),
      )
    }
    const effects = projector.frames().filter((frame) => frame.kind === 'effects') as EffectsFrame[]
    expect(effects).toHaveLength(1) // 同一 turn 只有一张（替换语义）
    expect(effects[0]?.items.map((item) => item.callId)).toEqual(['c1', 'c2'])
  })

  it('projector 接线：失败结果（isError）不产 effects 帧', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('step/start', { turn: 1, step: 1 }))
    projector.apply(
      ev('tool/call', {
        callId: 'c1',
        name: 'transfer_create',
        args: { amount: 800 },
        fingerprint: 'fp-1',
        tier: { level: 'yellow' },
      }),
    )
    projector.apply(
      ev('tool/result', { callId: 'c1', name: 'transfer_create', isError: true, content: [], code: 'PRV-002' }),
    )
    expect(projector.frames().some((frame) => frame.kind === 'effects')).toBe(false)
  })
})
