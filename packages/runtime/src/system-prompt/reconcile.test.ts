/**
 * 运行时上下文 reconcile 单测。
 */

import { asSessionId, withTestContext } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import { createDefaultPromptRegistry } from './index.ts'
import {
  RuntimeContextQueue,
  beginAttempt,
  buildModelHistory,
  reconcileContextEvents,
} from './reconcile.ts'
import type { ComposedPrompt, RuntimeContextView } from './types.ts'

/** 装配一个"只关心运行时上下文"的提示词（省掉无关段落）。 */
function composedOf(view: RuntimeContextView | undefined): ComposedPrompt {
  return createDefaultPromptRegistry().compose({
    capabilities: { toolCall: false, image: false, reasoning: false },
    tools: [],
    runtime: view,
  })
}

/** 在当前测试上下文里装好会话服务并跑一段用例。 */
async function withSession(run: (session: SessionApi) => void): Promise<void> {
  await withTestContext(async (test) => {
    provideSession(test.ctx, { sessionId: asSessionId('s-prompt') })
    run(test.ctx.get(SESSION_SERVICE))
  })
}

describe('runtime.context 落账与回收（T-LLM-008）', () => {
  it('T-LLM-008 运行时上下文以 user/message 落账，下次装配被回收', async () => {
    await withSession((session) => {
      const first = beginAttempt({
        session,
        turn: 1,
        step: 1,
        composed: composedOf({
          user: { name: '张三' },
          accounts: [
            { name: '储蓄卡', maskedNumber: '1234', balanceText: '¥1.00', availableText: '¥1.00' },
          ],
        }),
      })
      expect(first.contextTexts).toHaveLength(1)
      expect(first.systemText).toContain('不得编造账户、余额、交易')

      // 落账三件：system/message → request/context → user/message(runtime-context)
      expect(session.events().map((event) => event.type)).toEqual([
        'system/message',
        'request/context',
        'user/message',
      ])
      const contextEvent = session.events()[2]
      expect(contextEvent?.type === 'user/message' && contextEvent.data.source).toBe('runtime-context')
      expect(contextEvent?.type === 'user/message' && contextEvent.data.content).toContain('尾号 1234')

      // 第二次装配换了账户 → 旧上下文必须被回收
      beginAttempt({
        session,
        turn: 1,
        step: 2,
        composed: composedOf({
          user: { name: '张三' },
          accounts: [
            { name: '储蓄卡', maskedNumber: '9999', balanceText: '¥2.00', availableText: '¥2.00' },
          ],
        }),
      })

      const reconciled = reconcileContextEvents(session.events())
      // 旧 system（seq 1）+ 旧上下文（seq 3）被撤回
      expect(reconciled.withdrawnSeqs).toEqual([1, 3])
      expect(reconciled.kept.map((event) => event.seq)).toEqual([2, 4, 5, 6])

      // append-only：日志里两条上下文都还在，撤回只发生在投影层
      expect(
        session.events().filter((event) => event.type === 'user/message'),
      ).toHaveLength(2)

      const history = buildModelHistory(session.events())
      expect(history).toHaveLength(2)
      expect(history[0]).toEqual({
        role: 'system',
        content: expect.stringContaining('不得编造账户、余额、交易'),
      })
      expect(history[1]).toEqual({ role: 'user', content: expect.stringContaining('尾号 9999') })
      // 只有一份 system（旧装配结果不再进模型历史）
      expect(history.filter((message) => message.role === 'system')).toHaveLength(1)
    })
  })

  it('本次装配没有运行时上下文 → request/context 仍落账，旧上下文被撤回', async () => {
    await withSession((session) => {
      beginAttempt({ session, turn: 1, step: 1, composed: composedOf({ user: { name: '张三' } }) })
      beginAttempt({ session, turn: 1, step: 2, composed: composedOf(undefined) })

      const second = session.events().filter((event) => event.type === 'request/context')[1]
      expect(second?.type === 'request/context' && second.data.texts).toEqual([])

      const history = buildModelHistory(session.events())
      // 旧的运行时上下文已撤回，history 里只剩 system
      expect(history).toHaveLength(1)
      expect(history[0]?.role).toBe('system')
    })
  })

  it('工具后置阶段的纠正文本（source=context）不被误撤', async () => {
    await withSession((session) => {
      beginAttempt({ session, turn: 1, step: 1, composed: composedOf({ user: { name: '张三' } }) })
      // 工具后置阶段追加的纠正文本（真实时序：在 system/message 之后）
      session.append('user/message', { content: '请确认收款人', source: 'context' })
      beginAttempt({ session, turn: 1, step: 2, composed: composedOf({ user: { name: '张三' } }) })

      const history = buildModelHistory(session.events())
      expect(history.map((message) => message.role)).toEqual(['system', 'user', 'user'])
      expect(history[1]).toEqual({ role: 'user', content: '请确认收款人' })
    })
  })
})

describe('agent.inject 走同一路径（T-LLM-009）', () => {
  it('T-LLM-009 注入文本作为运行时上下文落账，模型可见', async () => {
    await withSession((session) => {
      const queue = new RuntimeContextQueue()
      queue.inject('用户上周刚完成金卡升级，年费已减免')
      expect(queue.size).toBe(1)

      const result = beginAttempt({
        session,
        turn: 1,
        step: 1,
        composed: composedOf({ user: { name: '李四' } }),
        queue,
      })

      // 渲染结果在前、注入文本在后（FIFO）
      expect(result.contextTexts[0]).toContain('姓名：李四')
      expect(result.contextTexts[1]).toBe('用户上周刚完成金卡升级，年费已减免')
      // 队列取走即清空
      expect(queue.size).toBe(0)

      const recorded = session
        .events()
        .filter((event) => event.type === 'user/message')
        .map((event) => (event.type === 'user/message' ? event.data.content : ''))
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toContain('金卡升级')

      const history = buildModelHistory(session.events())
      expect(history[1]).toEqual({ role: 'user', content: expect.stringContaining('金卡升级') })
    })
  })

  it('空文本不进队列（不制造空事件）；drain 清空且可重复使用', () => {
    const queue = new RuntimeContextQueue()
    queue.inject('   ')
    expect(queue.size).toBe(0)

    queue.inject('a')
    queue.inject('b')
    expect(queue.drain()).toEqual(['a', 'b'])
    expect(queue.drain()).toEqual([])
    expect(queue.size).toBe(0)
  })

  it('没有 request/context 时不做任何撤回（孤立 user 消息保持可见）', async () => {
    await withSession((session) => {
      session.append('user/message', { content: '你好', source: 'runtime-context' })
      const reconciled = reconcileContextEvents(session.events())
      expect(reconciled.withdrawnSeqs).toEqual([])
    })
  })
})
