/**
 * 投影器用例（施工单 13 §5 T-WEB-002 / 005 / 006 / 007 + 审批六要素 / 审计 / 幂等）。
 *
 * 纪律：这里只喂**事件**，断言**帧**。不碰 DOM、不碰 HTTP、不读时钟——
 * 一旦某条断言需要真实时间，说明投影层混进了副作用。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { projectSession, WebProjector } from './project.ts'
import type { ApprovalFrame, AuditFrame, DagFrame, ToolFrame, TurnFrame } from './frames.ts'

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
