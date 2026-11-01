/**
 * 会话存储单测。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown, fixedClock } from '@bah/test-support'

import { SessionStore } from './store.ts'
import { SESSION_FORMAT_VERSION } from './types.ts'

describe('SessionStore', () => {
  it('T-SESS-001 连续 append 100 条 → seq 1..100 连续单调', () => {
    const store = new SessionStore({ now: fixedClock({ start: 1_000 }).now })

    for (let index = 1; index <= 100; index += 1) {
      const event = store.append('user/message', { content: `第 ${index} 条` })
      expect(event.seq).toBe(index)
      expect(event.type).toBe('user/message')
    }

    const events = store.events()
    expect(events).toHaveLength(100)
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    )
    expect(store.lastSeq()).toBe(100)
  })

  it('envelope 六字段齐备：seq / at / formatVersion / ignorable / type / data', () => {
    const clock = fixedClock({ start: 42 })
    const store = new SessionStore({ now: clock.now })

    const required = store.append('turn/start', { turn: 1 })
    expect(required).toEqual({
      seq: 1,
      at: 42,
      formatVersion: SESSION_FORMAT_VERSION,
      type: 'turn/start',
      data: { turn: 1 },
    })

    const optional = store.append('step/start', { turn: 1, step: 1 }, { ignorable: true })
    expect(optional.ignorable).toBe(true)
  })

  it('events() 返回快照：外部改动不会影响日志', () => {
    const store = new SessionStore()
    store.append('turn/start', { turn: 1 })

    const snapshot = store.events()
    ;(snapshot as unknown as unknown[]).length = 0

    expect(store.events()).toHaveLength(1)
  })

  it('restore 只接受连续 seq：空洞即抛（append-only 不允许断代）', () => {
    const store = new SessionStore()
    store.restore([
      { seq: 1, at: 1, formatVersion: SESSION_FORMAT_VERSION, type: 'turn/start', data: { turn: 1 } },
    ])
    expect(store.lastSeq()).toBe(1)

    const error = captureThrown(() =>
      store.restore([
        { seq: 3, at: 2, formatVersion: SESSION_FORMAT_VERSION, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]),
    )
    expect(error.code).toBe('session-seq-gap')
    expect(error.message).toContain('期望 2')
  })
})
