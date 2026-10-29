/**
 * goal 平面（04 单 §7 TC-XSC-26/27/28 + 工具形状）。
 *
 * 重点不是 CRUD，而是三条账本纪律：
 * 1. 非法转移 fail-loud（静默吞掉 = 账本说谎）；
 * 2. active 上限封顶，超出不隐式淘汰；
 * 3. 进程内 store 可由 `tool/result` 重放重建——"落账"是真的，"数据库"是没有的。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, captureThrown } from '@bah/test-support'

import { createGoalStore, MAX_ACTIVE_GOALS, replayGoalStore } from './store.ts'
import { createGoalSetTool } from './tool.ts'

import type { AnySessionEvent } from '../session/types.ts'
import type { Goal } from './types.ts'
import type { ToolExecContext } from '@bah/core'

let seq = 0

function store(now = 1_700_000_000_000): ReturnType<typeof createGoalStore> {
  seq = 0
  return createGoalStore({ now: () => now, nextId: () => `g-${String(++seq)}` })
}

function ctx(): ToolExecContext {
  return {
    sessionId: asSessionId('s-goal'),
    callId: 'call-goal',
    signal: new AbortController().signal,
  }
}

/** 造一条 goal_set 的 tool/result 事件（正文 = 结果 JSON，与管线默认投影一致）。 */
function goalResult(goal: Goal, at = 1): AnySessionEvent {
  return {
    seq: at,
    at,
    formatVersion: 1,
    type: 'tool/result',
    data: {
      callId: `call-${String(at)}`,
      name: 'goal_set',
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(goal) }],
    },
  } as AnySessionEvent
}

describe('GoalStore：状态机与上限', () => {
  it('TC-XSC-26 非法转移即抛：achieved→active、active→active', () => {
    const goals = store()
    const goal = goals.create({ statement: '准备生日', originTurn: 1 })
    const closed = goals.close(goal.goalId, 'achieved')

    expect(closed.status).toBe('achieved')
    expect(captureThrown(() => goals.close(goal.goalId, 'expired')).code).toBe('goal-illegal-transition')
    expect(
      captureThrown(() => goals.close(goal.goalId, 'active' as unknown as 'expired')).code,
    ).toBe('goal-illegal-transition')
    expect(captureThrown(() => goals.linkPlan(goal.goalId, 'p-1')).code).toBe('goal-illegal-transition')
  })

  it('TC-XSC-27 第 9 个 active goal ⇒ goal-limit-exceeded（不隐式淘汰）', () => {
    const goals = store()
    for (let index = 0; index < MAX_ACTIVE_GOALS; index += 1) {
      goals.create({ statement: `目标 ${String(index)}`, originTurn: index + 1 })
    }
    expect(captureThrown(() => goals.create({ statement: '第九个', originTurn: 9 })).code).toBe(
      'goal-limit-exceeded',
    )
    expect(goals.listActive()).toHaveLength(MAX_ACTIVE_GOALS)
  })

  it('多 goal 并存：两个 active 互不影响；关闭一个不影响另一个', () => {
    const goals = store()
    const first = goals.create({ statement: '准备生日', originTurn: 1 })
    const second = goals.create({ statement: '查账单', originTurn: 2 })
    goals.close(first.goalId, 'abandoned')
    expect(goals.listActive().map((goal) => goal.goalId)).toEqual([second.goalId])
    expect(goals.get(first.goalId)?.status).toBe('abandoned')
    expect(goals.get('g-404')).toBeUndefined()
    expect(captureThrown(() => goals.close('g-404', 'achieved')).code).toBe('goal-not-found')
  })

  it('linkPlan：active 才能关联；已关联不重复改状态', () => {
    const goals = store()
    const goal = goals.create({ statement: '准备生日', originTurn: 1 })
    expect(goals.linkPlan(goal.goalId, 'p-1').planId).toBe('p-1')
  })
})

