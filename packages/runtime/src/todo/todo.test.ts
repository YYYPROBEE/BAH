/**
 * todo 平面（§7 TC-XSC-21/22/23 + todo_write）。
 *
 * 两条红线：
 * 1. 派生器与 `replayPlan` **同源同序**——状态不自己重算，复用即同源，抄写必漂移；
 * 2. 中断窗口里没落 per-node 事件的剩余节点必须显示"已取消"，不能显示"排队中"。
 */

import { describe, expect, it } from 'vitest'

import { deriveTodos, mergeTodoEntries, normalizeText, windowAborted } from './derive.ts'
import { createTodoWriteTool, MAX_TODO_ITEMS } from './tool.ts'

import { replayPlan } from '../plan/engine.ts'
import type { PlanEventRecord } from '../plan/events.ts'
import type { ToolExecContext } from '@bah/core'

const PLAN = 'p-1'

function rec(type: string, data: Readonly<Record<string, unknown>>): PlanEventRecord {
  return { type, data: { planId: PLAN, ...data } }
}

/** 一次中断前的历史：a 成功，b 被上游阻塞，c 从未启动。 */
function interruptedHistory(): PlanEventRecord[] {
  return [
    rec('plan/created', { digest: 'd', nodes: 3, edges: 2, dryRun: false, initiator: 's', at: 1 }),
    rec('plan/node-started', { nodeId: 'a', tool: 'transfer_create', ordinal: 1, callId: 'c-a', at: 2 }),
    rec('plan/node-result', { nodeId: 'a', status: 'succeeded', durationMs: 1, at: 3 }),
    rec('plan/node-started', { nodeId: 'b', tool: 'transfer_create', ordinal: 2, callId: 'c-b', at: 4 }),
    rec('plan/node-blocked', { nodeId: 'b', blockedBy: ['a'], reason: 'upstream-failed', at: 5 }),
    rec('plan/aborted', { reason: 'cancelled', atNode: 'c', at: 6 }),
    rec('plan/completed', {
      status: 'aborted',
      total: 3,
      succeeded: 1,
      failed: 0,
      blocked: 1,
      skipped: 0,
      cancelled: 2,
      durationMs: 5,
      at: 7,
    }),
  ]
}

describe('TC-XSC-21 同源同序', () => {
  it('deriveTodos 的 (nodeId,state) 序列 == replayPlan 还原的序列', () => {
    const history = interruptedHistory()
    const order = ['a', 'b', 'c']
    const entries = deriveTodos(order, history, PLAN, true)
    const replay = replayPlan(history, PLAN)

    for (const entry of entries) {
      if (replay.states.has(entry.nodeId)) {
        expect(entry.state).toBe(replay.states.get(entry.nodeId))
      }
    }
    expect(entries.map((entry) => [entry.nodeId, entry.state])).toEqual([
      ['a', 'succeeded'],
      ['b', 'blocked'],
      ['c', 'cancelled'],
    ])
  })

  it('中断窗口的剩余节点 = cancelled（引擎不落 per-node 事件，派生器镜像该语义）', () => {
    const entries = deriveTodos(['a', 'b', 'c'], interruptedHistory(), PLAN, true)
    expect(entries.map((entry) => entry.state)).toEqual(['succeeded', 'blocked', 'cancelled'])
  })

  it('未中断 ⇒ 未启动节点是 pending（不冒充已取消）', () => {
    const history = interruptedHistory().filter(
      (event) => event.type !== 'plan/aborted' && event.type !== 'plan/completed',
    )
    const entries = deriveTodos(['a', 'c'], history, PLAN, false)
    expect(entries[1]?.state).toBe('pending')
  })

  it('windowAborted：created 清零、aborted 置位（引擎先 aborted 后 completed）', () => {
    const history = interruptedHistory()
    expect(windowAborted(history, PLAN)).toBe(true)
    expect(windowAborted(history.filter((event) => event.type !== 'plan/aborted'), PLAN)).toBe(false)
    expect(windowAborted(history, 'p-other')).toBe(false)
  })
})

