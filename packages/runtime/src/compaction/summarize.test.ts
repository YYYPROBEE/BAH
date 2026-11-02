/**
 * 上下文压缩单测。
 */

import { asSessionId, captureThrown, withTestContext } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import type { TicketId } from '@bah/core'

import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import type { AnySessionEvent } from '../session/types.ts'
import { buildModelHistory } from '../system-prompt/reconcile.ts'
import {
  analyzeSession,
  collapseEvents,
  countCompleteTurns,
  estimateEventTokens,
  estimateRequestTokens,
  estimateTokens,
  extractFinancial,
  extractHighlights,
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
  it('token 估算按分类计数：CJK 1 token/字，ASCII 4 字符/token；图片块不计', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('你好ab')).toBe(3)
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
    // 未知事件必须表态：静默按 0 会让压缩水位系统性低估
    expect(
      captureThrown(() =>
        estimateEventTokens({
          seq: 9,
          at: 0,
          formatVersion: 1,
          type: 'future/event',
          data: {},
        } as unknown as AnySessionEvent),
      ).code,
    ).toBe('compaction-unestimated-event')
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

      // 单遍度量必须与旧口径逐项一致（oracle）；token 口径只计**最后一条** system 头
      const events = session.events()
      const lastSystemSeq = events.filter((event) => event.type === 'system/message').at(-1)?.seq
      const expectedTokens = events.reduce(
        (sum, event) =>
          sum +
          (event.type === 'system/message' && event.seq !== lastSystemSeq
            ? 0
            : estimateEventTokens(event)),
        0,
      )
      const metrics = analyzeSession(events)
      expect(metrics.turns).toHaveLength(countCompleteTurns(events))
      expect(metrics.tokens).toBe(expectedTokens)
      expect([...metrics.owner.entries()]).toEqual([...turnOwnership(session.events()).entries()])
    })
  })
})