describe('TC-XSC-28 重放重建', () => {
  it('kill store 后按 tool/result 重放 ⇒ listAll 深相等（含关闭时间与预算）', () => {
    const goals = store()
    const created = goals.create({
      statement: '为配偶下月 8 日生日做准备',
      originTurn: 3,
      budget: { amountCents: 150_000, currency: 'CNY' },
      constraints: ['只用活期余额'],
    })
    const closed = goals.close(created.goalId, 'achieved')
    const before = goals.listAll()

    const events = [goalResult(created, 1), goalResult(closed, 2)]
    const replayed = replayGoalStore(events, { now: () => 0, nextId: () => 'g-new' })

    expect(replayed.listAll()).toEqual(before)
    expect(replayed.listAll()[0]?.closedAt).toBe(closed.closedAt)
  })

  it('同 goalId 后写覆盖先写；失败的调用不投影；坏 JSON 直接 fail-loud', () => {
    const goals = store()
    const created = goals.create({ statement: '准备生日', originTurn: 1 })
    const closed = goals.close(created.goalId, 'abandoned')
    const failed = {
      ...goalResult(closed, 3),
      data: { callId: 'c3', name: 'goal_set', isError: true, content: [{ type: 'text', text: 'boom' }] },
    } as AnySessionEvent

    const replayed = replayGoalStore([goalResult(created, 1), goalResult(closed, 2), failed], {
      now: () => 0,
      nextId: () => 'g-new',
    })
    expect(replayed.get(created.goalId)?.status).toBe('abandoned')

    const corrupt = {
      seq: 1,
      at: 1,
      formatVersion: 1,
      type: 'tool/result',
      data: { callId: 'c-bad', name: 'goal_set', isError: false, content: [{ type: 'text', text: '{oops' }] },
    } as AnySessionEvent
    expect(captureThrown(() => replayGoalStore([corrupt], { now: () => 0, nextId: () => 'x' })).code).toBe(
      'goal-replay-invalid',
    )
  })

  it('结果正文是数组 / 缺 goalId 或状态非法 ⇒ goal-replay-invalid（不许静默跳过）', () => {
    const asEvent = (text: string): AnySessionEvent =>
      ({
        seq: 1,
        at: 1,
        formatVersion: 1,
        type: 'tool/result',
        data: { callId: 'c', name: 'goal_set', isError: false, content: [{ type: 'text', text }] },
      }) as AnySessionEvent
    for (const text of ['[]', '[1,2]', '{"status":"active"}', '{"goalId":"g-1","status":"weird"}']) {
      expect(captureThrown(() => replayGoalStore([asEvent(text)], { now: () => 0, nextId: () => 'x' })).code).toBe(
        'goal-replay-invalid',
      )
    }
  })

  it('非 goal_set 的 tool/result 不参与重建', () => {
    const goals = store()
    const created = goals.create({ statement: '准备生日', originTurn: 1 })
    const other = {
      ...goalResult(created, 2),
      data: { callId: 'c9', name: 'account_balance', isError: false, content: [{ type: 'text', text: '{}' }] },
    } as AnySessionEvent
    expect(replayGoalStore([other], { now: () => 0, nextId: () => 'x' }).listAll()).toEqual([])
  })
})

describe('goal_set 工具', () => {
  const makeTool = (turn = 4) => {
    const goals = store()
    return {
      goals,
      tool: createGoalSetTool(goals, { turnOf: () => turn, toCents: (yuan) => Math.round(yuan * 100) }),
    }
  }

  it('新建：预算按元入、分入账；originTurn 取注入值', async () => {
    const { tool } = makeTool(7)
    const result = await tool.execute(
      { statement: '  为配偶生日做准备  ', budget: { amount: 1500, currency: 'CNY' }, planId: 'p-1' },
      ctx(),
    )
    expect(result).toMatchObject({
      statement: '为配偶生日做准备',
      status: 'active',
      originTurn: 7,
      planId: 'p-1',
      budget: { amountCents: 150_000, currency: 'CNY' },
    })
    expect(result.createdAt).toBe(1_700_000_000_000)
  })

  it('关闭：goalId + status 必须成对；关闭后状态落终态', async () => {
    const { tool } = makeTool()
    const created = await tool.execute({ statement: '准备生日' }, ctx())
    const closed = await tool.execute({ goalId: created.goalId, status: 'achieved' }, ctx())
    expect(closed.status).toBe('achieved')
    expect(closed.closedAt).toBe(1_700_000_000_000)
  })

  it('形状错误逐条 fail-loud（statement 与 goalId 同时给/都不给/空陈述/非法预算）', async () => {
    const { tool } = makeTool()
    const call = (args: Parameters<typeof tool.execute>[0]) =>
      tool.execute(args, ctx()) as Promise<unknown>

    await expect(call({ statement: 'a', goalId: 'g-1', status: 'achieved' })).rejects.toMatchObject({
      code: 'goal-invalid-shape',
    })
    await expect(call({})).rejects.toMatchObject({ code: 'goal-invalid-shape' })
    await expect(call({ goalId: 'g-1' })).rejects.toMatchObject({ code: 'goal-invalid-shape' })
    await expect(call({ statement: '   ' })).rejects.toMatchObject({ code: 'goal-invalid-shape' })
    await expect(call({ statement: 'x', budget: { amount: 0 } })).rejects.toMatchObject({
      code: 'goal-invalid-shape',
    })
    await expect(call({ statement: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'goal-invalid-shape' })
  })

  it('工具声明是绿级 + sideEffect none（不进 effects 清单）', () => {
    const { tool } = makeTool()
    expect(tool.tier.level).toBe('green')
    expect(tool.sideEffect).toBe('none')
    expect(tool.projectContent).toBeUndefined()
    expect(tool.description).toContain('不产生任何资金副作用')
  })
})
