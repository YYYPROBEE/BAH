/**
 * 会话服务单测（施工单 03 §1.3 / §3 第 9 步的会话侧）。
 */

import { describe, expect, it, vi } from 'vitest'

import { asSessionId, fixedClock, withTestContext } from '@bah/test-support'

import { SESSION_SERVICE, provideSession } from './service.ts'
import { SessionStore } from './store.ts'

describe('provideSession', () => {
  it('append 落账并广播 session/event；服务面读口齐备', async () => {
    await withTestContext(async (test) => {
      const sessionId = asSessionId('s-1')
      const clock = fixedClock({ start: 100 })
      const off = provideSession(test.ctx, { sessionId, now: clock.now })
      const session = test.ctx.get(SESSION_SERVICE)
      const recorded = test.record<{ session: unknown; event: { seq: number } }>('session/event', 'emit')

      const event = session.append('user/message', { content: '你好' })

      expect(event.seq).toBe(1)
      expect(event.at).toBe(100)
      expect(session.sessionId).toBe(sessionId)
      expect(session.formatVersion).toBe(event.formatVersion)
      expect(session.lastSeq()).toBe(1)
      expect(session.events()).toHaveLength(1)
      expect(recorded.values).toEqual([{ session: sessionId, event }])
      expect(session.deriveMessages()).toEqual([{ role: 'user', content: '你好' }])

      off()
      expect(() => test.ctx.get(SESSION_SERVICE)).toThrow(/未注册/)
    })
  })

  it('一个记账监听器抛错不阻断落账与后续观察者（D6）', async () => {
    await withTestContext(async (test) => {
      const sessionId = asSessionId('s-isolated')
      provideSession(test.ctx, { sessionId })
      const seen: number[] = []
      const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        test.ctx.events.on('session/event', () => {
          throw new Error('记账监听器炸了')
        })
        test.ctx.events.on('session/event', ({ event }) => {
          seen.push(event.seq)
        })

        const session = test.ctx.get(SESSION_SERVICE)
        expect(() => session.append('user/message', { content: '你好' })).not.toThrow()

        expect(session.lastSeq()).toBe(1)
        expect(session.events()).toHaveLength(1)
        expect(seen).toEqual([1])
        expect(reported).toHaveBeenCalled()
      } finally {
        reported.mockRestore()
      }
    })
  })

  /**
   * TC-W18-01：广播的重入顺序。
   *
   * 缺陷现场（W18 阻塞）：`safety:sentry` 的 `trace.sink='session'` 会在**自己的
   * `session/event` 回调里**再 `appendDomain` 一条 `sentry/trace`。旧实现直接同步重入
   * `emitIsolated`，排在这个写者**后面**的监听器就先收到 seq=N+1、后收到 seq=N；
   * 按 seq 单调消费的 `WebProjector` 于是把 N 丢掉——网页收不到 `tool` / `approval` 帧，
   * 审批弹窗永不出现。
   *
   * 判据：后注册者看到的顺序必须等于落账顺序。
   */
  it('TC-W18-01：监听器在回调里再 append 时，后注册者仍按落账顺序收到事件', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-reentrant') })
      const session = test.ctx.get(SESSION_SERVICE)
      const seen: { seq: number; type: string }[] = []

      // 先注册：边收边写（= sentry 的 trace.sink='session'）
      test.ctx.events.on('session/event', ({ event }) => {
        if (event.type === 'turn/start') {
          session.appendDomain('sentry/trace', { kind: 'turn-start' }, { ignorable: true })
        }
      })
      // 后注册：按 seq 单调消费（= channel:web 的 WebProjector）
      test.ctx.events.on('session/event', ({ event }) => {
        seen.push({ seq: event.seq, type: event.type })
      })

      session.append('turn/start', { turn: 1 })

      expect(seen).toEqual([
        { seq: 1, type: 'turn/start' },
        { seq: 2, type: 'sentry/trace' },
      ])
      // 嵌套那条也要真的落账，不能"为了排序把事件丢了"
      expect(session.lastSeq()).toBe(2)
      expect(session.events().map((event) => event.type)).toEqual(['turn/start', 'sentry/trace'])
    })
  })

  it('可复用已 restore 的存储（JSONL 回放的接缝）', async () => {
    await withTestContext(async (test) => {
      const store = new SessionStore({ now: fixedClock({ start: 7 }).now })
      store.restore([
        { seq: 1, at: 1, formatVersion: 1, type: 'user/message', data: { content: '来自回放' } },
      ])

      provideSession(test.ctx, { sessionId: asSessionId('s-replay'), store })
      const session = test.ctx.get(SESSION_SERVICE)

      expect(session.lastSeq()).toBe(1)
      expect(session.deriveMessages()).toEqual([{ role: 'user', content: '来自回放' }])
      // 继续追加时 seq 接着来，不会从 1 重开
      expect(session.append('turn/start', { turn: 1 }).seq).toBe(2)
    })
  })
})