describe('planCompaction', () => {
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
        {
          amount: 100,
          payee: '张三',
          ticketId: 'ticket:c1',
          decision: 'allowed-once',
          tier: 'yellow',
          execution: 'succeeded',
        },
      ])
      // 审批结论与执行结果分开写：批准 ≠ 已执行
      expect(plan.data?.summary).toContain(
        '¥100.00 → 张三（审批 allowed-once，票据 ticket:c1；执行成功）',
      )
      // 对话实质也在摘要里（用户原话 + 工具参数/结果）
      expect(plan.data?.summary).toContain('用户：「给张三转 100 元（第 1 轮）」')
      expect(plan.data?.summary).toContain('工具 transfer_money({"amount":100,"payee":"张三"}) → 成功：转账成功')
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
        { amount: 30, payee: '王五', decision: 'not-required', tier: 'green', execution: 'succeeded' },
      ])
    })
  })

  it('审批未结论 / 无结果：审批 pending，执行 blocked 或 pending，绝不冒充成功', async () => {
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
      // 绿色直通 + 没有结果：执行只能记 pending
      session.append('tool/call', {
        callId: 'c2',
        name: 'transfer_money',
        args: { amount: 20, payee: '王五' },
        fingerprint: 'g',
        tier: { level: 'green' },
        at: 0,
      })
      // 与钱无关的调用不进金融条目
      session.append('tool/call', {
        callId: 'c3',
        name: 'query_rate',
        args: {},
        fingerprint: 'h',
        tier: { level: 'green' },
        at: 0,
      })
      session.append('tool/result', {
        callId: 'c3',
        name: 'query_rate',
        isError: false,
        content: [{ type: 'text', text: '3.1%' }],
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      expect(extractFinancial(session.events())).toEqual([
        {
          amount: 50,
          payee: '李四',
          ticketId,
          decision: 'pending',
          tier: 'yellow',
          execution: 'blocked',
          code: 'approval-rejected',
        },
        { amount: 20, payee: '王五', decision: 'not-required', tier: 'green', execution: 'pending' },
      ])
    })
  })

  it('审批拒绝 → 未执行（blocked），不是执行失败', async () => {
    await withSession((session) => {
      const ticketId = 'ticket:c1' as TicketId
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', {
        callId: 'c1',
        name: 'transfer_money',
        args: { amount: 60, payee: '赵六' },
        fingerprint: 'f',
        tier: { level: 'yellow' },
        at: 0,
      })
      session.append('approval/asked', { ticketId, callId: 'c1', name: 'transfer_money', amount: 60 })
      session.append('approval/decided', { ticketId, decision: 'rejected' })
      session.append('tool/result', {
        callId: 'c1',
        name: 'transfer_money',
        isError: true,
        content: [{ type: 'text', text: '审批未通过' }],
        code: 'approval-rejected',
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const entries = extractFinancial(session.events())
      expect(entries[0]).toMatchObject({
        decision: 'rejected',
        execution: 'blocked',
        code: 'approval-rejected',
      })
      const text = renderSummaryText({
        fromTurn: 1,
        toTurn: 1,
        turns: 1,
        droppedMessages: 2,
        highlights: [],
        toolCalls: [],
        financial: entries,
      })
      expect(text).toContain('审批 rejected，票据 ticket:c1；未执行，理由码 approval-rejected')
      expect(text).not.toContain('执行成功')
    })
  })

  it('审批通过但执行失败 → execution=failed，不能写成成功', async () => {
    await withSession((session) => {
      const ticketId = 'ticket:c1' as TicketId
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', {
        callId: 'c1',
        name: 'transfer_money',
        args: { amount: 70, payee: '孙七' },
        fingerprint: 'f',
        tier: { level: 'yellow' },
        at: 0,
      })
      session.append('approval/asked', { ticketId, callId: 'c1', name: 'transfer_money', amount: 70 })
      session.append('approval/decided', { ticketId, decision: 'allowed-once' })
      session.append('tool/result', {
        callId: 'c1',
        name: 'transfer_money',
        isError: true,
        content: [{ type: 'text', text: '余额不足' }],
        code: 'insufficient-funds',
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const entries = extractFinancial(session.events())
      expect(entries[0]).toMatchObject({ decision: 'allowed-once', execution: 'failed' })
      const text = renderSummaryText({
        fromTurn: 1,
        toTurn: 1,
        turns: 1,
        droppedMessages: 2,
        highlights: [],
        toolCalls: [],
        financial: entries,
      })
      expect(text).toContain('审批 allowed-once，票据 ticket:c1；执行失败，理由码 insufficient-funds')
      expect(text).not.toContain('执行成功')
    })
  })

  it('黄色调用在审批前被策略拦截：不能写成“绿色直通”，执行记 blocked', async () => {
    await withSession((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', {
        callId: 'c1',
        name: 'transfer_money',
        args: { amount: 9000, payee: '张三' },
        fingerprint: 'f',
        tier: { level: 'yellow', amountPath: 'amount' },
        at: 0,
      })
      // sentry 在 tools/pre-execute 就拒了：票据根本没签，工具一次都没跑
      session.append('tool/result', {
        callId: 'c1',
        name: 'transfer_money',
        isError: true,
        content: [{ type: 'text', text: '会话已降级为只绿模式：非绿级工具一律拒绝' }],
        code: 'sentry-degraded',
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const entries = extractFinancial(session.events())
      expect(entries[0]).toMatchObject({
        decision: 'not-requested',
        tier: 'yellow',
        execution: 'blocked',
        code: 'sentry-degraded',
      })
      const text = renderSummaryText({
        fromTurn: 1,
        toTurn: 1,
        turns: 1,
        droppedMessages: 2,
        highlights: [],
        toolCalls: [],
        financial: entries,
      })
      expect(text).toContain(
        '未进入审批（yellow 级调用被前置拦截）；未执行，理由码 sentry-degraded',
      )
      expect(text).not.toContain('绿色直通')
      expect(text).not.toContain('执行成功')
    })
  })

  it('金额未知不伪装成 0 元：amount 缺省，摘要写“金额未知”', async () => {
    await withSession((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', {
        callId: 'c1',
        name: 'transfer_money',
        args: { payee: '赵六' },
        fingerprint: 'f',
        tier: { level: 'green' },
        at: 0,
      })
      session.append('tool/result', {
        callId: 'c1',
        name: 'transfer_money',
        isError: false,
        content: [{ type: 'text', text: '已受理' }],
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const entries = extractFinancial(session.events())
      expect(entries).toEqual([
        { payee: '赵六', decision: 'not-required', tier: 'green', execution: 'succeeded' },
      ])
      expect(entries[0]?.amount).toBeUndefined()
      const text = renderSummaryText({
        fromTurn: 1,
        toTurn: 1,
        turns: 1,
        droppedMessages: 2,
        highlights: [],
        toolCalls: [],
        financial: entries,
      })
      expect(text).toContain('金额未知 → 赵六')
      expect(text).not.toContain('¥0.00')
    })
  })

  it('摘要文本：无工具调用 / 无资金条目时不留空标题', () => {
    const text = renderSummaryText({
      fromTurn: 1,
      toTurn: 2,
      turns: 2,
      droppedMessages: 4,
      highlights: [],
      toolCalls: [],
      financial: [],
    })
    expect(text).toContain('[已压缩历史] 第 1–2 轮（共 2 轮、4 条消息）')
    expect(text).not.toContain('工具调用合计：')
    expect(text).not.toContain('资金动作')
    // refs 只给审计回跳，不能向模型承诺它能取回原文；也不宣告“原文已失忆”
    expect(text).not.toContain('（见 refs）')
    expect(text).not.toContain('不要假设更早的对话原文仍在上下文中')
    expect(text).toContain('可用记录')
    expect(text).toContain('先按摘要补全指代')

    // 旧摘要数据没有 tier：不猜测是绿色直通，如实写“无票据记录”
    const legacy = renderSummaryText({
      fromTurn: 1,
      toTurn: 1,
      turns: 1,
      droppedMessages: 0,
      highlights: [],
      toolCalls: [],
      financial: [{ payee: '旧数据', decision: 'not-required', execution: 'pending' }],
    })
    expect(legacy).toContain('金额未知 → 旧数据（无票据记录；执行未完成（无结果））')
  })
})

