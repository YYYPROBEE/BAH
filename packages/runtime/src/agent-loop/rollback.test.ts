/**
 * T-LOOP-012 回退分叉（施工单 04 §3「回退」）。
 *
 * 验收点：新会话 `parentSession` / `seedLength` 正确；种子是到 turn 边界为止的**连续前缀**；
 * 原会话一个字节不动（append-only 是回退的锚点，不是"可以改的原稿"）。
 */

import {
  asSessionId,
  captureThrown,
  createTestContext,
  fixedClock,
  withTestContext,
} from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { SESSION_SERVICE, provideSession } from '../session/service.ts'
import { deriveMessages } from '../session/derive.ts'

import { forkSession, seedUpTo } from './rollback.ts'

describe('T-LOOP-012 回退分叉', () => {
  it('T-LOOP-012 新会话 parentSession/seedLength 正确，原会话只读', async () => {
    await withTestContext(async (test) => {
      const clock = fixedClock({ start: 1_000 })
      provideSession(test.ctx, { sessionId: asSessionId('s-source'), now: clock.now })
      const source = test.ctx.get(SESSION_SERVICE)

      // 两轮对话：第 1 轮问、第 2 轮问
      source.append('turn/start', { turn: 1 })
      source.append('user/message', { content: '第一轮的问题' })
      source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      source.append('turn/start', { turn: 2 })
      source.append('user/message', { content: '第二轮的问题' })
      source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

      const original = source.events().map((event) => ({ ...event }))
      const originalLastSeq = source.lastSeq()

      const child = createTestContext()
      try {
        const forked = forkSession(source, {
          sessionId: asSessionId('s-fork'),
          turn: 1,
          ctx: child.ctx,
          now: clock.now,
        })

        // 种子 = 到 turn 1 的 turn/end 为止的连续前缀
        expect(forked.parentSession).toBe(source.sessionId)
        expect(forked.turn).toBe(1)
        expect(forked.seedLength).toBe(3)
        expect(forked.seed.map((event) => event.type)).toEqual([
          'turn/start',
          'user/message',
          'turn/end',
        ])

        const restored = forked.session.events()
        expect(restored.map((event) => event.seq)).toEqual([1, 2, 3])
        expect(restored.map((event) => event.type)).toEqual(forked.seed.map((event) => event.type))
        expect(forked.session.sessionId).toBe(asSessionId('s-fork'))

        // 新会话可以继续写（seq 从种子长度往后接），原会话不受影响
        forked.session.append('turn/start', { turn: 2 })
        expect(forked.session.lastSeq()).toBe(4)
        expect(source.lastSeq()).toBe(originalLastSeq)
        expect(source.events()).toEqual(original)

        // 分叉出来的会话仍可被 deriveMessages 重建（投影不依赖存储实现）
        expect(deriveMessages(forked.session.events()).map((message) => message.role)).toEqual([
          'user',
        ])
      } finally {
        await child.dispose('fork-test-finished')
      }
    })
  })

  it('T-LOOP-012 边界 turn 未完成 → fail-loud（不能把半截 turn 当分叉点）', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-open-turn'), now: fixedClock().now })
      const source = test.ctx.get(SESSION_SERVICE)
      source.append('turn/start', { turn: 1 })
      source.append('user/message', { content: '还在进行中' })

      expect(captureThrown(() => seedUpTo(source.events(), 1)).code).toBe('fork-turn-missing')

      const child = createTestContext()
      try {
        expect(
          captureThrown(() =>
            forkSession(source, {
              sessionId: asSessionId('s-fork-2'),
              turn: 1,
              ctx: child.ctx,
            }),
          ).code,
        ).toBe('fork-turn-missing')
      } finally {
        await child.dispose('fork-test-finished')
      }
      // 失败的分叉不留注册痕迹：新会话服务没有建起来
      expect(captureThrown(() => child.ctx.get(SESSION_SERVICE)).code).toBe('service-missing')
    })
  })
})
