/**
 * session-follow 用例。
 *
 * 三条断言对应用户能感知的三件事：重连不重复、缺口不静默、缓冲不无限增长。
 */

import { describe, expect, it } from 'vitest'

import { SessionFollow } from './follow.ts'
import type { NoticeFrame, SnapshotFrame, WebFrame } from './frames.ts'

/** 造一条带 seq 的普通帧。 */
function notice(seq: number): NoticeFrame {
  return { kind: 'notice', seq, at: 1_700_000_000_000 + seq, level: 'info', title: `#${String(seq)}` }
}

/** 造快照。 */
function snapshot(maxSeq: number, frames: readonly WebFrame[] = []): SnapshotFrame {
  return { kind: 'snapshot', sessionId: 's-1', maxSeq, frames }
}

describe('SessionFollow · 续订（T-WEB-001）', () => {
  it('已在 12 时重连 → 只应用 13..20，不重不漏', () => {
    const follow = new SessionFollow()
    follow.accept(snapshot(12, Array.from({ length: 12 }, (_, index) => notice(index + 1))))

    const applied: number[] = []
    for (let seq = 13; seq <= 20; seq += 1) {
      const decision = follow.accept(notice(seq))
      expect(decision.kind).toBe('apply')
      if (decision.kind === 'apply') applied.push(seq)
    }
    expect(applied).toEqual([13, 14, 15, 16, 17, 18, 19, 20])
    expect(follow.since()).toBe(20)
  })

  it('重放已应用的 seq 一律丢弃（服务端补发边界重复）', () => {
    const follow = new SessionFollow()
    follow.accept(snapshot(5))

    const decision = follow.accept(notice(5))
    expect(decision).toEqual({ kind: 'drop', reason: 'replayed' })
    expect(follow.since()).toBe(5)
  })

  it('缺口（跳号）不静默吞掉，直接要求重同步', () => {
    const follow = new SessionFollow()
    follow.accept(snapshot(5))

    const decision = follow.accept(notice(8))
    expect(decision).toEqual({ kind: 'resync', reason: 'gap', since: 0 })
    expect(follow.isResyncing()).toBe(true)
    // 重同步期间到达的帧一律丢弃，避免半新半旧
    expect(follow.accept(notice(9))).toEqual({ kind: 'drop', reason: 'resyncing' })
  })

  it('缓冲上限溢出 → 重同步', () => {
    const follow = new SessionFollow({ bufferLimit: 2 })
    follow.accept(snapshot(0))
    expect(follow.accept(notice(1)).kind).toBe('apply')
    expect(follow.accept(notice(2)).kind).toBe('apply')
    expect(follow.accept(notice(3))).toEqual({ kind: 'resync', reason: 'overflow', since: 0 })
  })

  it('流式增量不推进游标', () => {
    const follow = new SessionFollow()
    follow.accept(snapshot(7))

    const decision = follow.accept({ kind: 'delta', at: 1, text: '好' })
    expect(decision.kind).toBe('apply')
    expect(follow.since()).toBe(7)
  })

  it('快照把游标重置到服务端 maxSeq，并解除重同步态', () => {
    const follow = new SessionFollow()
    follow.accept(snapshot(3))
    follow.accept(notice(9))
    expect(follow.isResyncing()).toBe(true)

    follow.accept(snapshot(9, [notice(9)]))
    expect(follow.isResyncing()).toBe(false)
    expect(follow.since()).toBe(9)
  })

  it('reset 清空游标（换会话）', () => {
    const follow = new SessionFollow()
    follow.accept(notice(3))
    follow.reset()
    expect(follow.since()).toBe(0)
  })
})