describe('对话要点（摘要自足，可解析指代）', () => {
  it('保留用户原话、最后一条助手结论、工具参数与结果；runtime-context 不算用户原话', async () => {
    await withSession((session) => {
      const circular: Record<string, unknown> = {}
      circular['self'] = circular
      const long = '请按我刚才说的那个账户办理，'.repeat(20)

      session.append('turn/start', { turn: 1 })
      session.append('user/message', {
        content: '这是每次重渲染的运行时上下文',
        source: 'runtime-context',
      })
      session.append('user/message', { content: long })
      session.append('assistant/message', { content: [{ type: 'text', text: '先查一下账户' }] })
      session.append('assistant/message', { content: [{ type: 'text', text: '查到了，尾号 1234' }] })
      session.append('tool/call', {
        callId: 'c1',
        name: 'query_accounts',
        args: { tail: '1234' },
        fingerprint: 'f',
        tier: { level: 'green' },
        at: 0,
      })
      session.append('tool/result', {
        callId: 'c1',
        name: 'query_accounts',
        isError: false,
        content: [{ type: 'text', text: '账户 6222****1234（活期）余额 8800 元' }],
      })
      session.append('tool/call', {
        callId: 'c2',
        name: 'transfer_money',
        args: { amount: 10 },
        fingerprint: 'g',
        tier: { level: 'yellow' },
        at: 0,
      })
      session.append('tool/result', {
        callId: 'c2',
        name: 'transfer_money',
        isError: true,
        content: [{ type: 'text', text: '余额不足' }],
        code: 'insufficient-funds',
      })
      session.append('tool/call', {
        callId: 'c3',
        name: 'transfer_money',
        args: circular,
        fingerprint: 'h',
        tier: { level: 'yellow' },
        at: 0,
      })
      session.append('tool/result', {
        callId: 'c3',
        name: 'transfer_money',
        isError: true,
        content: [{ type: 'text', text: '审批未通过' }],
        code: 'approval-rejected',
      })
      session.append('tool/call', {
        callId: 'c4',
        name: 'query_rate',
        args: {},
        fingerprint: 'i',
        tier: { level: 'green' },
        at: 0,
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const highlights = extractHighlights(session.events())
      expect(highlights).toHaveLength(1)
      const turn = highlights[0]
      expect(turn?.user).not.toContain('运行时上下文')
      expect(turn?.user).toContain('请按我刚才说的那个账户办理')
      // 长文本按 160 字符截断（含省略号）
      expect([...(turn?.user ?? '')]).toHaveLength(160)
      expect(turn?.user.endsWith('…')).toBe(true)
      // 同一轮多条助手文本：最后一条胜出
      expect(turn?.assistant).toBe('查到了，尾号 1234')
      expect(turn?.tools.map((tool) => [tool.name, tool.status])).toEqual([
        ['query_accounts', 'succeeded'],
        ['transfer_money', 'failed'],
        ['transfer_money', 'blocked'],
        ['query_rate', 'pending'],
      ])
      expect(turn?.tools[0]?.result).toContain('6222****1234')
      expect(turn?.tools[1]?.code).toBe('insufficient-funds')
      expect(turn?.tools[2]?.args).toBe('（参数无法序列化）')
      expect(turn?.omittedTools).toBe(0)

      const text = renderSummaryText({
        fromTurn: 1,
        toTurn: 1,
        turns: 1,
        droppedMessages: 5,
        highlights,
        toolCalls: [],
        financial: [],
      })
      expect(text).toContain('用户：「请按我刚才说的那个账户办理')
      expect(text).toContain('助手：「查到了，尾号 1234」')
      expect(text).toContain('工具 query_accounts({"tail":"1234"}) → 成功：账户 6222****1234')
      expect(text).toContain('工具 transfer_money({"amount":10}) → 失败（insufficient-funds）：余额不足')
      expect(text).toContain('未执行（approval-rejected）：审批未通过')
      expect(text).toContain('工具 query_rate({}) → 结果未落账')
    })
  })

  it('单轮工具超过 8 次只逐条展示最近 8 次，其余保留计数', async () => {
    await withSession((session) => {
      session.append('turn/start', { turn: 1 })
      for (let index = 0; index < 10; index += 1) {
        session.append('tool/call', {
          callId: `c${index}`,
          name: 'query_rate',
          args: { index },
          fingerprint: `f${index}`,
          tier: { level: 'green' },
          at: index,
        })
      }
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const [turn] = extractHighlights(session.events())
      expect(turn?.tools).toHaveLength(8)
      expect(turn?.tools[0]?.args).toBe('{"index":2}')
      expect(turn?.omittedTools).toBe(2)

      const text = renderSummaryText({
        fromTurn: 1,
        toTurn: 1,
        turns: 1,
        droppedMessages: 0,
        highlights: turn === undefined ? [] : [turn],
        toolCalls: [{ name: 'query_rate', count: 10 }],
        financial: [],
      })
      expect(text).toContain('…另有 2 次工具调用（计数见合计）')
      expect(text).toContain('query_rate×10')
    })
  })

  it('对话要点有字符预算：超预算保留最近轮次，并说明省略了多少轮', () => {
    const quote = '账'.repeat(120)
    const highlights = Array.from({ length: 30 }, (_, index) => ({
      turn: index + 1,
      user: quote,
      assistant: quote,
      tools: [],
      omittedTools: 0,
    }))

    const text = renderSummaryText({
      fromTurn: 1,
      toTurn: 30,
      turns: 30,
      droppedMessages: 60,
      highlights,
      toolCalls: [],
      financial: [],
    })
    expect(text).toContain('更早的')
    expect(text).toContain('轮细节已省略')
    expect(text).toContain('第 30 轮')
    expect(text).not.toContain('第 1 轮｜')

    // 只有工具、没有对话的轮次也要有明确标题
    const toolOnly = renderSummaryText({
      fromTurn: 1,
      toTurn: 1,
      turns: 1,
      droppedMessages: 0,
      highlights: [
        {
          turn: 1,
          user: '',
          assistant: '',
          tools: [{ name: 'query_rate', args: '{}', status: 'pending', result: '' }],
          omittedTools: 0,
        },
      ],
      toolCalls: [],
      financial: [],
    })
    expect(toolOnly).toContain('- 第 1 轮\n  工具 query_rate({}) → 结果未落账')
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

describe('token 水位口径（§5.2）', () => {
  it('system/message 只计最后一条：多轮多份 system 头不按 step 数倍高估', async () => {
    await withSession((session) => {
      appendTurn(session, 1)
      appendTurn(session, 2)
      appendTurn(session, 3)

      const events = session.events()
      // 每轮 user/assistant 各 5，最后一份系统头 4：5×2×3 + 4
      expect(analyzeSession(events).tokens).toBe(34)
      // 旧的"逐条累加"口径会把三份系统头都算进去（42），正是 §5.2 的偏高来源
      expect(events.reduce((sum, event) => sum + estimateEventTokens(event), 0)).toBe(42)
    })
  })

  it('同一 turn 内多次 attempt 落多条 system：仍只算最后一条', async () => {
    await withSession((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('system/message', { content: '系统头 v1' })
      session.append('system/message', { content: '系统头 v1' })
      session.append('system/message', { content: '系统头 v1' })
      session.append('user/message', { content: '第 1 轮问题' })
      session.append('assistant/message', { content: [{ type: 'text', text: '第 1 轮回答' }] })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      expect(analyzeSession(session.events()).tokens).toBe(14)
    })
  })

  it('estimateRequestTokens 把工具 schema 计入请求开销（事件里没有工具定义）', () => {
    const tokens = estimateRequestTokens({
      modelId: 'm',
      messages: [{ role: 'user', content: [{ kind: 'text', text: '你好' }] }],
      tools: [
        { name: 'query_balance', description: '查询余额', schema: { type: 'object', properties: {} } },
      ],
    })
    // 文本 2 + name 4 + description 4 + schema `{"type":"object","properties":{}}` 9
    expect(tokens).toBe(19)
  })

  it('委托块按 name + args 计，推理 / 图片 / 文件块不计（与事件口径一致）', () => {
    const tokens = estimateRequestTokens({
      modelId: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { kind: 'reasoning', text: '想了很久'.repeat(50) },
            { kind: 'image', mimeType: 'image/png', data: 'AAAA' },
            { kind: 'file', mimeType: 'text/plain', name: 'a.txt', data: 'x' },
            { kind: 'tool-call', id: 'c1', name: 'query_balance', args: { tail: '1234' } },
          ],
        },
      ],
    })
    // name 4 + args `{"tail":"1234"}` 4
    expect(tokens).toBe(8)
  })

  /**
   * 为什么补：未知内容块种类必须**抛错**，不能返回 0。
   * 平台新增一种块（或下游把私有块塞进请求）时，静默按 0 计会让压缩水位系统性低估，
   * 表现为"上下文一点点超窗才炸"。这一支是 `assertNever` 的安全网，此前从未执行。
   */
  it('未知内容块种类 → 压缩水位估算 fail-loud（不静默按 0 计）', () => {
    expect(() =>
      estimateRequestTokens({
        modelId: 'm',
        messages: [
          {
            role: 'assistant',
            // 模拟"平台新增了一种块、本模块还没跟"：类型上到不了，运行时必须炸
            content: [{ kind: 'future-block' } as never],
          },
        ],
      }),
    ).toThrowError(/model-content-block/)
  })

  it('overheadTokens 参与 token 阈值判定，但缺省时行为不变', async () => {
    await withSession((session) => {
      seedTurns(session)
      const events = session.events()
      const base = analyzeSession(events).tokens
      const thresholds = resolveCompactionConfig({ maxTokens: base + 50, keepRecentTurns: 1 })

      expect(planCompaction({ events, thresholds }).needed).toBe(false)
      // 阈值是 base+50：差 1 不触发，刚好相等触发（`>=` 边界）
      expect(planCompaction({ events, thresholds, overheadTokens: 49 }).needed).toBe(false)
      expect(planCompaction({ events, thresholds, overheadTokens: 50 }).needed).toBe(true)
    })
  })
})
