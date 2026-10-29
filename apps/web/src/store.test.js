/**
 * 前端仓库用例（快照替换 / 按键更新 / 草稿清理）。
 *
 * 断言的是"帧怎么变成界面状态"，不是 DOM 长什么样（DOM 各视图自己测）。
 */

import { describe, expect, it } from 'vitest'

import { approvalDecision, createStore, frameKey, pendingApproval, viewKey } from './store.js'

/** 造一条提示帧。 */
function notice(seq, title = `#${seq}`) {
  return { kind: 'notice', seq, at: 1_700_000_000_000 + seq, level: 'info', title }
}

describe('store · 帧归并', () => {
  it('同一视图键替换，不追加（三态更新靠它）', () => {
    const store = createStore()
    store.apply({ kind: 'tool', seq: 1, callId: 'c1', state: 'pending' })
    store.apply({ kind: 'tool', seq: 2, callId: 'c1', state: 'done' })

    const frames = store.state().frames
    expect(frames).toHaveLength(1)
    expect(frames[0].state).toBe('done')
  })

  it('快照整体替换（重连后不会半新半旧）', () => {
    const store = createStore()
    store.apply(notice(1))
    store.apply(notice(2))
    store.apply({ kind: 'snapshot', sessionId: 's', maxSeq: 9, frames: [notice(9)] })

    const frames = store.state().frames
    expect(frames.map((frame) => frame.seq)).toEqual([9])
  })

  it('草稿累积；权威消息到达即清空', () => {
    const store = createStore()
    store.apply({ kind: 'delta', at: 1, text: '你' })
    store.apply({ kind: 'delta', at: 2, text: '好' })
    expect(store.state().streamText).toBe('你好')

    store.apply({ kind: 'message', seq: 3, role: 'assistant', blocks: [{ type: 'text', text: '你好' }] })
    expect(store.state().streamText).toBe('')
  })

  it('用户/上下文消息不清草稿（只有助手消息才收口）', () => {
    const store = createStore()
    store.apply({ kind: 'delta', at: 1, text: '生成中' })
    store.apply({ kind: 'message', seq: 2, role: 'user', blocks: [{ type: 'text', text: '继续' }] })
    expect(store.state().streamText).toBe('生成中')

    store.apply({ kind: 'message', seq: 3, role: 'assistant', blocks: [{ type: 'text', text: '好了' }] })
    expect(store.state().streamText).toBe('')
  })

  it('失败收尾后草稿不残留（没有权威助手消息的路径）', () => {
    const store = createStore()
    store.apply({ kind: 'delta', at: 1, text: '已经为您' })
    store.apply({ kind: 'turn', seq: 2, at: 2, turn: 1, phase: 'end', endKind: 'failed' })
    expect(store.state().streamText).toBe('')
  })

  it('新一轮开始也丢掉上一轮残稿', () => {
    const store = createStore()
    store.apply({ kind: 'delta', at: 1, text: '半句话' })
    store.apply({ kind: 'turn', seq: 2, at: 2, turn: 2, phase: 'start' })
    expect(store.state().streamText).toBe('')
  })

  it('reset 清空帧、草稿与连接状态（不是只清帧）', () => {
    const store = createStore()
    store.apply(notice(1))
    store.apply({ kind: 'delta', at: 1, text: '草稿' })
    store.setStatus('online')
    store.setFault({ code: 'x', reason: 'y' })

    store.reset()

    const state = store.state()
    expect(state.frames).toEqual([])
    expect(state.streamText).toBe('')
    expect(state.status).toBe('connecting')
    expect(state.fault).toBeNull()
  })

  it('订阅能收到状态；退订后不再收到', () => {
    const store = createStore()
    let calls = 0
    const off = store.subscribe(() => {
      calls += 1
    })
    store.apply(notice(1))
    expect(calls).toBe(1)
    off()
    store.apply(notice(2))
    expect(calls).toBe(1)
  })
})

describe('store · 帧键', () => {
  it('视图键把 turn 的 start/end 合并（避免两条分割线）', () => {
    const start = { kind: 'turn', seq: 1, turn: 2, phase: 'start' }
    const end = { kind: 'turn', seq: 9, turn: 2, phase: 'end', endKind: 'completed' }
    expect(viewKey(start)).toBe(viewKey(end))
    // 仓库键保留 phase（审计要区分）
    expect(frameKey(start)).not.toBe(frameKey(end))
  })
})

describe('store · 审批查询', () => {
  const approval = { kind: 'approval', seq: 3, ticketId: 't1', callId: 'c1', operation: '转账' }
  const closed = { kind: 'approval-closed', seq: 4, ticketId: 't1', decision: 'rejected' }

  it('未收尾的审批才算待办', () => {
    expect(pendingApproval([approval])).toBe(approval)
    expect(pendingApproval([approval, closed])).toBeNull()
  })

  it('能取到指定票据的结论', () => {
    expect(approvalDecision([approval, closed], 't1')).toBe(closed)
    expect(approvalDecision([approval], 't1')).toBeNull()
  })
})
