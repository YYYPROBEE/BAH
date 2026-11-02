/**
 * 压缩落账单测（摘要作为会话事件落账，可回放；T-CMP-002 / 004）。
 */

import { asSessionId, withTestContext } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { deriveMessages } from '../session/derive.ts'
import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import { SessionStore } from '../session/store.ts'
import { buildModelHistory } from '../system-prompt/reconcile.ts'
import { appendCompactionSummary, runCompaction } from './apply.ts'
import { analyzeSession, planCompaction, resolveCompactionConfig } from './summarize.ts'

/** 在当前测试上下文里装好会话服务并跑一段用例。 */
async function withSession(run: (session: SessionApi) => void): Promise<void> {
  await withTestContext(async (test) => {
    provideSession(test.ctx, { sessionId: asSessionId('s-compaction-apply') })
    run(test.ctx.get(SESSION_SERVICE))
  })
}

/** 造 n 个完整 turn（每轮一问一答）。 */
function seed(session: SessionApi, turns: number): void {
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('system/message', { content: `系统头 v${turn}` })
    session.append('user/message', { content: `第 ${turn} 轮问题` })
    session.append('assistant/message', { content: [{ type: 'text', text: `第 ${turn} 轮回答` }] })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

describe('runCompaction / appendCompactionSummary', () => {
  it('T-CMP-002 摘要落账为 compaction/summary 会话事件（含事件引用）', async () => {
    await withSession((session) => {
      seed(session, 3)
      const thresholds = resolveCompactionConfig({ maxTurns: 1, keepRecentTurns: 1 })

      const run = runCompaction(session, thresholds)

      expect(run.plan.needed).toBe(true)
      expect(run.event).toBeDefined()
      const last = session.events().at(-1)
      expect(last?.type).toBe('compaction/summary')
      if (last?.type === 'compaction/summary') {
        // 摘要自带可回跳的事件引用
        expect(last.data.refs.length).toBe(run.plan.droppedSeqs.length)
        expect(last.data.refs).toEqual([...run.plan.droppedSeqs])
        expect(last.data.droppedMessages).toBeGreaterThan(0)
      }
    })
  })

  it('未触发时无事可做：不落空摘要事件', async () => {
    await withSession((session) => {
      seed(session, 2)
      const thresholds = resolveCompactionConfig({ maxTokens: 1_000_000, keepRecentTurns: 1 })

      const plan = planCompaction({ events: session.events(), thresholds })
      expect(appendCompactionSummary(session, plan)).toBeUndefined()

      const run = runCompaction(session, thresholds)
      expect(run.event).toBeUndefined()
      expect(session.events().some((event) => event.type === 'compaction/summary')).toBe(false)
    })
  })

  it('overheadTokens 透传到水位判定（工具 schema 不在事件里）', async () => {
    await withSession((session) => {
      seed(session, 2)
      const base = planCompaction({
        events: session.events(),
        thresholds: resolveCompactionConfig({ maxTokens: 1, keepRecentTurns: 1 }),
      })
      expect(base.needed).toBe(true)
      // 把阈值抬到"事件估算 + 100"后，只有补上工具 schema 开销才会触发
      const events = session.events()
      const tokens = analyzeSession(events).tokens
      const thresholds = resolveCompactionConfig({ maxTokens: tokens + 100, keepRecentTurns: 1 })

      expect(planCompaction({ events, thresholds }).needed).toBe(false)
      expect(runCompaction(session, thresholds, 100).plan.needed).toBe(true)
    })
  })

  it('幂等：已折叠的 turn 不会被重复摘要（第二次调用 needed=false）', async () => {
    await withSession((session) => {
      seed(session, 3)
      const thresholds = resolveCompactionConfig({ maxTurns: 1, keepRecentTurns: 1 })
      runCompaction(session, thresholds)

      const second = runCompaction(session, thresholds)
      expect(second.plan.needed).toBe(false)
      expect(session.events().filter((event) => event.type === 'compaction/summary')).toHaveLength(1)
    })
  })
})

describe('T-CMP-004 回放重建', () => {
  it('T-CMP-004 压缩后仍可从日志重建模型历史（含 JSON 往返）', async () => {
    await withSession((session) => {
      seed(session, 4)
      const thresholds = resolveCompactionConfig({ maxTurns: 2, keepRecentTurns: 1 })
      runCompaction(session, thresholds)

      // 压缩不改写历史：原始事件一条不少
      expect(session.events().filter((event) => event.type === 'turn/start')).toHaveLength(4)

      // 回放：日志序列化 → 恢复 → 投影（快照回放走的就是这条路径）
      const restored = new SessionStore()
      restored.restore(JSON.parse(JSON.stringify(session.events())))

      const history = buildModelHistory(restored.events())
      expect(history[0]?.role).toBe('system')
      expect(history[1]?.role).toBe('user')
      expect(history[1]?.content).toContain('[已压缩历史]')
      // 最近一轮原文仍在（压缩保留 keepRecentTurns 个 turn 的原文）
      expect(history.some((message) => message.content === '第 4 轮问题')).toBe(true)
      // 但被折叠的轮次不再出现
      expect(history.some((message) => message.content === '第 1 轮问题')).toBe(false)

      // 会话日志本身的投影（不折叠）仍然合法——压缩没有在日志里制造空洞
      expect(() => deriveMessages(restored.events())).not.toThrow()
    })
  })
})
