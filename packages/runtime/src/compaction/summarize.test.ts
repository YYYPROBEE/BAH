/**
 * 上下文压缩单测（施工单 05 §5；T-CMP-001 / 003）。
 */

import { asSessionId, withTestContext } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import type { TicketId } from '@bah/core'

import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import { buildModelHistory } from '../system-prompt/reconcile.ts'
import {
  collapseEvents,
  countCompleteTurns,
  estimateEventTokens,
  estimateTokens,
  extractFinancial,
  planCompaction,
  renderSummaryText,
  resolveCompactionConfig,
  shouldCompact,
  turnOwnership,
} from './summarize.ts'

/** 在当前测试上下文里装好会话服务并跑一段用例。 */
async function withSession(run: (session: SessionApi) => void): Promise<void> {
  await withTestContext(async (test) => {
    provideSession(test.ctx, { sessionId: asSessionId('s-compaction') })
    run(test.ctx.get(SESSION_SERVICE))
  })
}

/** 造一个"用户问 → 模型答"的完整 turn。 */
function appendTurn(session: SessionApi, turn: number, answer = `第 ${turn} 轮回答`): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('system/message', { content: `系统头 v${turn}` })
  session.append('user/message', { content: `第 ${turn} 轮问题` })
  session.append('assistant/message', { content: [{ type: 'text', text: answer }] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** 造一个"转账 + 审批"的 turn（金融特例数据源）。 */
function appendTransferTurn(session: SessionApi, turn: number): void {
  const ticketId = `ticket:c${turn}` as TicketId
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('system/message', { content: `系统头 v${turn}` })
  session.append('user/message', { content: `给张三转 100 元（第 ${turn} 轮）` })
  session.append('assistant/message', {
    content: [{ type: 'text', text: '' }],
    toolCalls: [{ callId: `c${turn}`, name: 'transfer_money', args: { amount: 100, payee: '张三' } }],
  })
  session.append('tool/call', {
    callId: `c${turn}`,
    name: 'transfer_money',
    args: { amount: 100, payee: '张三' },
    fingerprint: `transfer_money:${turn}`,
    tier: { level: 'yellow', amountPath: 'amount' },
    at: turn * 1_000,
  })
  session.append('approval/asked', {
    ticketId,
    callId: `c${turn}`,
    name: 'transfer_money',
    amount: 100,
  })
  session.append('approval/decided', { ticketId, decision: 'allowed-once' })
  session.append('tool/result', {
    callId: `c${turn}`,
    name: 'transfer_money',
    isError: false,
    content: [{ type: 'text', text: '转账成功' }],
  })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** 三轮普通对话（token / turn 阈值用例的基座）。 */
function seedTurns(session: SessionApi): void {
  for (const turn of [1, 2, 3]) appendTurn(session, turn)
}

describe('resolveCompactionConfig（阈值配置化，无硬编码）', () => {
  it('合法配置原样收下（两种阈值可单配可同配）', () => {
    expect(resolveCompactionConfig({ maxTokens: 8000, keepRecentTurns: 2 })).toEqual({
      maxTokens: 8000,
      keepRecentTurns: 2,
    })
    expect(resolveCompactionConfig({ maxTurns: 8, keepRecentTurns: 3 })).toEqual({
      maxTurns: 8,
      keepRecentTurns: 3,
    })
    expect(resolveCompactionConfig({ maxTokens: 100, maxTurns: 2, keepRecentTurns: 1 })).toEqual({
      maxTokens: 100,
      maxTurns: 2,
      keepRecentTurns: 1,
    })
  })

  it('非对象 / 未知键 / 阈值非法 / 一个阈值都没配 → 载入即抛', () => {
    expect(() => resolveCompactionConfig(null)).toThrowError(/配置必须是对象/)
    expect(() => resolveCompactionConfig({ maxTokens: 100, keepRecentTurns: 1, extra: 1 })).toThrowError(
      /未知配置键 extra/,
    )
    expect(() => resolveCompactionConfig({ maxTokens: 100 })).toThrowError(
      /keepRecentTurns 必须是正整数/,
    )
    expect(() => resolveCompactionConfig({ maxTokens: 100, keepRecentTurns: 0 })).toThrowError(
      /keepRecentTurns 必须是正整数/,
    )
    expect(() => resolveCompactionConfig({ maxTokens: 0, keepRecentTurns: 1 })).toThrowError(
      /maxTokens 必须是正整数/,
    )
    expect(() => resolveCompactionConfig({ maxTurns: 1.5, keepRecentTurns: 1 })).toThrowError(
      /maxTurns 必须是正整数/,
    )
    expect(() => resolveCompactionConfig({ keepRecentTurns: 2 })).toThrowError(/至少要配置/)
  })
})

describe('度量（阈值判定用）', () => {
  it('token 估算按 4 字符/token 向上取整；图片块不计', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(
      estimateEventTokens({
        seq: 1,
        at: 0,
        formatVersion: 1,
        type: 'tool/result',
        data: {
          callId: 'c',
          name: 'n',
          isError: false,
          content: [
            { type: 'text', text: 'abcd' },
            { type: 'image', mimeType: 'image/png', data: 'x' },
          ],
        },
      }),
    ).toBe(1)
    // 审计类事件不计 token
    expect(
      estimateEventTokens({ seq: 1, at: 0, formatVersion: 1, type: 'turn/start', data: { turn: 1 } }),
    ).toBe(0)
  })

  it('shouldCompact：完整 turn 数不够时不压缩；token 未达水位且 turn 未超阈值时不压缩', async () => {
    await withSession((session) => {
      appendTurn(session, 1)
      appendTurn(session, 2)

      // 只剩 2 个完整 turn，keepRecentTurns=2 → 折叠完就没原文了，不压
      expect(shouldCompact(session.events(), { maxTokens: 1, keepRecentTurns: 2 })).toBe(false)
      // 阈值都够不着
      expect(shouldCompact(session.events(), { maxTokens: 100_000, maxTurns: 10, keepRecentTurns: 1 })).toBe(
        false,
      )
      // token 水位触发
      expect(shouldCompact(session.events(), { maxTokens: 10, keepRecentTurns: 1 })).toBe(true)
      // turn 数触发
      expect(shouldCompact(session.events(), { maxTurns: 1, keepRecentTurns: 1 })).toBe(true)
      expect(countCompleteTurns(session.events())).toBe(2)
    })
  })
})

describe('planCompaction（施工单 05 §5 折叠计划）', () => {
  it('T-CMP-001 token 阈值触发：更早的 turn 折叠为摘要，最近 N 轮保留原文', async () => {
    await withSession((session) => {
      seedTurns(session)
      const thresholds = resolveCompactionConfig({ maxTokens: 10, keepRecentTurns: 1 })

      const plan = planCompaction({ events: session.events(), thresholds })

      expect(plan.needed).toBe(true)
      expect(plan.collapsedTurns).toEqual([1, 2])
      expect(plan.data?.fromTurn).toBe(1)
      expect(plan.data?.toTurn).toBe(2)
      expect(plan.data?.turns).toBe(2)
      expect(plan.data?.summary).toContain('[已压缩历史] 第 1–2 轮')
      expect(plan.droppedSeqs.length).toBeGreaterThan(0)
      // 折叠的是第 1、2 轮的事件（第 3 轮原样保留）
      const owner = turnOwnership(session.events())
      expect(plan.droppedSeqs.every((seq) => owner.get(seq) !== undefined && owner.get(seq)! <= 2)).toBe(true)
    })
  })

  it('未越过阈值 → needed=false，且不产生摘要载荷', async () => {
    await withSession((session) => {
      seedTurns(session)
      const plan = planCompaction({
        events: session.events(),
        thresholds: resolveCompactionConfig({ maxTokens: 1_000_000, keepRecentTurns: 1 }),
      })
      expect(plan.needed).toBe(false)
      expect(plan.data).toBeUndefined()
      expect(plan.droppedSeqs).toEqual([])
    })
  })

  it('system/message 永不折叠（否则压缩后模型失去身份与安全底线）', async () => {
    await withSession((session) => {
      seedTurns(session)
      const plan = planCompaction({
        events: session.events(),
        thresholds: resolveCompactionConfig({ maxTurns: 1, keepRecentTurns: 1 }),
      })
      const systemSeqs = session
        .events()
        .filter((event) => event.type === 'system/message')
        .map((event) => event.seq)
      expect(plan.droppedSeqs.filter((seq) => systemSeqs.includes(seq))).toEqual([])
    })
  })
})

describe('金融特例（T-CMP-003）', () => {
  it('T-CMP-003 金额 / 收款人 / 票据 / 结论在压缩后保留结构化字段', async () => {
    await withSession((session) => {
      appendTransferTurn(session, 1)
      appendTurn(session, 2)
      appendTurn(session, 3)

      const plan = planCompaction({
        events: session.events(),
        thresholds: resolveCompactionConfig({ maxTurns: 1, keepRecentTurns: 1 }),
      })

      expect(plan.needed).toBe(true)
      expect(plan.data?.financial).toEqual([
        { amount: 100, payee: '张三', ticketId: 'ticket:c1', decision: 'allowed-once' },
      ])
      // 结构化字段同时进摘要文本（审计与模型可见两条链都不丢）
      expect(plan.data?.summary).toContain('¥100.00 → 张三（allowed-once，票据 ticket:c1）')
    })
  })

  it('绿色直通调用没有票据：不伪造票号，decision=not-required', async () => {
    await withSession((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', {
        callId: 'c1',
        name: 'query_balance',
        args: { amount: 30, payee: '王五' },
        fingerprint: 'f',
        tier: { level: 'green' },
        at: 0,
      })
      session.append('tool/result', {
        callId: 'c1',
        name: 'query_balance',
        isError: false,
        content: [{ type: 'text', text: '100' }],
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      expect(extractFinancial(session.events())).toEqual([
        { amount: 30, payee: '王五', decision: 'not-required' },
      ])
    })
  })

  it('审批未结论 → decision=pending；与钱无关的调用不进金融条目', async () => {
    await withSession((session) => {
      const ticketId = 'ticket:c1' as TicketId
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', {
        callId: 'c1',
        name: 'transfer_money',
        args: { amount: 50, payee: '李四' },
        fingerprint: 'f',
        tier: { level: 'yellow' },
        at: 0,
      })
      session.append('approval/asked', { ticketId, callId: 'c1', name: 'transfer_money', amount: 50 })
      session.append('tool/result', {
        callId: 'c1',
        name: 'transfer_money',
        isError: true,
        content: [{ type: 'text', text: '审批未通过' }],
        code: 'approval-rejected',
      })
      session.append('tool/call', {
        callId: 'c2',
        name: 'query_rate',
        args: {},
        fingerprint: 'g',
        tier: { level: 'green' },
        at: 0,
      })
      session.append('tool/result', {
        callId: 'c2',
        name: 'query_rate',
        isError: false,
        content: [{ type: 'text', text: '3.1%' }],
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const entries = extractFinancial(session.events())
      expect(entries).toHaveLength(1)
      expect(entries[0]?.decision).toBe('pending')
      expect(entries[0]?.ticketId).toBe(ticketId)
    })
  })

  it('摘要文本：无工具调用 / 无资金条目时不留空标题', () => {
    const text = renderSummaryText({
      fromTurn: 1,
      toTurn: 2,
      turns: 2,
      droppedMessages: 4,
      toolCalls: [],
      financial: [],
    })
    expect(text).toContain('[已压缩历史] 第 1–2 轮（共 2 轮、4 条消息）')
    expect(text).not.toContain('工具调用：')
    expect(text).not.toContain('资金动作')
  })
})

describe('collapseEvents（折叠投影）', () => {
  it('已被摘要覆盖的 turn 从投影里剔除；摘要事件本身不进投影；turn 外事件保留', async () => {
    await withSession((session) => {
      // turn 之外的孤立消息（例如装配前的说明）
      session.append('user/message', { content: '会话开始' })
      appendTurn(session, 1)
      appendTurn(session, 2)
      session.append('compaction/summary', {
        fromTurn: 1,
        toTurn: 1,
        turns: 1,
        summary: '[已压缩历史] 第 1–1 轮',
        refs: [1],
        financial: [],
        droppedMessages: 3,
      })

      const collapsed = collapseEvents(session.events())
      expect(collapsed.summaries).toHaveLength(1)
      expect(collapsed.collapsedTurns).toEqual([1])

      const owner = turnOwnership(session.events())
      // 第 1 轮里**除系统头以外**的事件全部折叠掉
      const turn1 = session
        .events()
        .filter((event) => owner.get(event.seq) === 1 && event.type !== 'system/message')
        .map((event) => event.seq)
      expect(turn1.length).toBeGreaterThan(0)
      expect(collapsed.kept.some((event) => turn1.includes(event.seq))).toBe(false)
      // 系统头永不折叠（否则压缩后模型失去身份与安全底线）
      expect(
        collapsed.kept.some((event) => owner.get(event.seq) === 1 && event.type === 'system/message'),
      ).toBe(true)
      expect(collapsed.kept.some((event) => owner.get(event.seq) === 2)).toBe(true)
      // 摘要事件本身不进投影（由 summaries 承载），turn 外的孤立事件保留
      expect(collapsed.kept.some((event) => event.type === 'compaction/summary')).toBe(false)
      expect(collapsed.kept.some((event) => event.type === 'user/message' && event.seq === 1)).toBe(true)
    })
  })

  it('多段摘要的覆盖范围合并（升序输出）', async () => {
    await withSession((session) => {
      appendTurn(session, 1)
      session.append('compaction/summary', {
        fromTurn: 3,
        toTurn: 3,
        turns: 1,
        summary: 'x',
        refs: [],
        financial: [],
        droppedMessages: 0,
      })
      session.append('compaction/summary', {
        fromTurn: 1,
        toTurn: 1,
        turns: 1,
        summary: 'y',
        refs: [],
        financial: [],
        droppedMessages: 0,
      })

      expect(collapseEvents(session.events()).collapsedTurns).toEqual([1, 3])
    })
  })
})

describe('折叠后的模型历史（T-CMP-004 的前半）', () => {
  it('摘要消息插在 system 之后、其余历史之前', async () => {
    await withSession((session) => {
      seedTurns(session)
      session.append('compaction/summary', {
        fromTurn: 1,
        toTurn: 1,
        turns: 1,
        summary: '[已压缩历史] 第 1–1 轮已折叠',
        refs: [2],
        financial: [],
        droppedMessages: 3,
      })

      const history = buildModelHistory(session.events())
      expect(history[0]).toEqual({ role: 'system', content: expect.stringContaining('系统头 v3') })
      expect(history[1]).toEqual({ role: 'user', content: '[已压缩历史] 第 1–1 轮已折叠' })
      // 第 1 轮原文不再出现在历史里
      expect(history.some((message) => message.content === '第 1 轮问题')).toBe(false)
      expect(history.some((message) => message.content === '第 2 轮问题')).toBe(true)
    })
  })
})
