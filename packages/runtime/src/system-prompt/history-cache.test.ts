/**
 * 增量历史投影 vs 全量 oracle（报告 P-P2）。
 *
 * 每个事件后同时跑 `modelHistoryOf` 与 `buildModelHistory`，要求值/错误码完全一致。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, createTestContext } from '@bah/test-support'

import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import type { AnySessionEvent } from '../session/types.ts'
import { buildModelHistory } from './reconcile.ts'
import { modelHistoryOf } from './history-cache.ts'

function compare(session: SessionApi): void {
  let incremental: ReturnType<typeof modelHistoryOf> | undefined
  let incrementalCode: string | undefined
  let full: ReturnType<typeof buildModelHistory> | undefined
  let fullCode: string | undefined
  try {
    incremental = modelHistoryOf(session)
  } catch (error) {
    incrementalCode = (error as { code?: string }).code
  }
  try {
    full = buildModelHistory(session.events())
  } catch (error) {
    fullCode = (error as { code?: string }).code
  }
  expect(incrementalCode).toBe(fullCode)
  if (fullCode === undefined) expect(incremental).toEqual(full)
}

describe('modelHistoryOf 增量投影', () => {
  it('逐事件与 buildModelHistory 全等（含 system 替换 / 上下文撤回 / tool 顺序）', async () => {
    const test = createTestContext()
    try {
      const sessionId = asSessionId('s-history')
      provideSession(test.ctx, { sessionId, now: () => 1_000 })
      const session = test.ctx.get(SESSION_SERVICE)
      session.append('turn/start', { turn: 1 })
      compare(session)

      session.append('system/message', { content: 'sys-1' })
      compare(session)
      session.append('request/context', { turn: 1, step: 1, texts: [] })
      compare(session)
      session.append('user/message', { content: 'hello', source: 'user' })
      session.append('user/message', { content: 'ctx-1', source: 'runtime-context' })
      compare(session)

      session.append('tool/call', {
        callId: 'c1',
        name: 'probe',
        args: {},
        fingerprint: 'probe:{}',
        tier: { level: 'green' },
        at: 1,
      })
      compare(session)
      session.append('tool/result', {
        callId: 'c1',
        name: 'probe',
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
        durationMs: 1,
      })
      compare(session)
      session.append('assistant/message', {
        content: [{ type: 'text', text: 'done' }],
        toolCalls: [{ callId: 'c1', name: 'probe', args: {} }],
      })
      compare(session)
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      compare(session)

      // 第二轮：新 system + 新 request/context → 旧 system 与 ctx-1 必须被撤回
      session.append('turn/start', { turn: 2 })
      session.append('system/message', { content: 'sys-2' })
      compare(session)
      session.append('request/context', { turn: 2, step: 1, texts: [] })
      compare(session)
      session.append('user/message', { content: 'ctx-2', source: 'runtime-context' })
      session.append('user/message', { content: '纠正', source: 'context' })
      compare(session)

      session.append('tool/call', {
        callId: 'c2',
        name: 'probe',
        args: {},
        fingerprint: 'probe:{}',
        tier: { level: 'green' },
        at: 2,
      })
      session.append('tool/result', {
        callId: 'c2',
        name: 'probe',
        isError: true,
        code: 'boom',
        content: [{ type: 'text', text: 'failed' }],
        durationMs: 1,
      })
      session.append('assistant/message', {
        content: [],
        toolCalls: [{ callId: 'c2', name: 'probe', args: {} }],
      })
      compare(session)

      const first = modelHistoryOf(session)
      const second = modelHistoryOf(session)
      expect(second).toEqual(first)
    } finally {
      await test.dispose()
    }
  })

  it('含 compaction/summary 时回退全量（结果仍与 oracle 全等）', async () => {    const test = createTestContext()
    try {
      const sessionId = asSessionId('s-history-compact')
      provideSession(test.ctx, { sessionId, now: () => 1_000 })
      const session = test.ctx.get(SESSION_SERVICE)
      session.append('turn/start', { turn: 1 })
      session.append('system/message', { content: 'sys' })
      session.append('user/message', { content: 'hello', source: 'user' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      compare(session)
      // 先建立缓存，再追加压缩摘要：走"新事件里出现 compaction"的回退分支
      expect(modelHistoryOf(session)).toEqual(buildModelHistory(session.events()))
      session.append('compaction/summary', {
        fromTurn: 1,
        toTurn: 1,
        turns: 1,
        summary: '摘要',
        refs: [1, 2, 3, 4],
        financial: [],
        droppedMessages: 1,
      })
      compare(session)
      // oracle 里被折叠的 turn 不应出现在增量结果
      expect(modelHistoryOf(session)).toEqual(buildModelHistory(session.events()))
    } finally {
      await test.dispose()
    }
  })
})

describe('modelHistoryOf 边界', () => {
  it('assistant 先于 result：emitted 分支与 pending 跳过都与 oracle 同错', async () => {
    const test = createTestContext()
    try {
      provideSession(test.ctx, { sessionId: asSessionId('s-history-order'), now: () => 1 })
      const session = test.ctx.get(SESSION_SERVICE)

      session.append('tool/call', {
        callId: 'c1',
        name: 'probe',
        args: {},
        fingerprint: 'f',
        tier: { level: 'green' },
        at: 1,
      })
      session.append('assistant/message', {
        content: [],
        toolCalls: [{ callId: 'c1', name: 'probe', args: {} }],
      })
      compare(session)
      // assistant 已发出 → result 到达时走 emitted 分支
      session.append('tool/result', {
        callId: 'c1',
        name: 'probe',
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
        durationMs: 1,
      })
      compare(session)

      // c2 的结果先到、assistant 不承载 c2 → flushPending 跳过，最终与 oracle 同报空洞
      session.append('tool/call', {
        callId: 'c2',
        name: 'probe',
        args: {},
        fingerprint: 'f',
        tier: { level: 'green' },
        at: 2,
      })
      session.append('tool/result', {
        callId: 'c2',
        name: 'probe',
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
        durationMs: 1,
      })
      session.append('assistant/message', {
        content: [],
        toolCalls: [{ callId: 'c3', name: 'probe', args: {} }],
      })
      compare(session)
    } finally {
      await test.dispose()
    }
  })

  it('未知且非 ignorable 的事件 → session-unknown-event', () => {
    const events = [
      { seq: 1, at: 0, formatVersion: 1, type: 'future/event', data: {} },
    ] as unknown as AnySessionEvent[]
    let code: string | undefined
    try {
      modelHistoryOf({ eventsView: () => events, lastSeq: () => 1 })
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('session-unknown-event')
  })
})