describe('TC-XSC-22 纯函数', () => {
  it('同输入两次调用输出深相等；ordinal 即入参拓扑序', () => {
    const history = interruptedHistory()
    const first = deriveTodos(['a', 'b', 'c'], history, PLAN, true)
    const second = deriveTodos(['a', 'b', 'c'], history, PLAN, true)
    expect(second).toEqual(first)
    expect(first.map((entry) => entry.ordinal)).toEqual([0, 1, 2])
  })

  it('异 planId 的事件不参与（同一会话混着别的计划）', () => {
    const other = rec('plan/node-started', { planId: 'p-2', nodeId: 'x', tool: 't', ordinal: 1, callId: 'c-x', at: 9 })
    const entries = deriveTodos(['x'], [other], PLAN, false)
    expect(entries[0]?.state).toBe('pending')
  })
})

describe('TC-XSC-23 同屏合并规则', () => {
  const planEntries = deriveTodos(['a'], interruptedHistory(), PLAN, true)

  it('plan 在前、model 在后；规范化重复时保留 plan 条目', () => {
    const merged = mergeTodoEntries(planEntries, [
      { text: '上传身份证照片', done: false },
      { text: ' a ', done: true },
    ])
    expect(merged.map((entry) => [entry.source, entry.text])).toEqual([
      ['plan', 'a'],
      ['model', '上传身份证照片'],
    ])
    expect(merged[1]?.ordinal).toBe(1000)
  })

  it('规范化：trim、空白折叠、全角转半角', () => {
    expect(normalizeText('  上传　身份证   照片  ')).toBe('上传 身份证 照片')
    expect(normalizeText('ＡＢＣ')).toBe('ABC')
  })

  it('合并是纯函数：不改入参、不落账', () => {
    const before = JSON.stringify(planEntries)
    mergeTodoEntries(planEntries, [{ text: 'b', done: true }])
    expect(JSON.stringify(planEntries)).toBe(before)
  })
})

describe('todo_write 工具', () => {
  const ctx = (): ToolExecContext => ({
    sessionId: 's-todo' as ToolExecContext['sessionId'],
    callId: 'call-todo',
    signal: new AbortController().signal,
  })

  it('全量覆写：出参即现状，writtenAt 取注入钟（默认 false）', async () => {
    const tool = createTodoWriteTool({ now: () => 42 })
    const result = await tool.execute({ items: [{ text: '  上传身份证照片 ' }, { text: '预约体检', done: true }] }, ctx())
    expect(result.items).toEqual([
      { text: '上传身份证照片', done: false, writtenAt: 42 },
      { text: '预约体检', done: true, writtenAt: 42 },
    ])
    const cleared = await tool.execute({ items: [] }, ctx())
    expect(cleared.items).toEqual([])
  })

  it('上限与空文案 fail-loud', async () => {
    const tool = createTodoWriteTool({ now: () => 1 })
    const tooMany = Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, index) => ({ text: `item-${String(index)}` }))
    await expect(tool.execute({ items: tooMany }, ctx())).rejects.toMatchObject({ code: 'todo-limit-exceeded' })
    await expect(tool.execute({ items: [{ text: '  ' }] }, ctx())).rejects.toMatchObject({
      code: 'todo-invalid-item',
    })
    await expect(tool.execute({ items: [{ text: 'x'.repeat(201) }] }, ctx())).rejects.toMatchObject({
      code: 'todo-limit-exceeded',
    })
    await expect(
      tool.execute({ items: 'nope' as unknown as [] }, ctx()),
    ).rejects.toMatchObject({ code: 'todo-invalid-item' })
  })

  it('声明：绿级、sideEffect none、description 明令禁止跟踪 plan 节点', () => {
    const tool = createTodoWriteTool({ now: () => 1 })
    expect(tool.tier.level).toBe('green')
    expect(tool.sideEffect).toBe('none')
    expect(tool.description).toContain('本工具不得用于跟踪 plan 节点')
  })
})

