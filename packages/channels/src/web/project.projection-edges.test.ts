/**
 * 投影层的"异常收尾"与交互边界（补齐既有用例未覆盖的分支）。
 *
 * 选这些分支的理由：它们都直接决定用户看到什么——
 * - `turn/end` 的失败/判停/中断必须有对应提示，否则界面会把事故画成"完成"；
 * - `prompt_ask` 的候选投影了才有 choices 可点（03 单 D6）；
 * - 计划卡的条件文案是用户确认过的"到期自动办"的承诺，写错就是误导。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { deltaFrame, projectSession, WebProjector } from './project.ts'
import type {
  ApprovalClosedFrame,
  ChoiceFrame,
  GoalFrame,
  MessageFrame,
  NoticeFrame,
  PlanCardFrame,
} from './frames.ts'

let cursor = 0

function ev(type: string, data: unknown, at = 1_761_200_000_000): AnySessionEvent {
  cursor += 1
  return { seq: cursor, at, formatVersion: 1, type, data } as unknown as AnySessionEvent
}

function reset(): void {
  cursor = 0
}

function framesOf(events: readonly AnySessionEvent[]): readonly { kind: string }[] {
  return projectSession(events).frames
}

function noticesOf(events: readonly AnySessionEvent[]): NoticeFrame[] {
  return framesOf(events).filter((frame): frame is NoticeFrame => frame.kind === 'notice')
}

describe('turn/end 的异常收尾提示（不把事故画成完成）', () => {
  const cases = [
    { kind: 'blocked', level: 'warning', title: '本轮被入口拦截' },
    { kind: 'aborted', level: 'warning', title: '本轮已中断' },
    { kind: 'max-tokens', level: 'danger', title: '达到输出上限' },
  ] as const

  for (const item of cases) {
    it(`${item.kind} ⇒ ${item.level} 提示「${item.title}」且不编理由`, () => {
      reset()
      const notices = noticesOf([
        ev('turn/start', { turn: 1 }),
        ev('turn/end', { turn: 1, reason: { kind: item.kind } }),
      ])
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({ level: item.level, title: item.title })
      expect(notices[0]?.text).toBeUndefined()
      expect(notices[0]?.code).toBeUndefined()
    })
  }

  it('guard-stopped / failed ⇒ 提示带理由文本与理由码', () => {
    reset()
    const guard = noticesOf([
      ev('turn/start', { turn: 1 }),
      ev('turn/end', { turn: 1, reason: { kind: 'guard-stopped', reason: '连续同参调用' } }),
    ])
    expect(guard[0]).toMatchObject({
      level: 'warning',
      title: '主循环已判停',
      text: '连续同参调用',
      code: 'guard-stopped',
    })

    reset()
    const failed = noticesOf([
      ev('turn/start', { turn: 1 }),
      ev('turn/end', { turn: 1, reason: { kind: 'failed', reason: 'provider 502' } }),
    ])
    expect(failed[0]).toMatchObject({
      level: 'danger',
      title: '本轮失败',
      text: 'provider 502',
      code: 'failed',
    })
  })

  it('completed ⇒ 不产提示帧（完成是默认语义，不需要额外叙事）', () => {
    reset()
    const frames = framesOf([
      ev('turn/start', { turn: 1 }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(frames.filter((frame) => frame.kind === 'notice')).toHaveLength(0)
  })
})

describe('模型尝试与压缩的提示帧', () => {
  it('assistant/attempt：retried 只留痕不产帧；cancelled/failed 产 warning', () => {
    reset()
    expect(framesOf([ev('assistant/attempt', { status: 'retried' })])).toEqual([])

    reset()
    const cancelled = noticesOf([
      ev('assistant/attempt', { status: 'cancelled', reason: '用户中断' }),
    ])
    expect(cancelled[0]).toMatchObject({
      level: 'warning',
      title: '模型调用已取消',
      text: '用户中断',
    })

    reset()
    const failed = noticesOf([ev('assistant/attempt', { status: 'failed' })])
    expect(failed[0]).toMatchObject({ level: 'warning', title: '模型调用失败' })
    expect(failed[0]?.text).toBeUndefined()
  })

  it('compaction/summary ⇒ info 提示，轮数与摘要原样透传', () => {
    reset()
    const notices = noticesOf([
      ev('compaction/summary', {
        fromTurn: 1,
        toTurn: 3,
        turns: 3,
        summary: '用户查询了三笔余额并完成一次转账。',
        refs: [1, 2, 3],
        financial: [],
        droppedMessages: 6,
      }),
    ])
    expect(notices[0]).toMatchObject({
      level: 'info',
      title: '上下文已压缩（折叠 3 轮）',
      text: '用户查询了三笔余额并完成一次转账。',
    })
  })
})

describe('prompt_ask → choice 帧', () => {
  function askEvents(args: unknown, isError = false): AnySessionEvent[] {
    reset()
    return [
      ev('turn/start', { turn: 1 }),
      ev('step/start', { turn: 1, step: 1 }),
      ev('tool/call', {
        callId: 'ask-1',
        name: 'prompt_ask',
        args,
        fingerprint: 'fp-ask',
        tier: { level: 'green' },
        at: 1_761_200_000_000,
      }),
      ev('tool/result', {
        callId: 'ask-1',
        name: 'prompt_ask',
        isError,
        content: [{ type: 'text', text: '请选择' }],
      }),
    ]
  }

  it('成功追问 ⇒ 候选最多 3 个、坏形状跳过、恒可自由输入', () => {
    const frames = framesOf(
      askEvents({
        question: '给哪张卡还款？',
        candidates: [
          { label: '尾号 1234', value: 'card-1' },
          { label: '尾号 5678', value: 'card-2' },
          { label: '尾号 9012', value: 'card-3' },
          { label: '第四个不该出现', value: 'card-4' },
          null,
          { label: '缺 value' },
        ],
      }),
    )
    const choice = frames.find((frame): frame is ChoiceFrame => frame.kind === 'choice')
    expect(choice).toMatchObject({
      callId: 'ask-1',
      prompt: '给哪张卡还款？',
      allowFreeText: true,
    })
    expect(choice?.options).toEqual([
      { id: 'card-1', label: '尾号 1234' },
      { id: 'card-2', label: '尾号 5678' },
      { id: 'card-3', label: '尾号 9012' },
    ])
  })

  it('追问失败 ⇒ 不产 choice 帧（失败不是"让用户选"）', () => {
    const frames = framesOf(
      askEvents({ question: '选哪个？', candidates: [{ label: 'A', value: 'a' }] }, true),
    )
    expect(frames.filter((frame) => frame.kind === 'choice')).toHaveLength(0)
  })
})

describe('消息块与目标终态', () => {
  it('助手消息：图片保留 mimeType，未知块只留"有内容"这个事实', () => {
    reset()
    const frames = framesOf([
      ev('assistant/message', {
        content: [
          { type: 'text', text: '图如下' },
          { type: 'image', data: 'AAA', mimeType: 'image/jpeg' },
          { type: 'tool_use', id: 'x' },
        ],
      }),
    ])
    const message = frames.find((frame): frame is MessageFrame => frame.kind === 'message')
    expect(message?.blocks).toEqual([
      { type: 'text', text: '图如下' },
      { type: 'image', mimeType: 'image/jpeg', data: 'AAA' },
      { type: 'other', summary: 'tool_use' },
    ])
  })

  for (const status of ['abandoned', 'expired'] as const) {
    it(`goal_set 的 ${status} 终态要画成目标卡（不吞掉用户的目标）`, () => {
      reset()
      const frames = framesOf([
        ev('tool/result', {
          callId: 'goal-1',
          name: 'goal_set',
          isError: false,
          content: [
            { type: 'text', text: JSON.stringify({ statement: '攒够装修款', status }) },
          ],
        }),
      ])
      const goal = frames.find((frame): frame is GoalFrame => frame.kind === 'goal')
      expect(goal).toMatchObject({ title: '攒够装修款', status })
    })
  }
})

describe('审批结论文案', () => {
  const cases = [
    { decision: 'allowed-once', label: '已批准（一次性）' },
    { decision: 'rejected', label: '已拒绝' },
    { decision: 'cancelled', label: '已取消' },
    { decision: 'unavailable', label: '无人应答（视为拒绝）' },
  ] as const

  for (const item of cases) {
    it(`${item.decision} ⇒ 「${item.label}」`, () => {
      reset()
      const frames = framesOf([
        ev('approval/decided', { ticketId: 't-1', decision: item.decision }),
      ])
      const closed = frames.find(
        (frame): frame is ApprovalClosedFrame => frame.kind === 'approval-closed',
      )
      expect(closed).toMatchObject({ ticketId: 't-1', decision: item.decision, label: item.label })
    })
  }
})

describe('计划卡的条件文案与出参兜底', () => {
  function planCardOfArm(payload: unknown): PlanCardFrame | undefined {
    reset()
    const frames = framesOf([
      ev('tool/result', {
        callId: `call-${String(cursor + 1)}`,
        name: 'plan_arm',
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      }),
    ])
    return frames.find((frame): frame is PlanCardFrame => frame.kind === 'plan-card')
  }

  it('四类条件的期望值按运行时同口径渲染；未知 kind 原样显示', () => {
    const card = planCardOfArm({
      planId: 'p-1',
      windowId: 'w-1',
      planDigest: 'sha-1',
      dueAt: 1_761_300_000_000,
      budgetCents: 10_000,
      conditions: [
        { kind: 'balance-at-least', cents: 100_000 },
        { kind: 'amount-within', cents: 5_000 },
        { kind: 'fact-unchanged', factId: 'f-1', version: 2 },
        { kind: 'address-unchanged', addressId: 'a-1', version: 3 },
        { kind: 'plan-not-cancelled' },
        { kind: 'mystery' },
      ],
    })
    expect(card?.conditions.map((condition) => condition.expected)).toEqual([
      '>= 100000',
      '<= 5000',
      'f-1@2',
      'a-1@3',
      '未被撤销',
      'mystery',
    ])
  })

  it('tier 非法回落 standard；缺 plan/nodes 时 nodeCount=0；缺 windowId 不造卡', () => {
    const card = planCardOfArm({
      planId: 'p-2',
      windowId: 'w-2',
      planDigest: 'sha-2',
      dueAt: 1_761_300_000_000,
      budgetCents: 0,
      tier: 'ultra',
    })
    expect(card).toMatchObject({ tier: 'standard', nodeCount: 0, budgetText: '¥0.00' })

    expect(
      planCardOfArm({ planId: 'p-3', planDigest: 'sha-3', dueAt: 1_761_300_000_000 }),
    ).toBeUndefined()
  })

  it('出参是 JSON 数组 / 非对象 ⇒ 不造卡（投影层只认对象）', () => {
    expect(planCardOfArm([{ planId: 'p-4', windowId: 'w-4' }])).toBeUndefined()
    expect(planCardOfArm('not-an-object')).toBeUndefined()
  })

  it('周期：合法 recurrence 由投影层算 occurrence；非法形状回落 once', () => {
    const daily = planCardOfArm({
      planId: 'p-5',
      windowId: 'w-5',
      planDigest: 'sha-5',
      dueAt: 1_761_300_000_000,
      budgetCents: 100,
      recurrence: { every: 'daily', at: '09:00' },
    })
    expect(daily?.occurrence).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const invalid = planCardOfArm({
      planId: 'p-6',
      windowId: 'w-6',
      planDigest: 'sha-6',
      dueAt: 1_761_300_000_000,
      budgetCents: 100,
      recurrence: { every: 'weekly' },
    })
    expect(invalid?.occurrence).toBe('once:1761300000000')
  })

  it('plan_wake 未知状态的条目沿用原卡状态；blocked>0 的 executed 判 failed', () => {
    reset()
    const frames = framesOf([
      ev('tool/result', {
        callId: 'arm-1',
        name: 'plan_arm',
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              planId: 'p-7',
              windowId: 'w-7',
              planDigest: 'sha-7',
              dueAt: 1_761_300_000_000,
              budgetCents: 100,
            }),
          },
        ],
      }),
      ev('tool/result', {
        callId: 'wake-1',
        name: 'plan_wake',
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              entries: [
                { windowId: 'w-7', planId: 'p-7', status: 'skipped', key: 'k1' },
                {
                  windowId: 'w-7',
                  planId: 'p-7',
                  status: 'executed',
                  summary: { failed: 0, blocked: 1 },
                  key: 'k2',
                },
              ],
            }),
          },
        ],
      }),
    ])
    const cards = frames.filter((frame): frame is PlanCardFrame => frame.kind === 'plan-card')
    expect(cards.at(-1)?.state).toBe('failed')
  })
})

describe('流式与轮次读取', () => {
  it('deltaFrame 是临时帧：不进 seq 账本、不产快照', () => {
    expect(deltaFrame('正在输入', 1_761_200_000_000)).toEqual({
      kind: 'delta',
      at: 1_761_200_000_000,
      text: '正在输入',
    })
  })

  it('currentTurn 在读入 turn/start 后返回当前轮次', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 4 }))
    expect(projector.currentTurn()).toBe(4)
  })
})
