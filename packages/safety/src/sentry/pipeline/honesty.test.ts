/**
 * 幻觉防护（施工单 10 §4）：数值对账 + 无工具结果不陈述。
 *
 * T-SNT-006（post-execute block + 纠正文本）、T-SNT-007（turn-stopping 纠正 + 审计）。
 */

import { createContext } from '@bah/core'
import type { Context, SessionId } from '@bah/core'
import { describe, expect, it } from 'vitest'

import {
  detectAccountFacts,
  detectActionClaims,
  provideSentry,
  resolveSentrySettings,
  type SentryHandle,
} from './index.ts'

/** 幻觉防护测试台。 */
function harness(overrides: Readonly<Record<string, unknown>> = {}): {
  readonly ctx: Context
  readonly handle: SentryHandle
  readonly events: { type: string; data: Record<string, unknown> }[]
  readonly nudges: { agentId: string; text: string }[]
  readonly stopped: string[]
  emit(type: string, data: unknown): void
  postExecute(call: { callId: string; name: string; args: Record<string, unknown> }, text: string): Promise<{ kind: string; code?: string; reason?: string }>
  turnStopping(turn: number): Promise<void>
} {
  const ctx = createContext()
  const events: { type: string; data: Record<string, unknown> }[] = []
  const nudges: { agentId: string; text: string }[] = []
  const stopped: string[] = []
  let now = 1_000
  let seq = 0
  const settings = resolveSentrySettings(overrides)
  const handle = provideSentry(ctx, settings, {
    sessionId: 's-honesty' as SessionId,
    now: () => {
      now += 1
      return now
    },
    record: (type, data) => events.push({ type, data: data as Record<string, unknown> }),
    toolTier: () => undefined,
    ticketStatus: () => undefined,
    revokeTickets: () => 0,
    nudge: (agentId, text) => nudges.push({ agentId, text }),
  })
  return {
    ctx,
    handle,
    events,
    nudges,
    stopped,
    emit(type, data) {
      seq += 1
      ctx.events.emit('session/event', { session: 's-honesty', event: { type, seq, data } })
    },
    async postExecute(call, text) {
      const result = (await ctx.events.waterfall('tools/post-execute', {
        call,
        content: [{ type: 'text', text }],
        verdict: { kind: 'accept' },
      })) as { verdict: { kind: string; code?: string; reason?: string } }
      return result.verdict
    },
    async turnStopping(turn) {
      await ctx.events.serial('agent/turn-stopping', {
        agent: { id: 'a-1', sessionId: 's-honesty' },
        turn,
        signal: new AbortController().signal,
        stop: (reason?: string) => stopped.push(reason ?? 'stopped'),
      })
    },
  }
}

/** 落一条 assistant 陈述。 */
function say(test: { emit(type: string, data: unknown): void }, text: string): void {
  test.emit('assistant/message', { content: [{ type: 'text', text }] })
}

describe('honesty（数值对账：声明值 vs 权威值）', () => {
  it('T-SNT-006 声明 5,000 元 vs 结果 ¥800.00 → post-execute block + 纠正文本', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    say(test, '这笔转账金额是 5,000 元，已经安排。')
    const verdict = await test.postExecute(
      { callId: 'c-1', name: 'transfer_create', args: {} },
      '转账成功：¥800.00 → 王建国',
    )
    expect(verdict.kind).toBe('block')
    expect(verdict.code).toBe('honesty-number-mismatch')
    expect(verdict.reason).toContain('¥800.00')
    expect(verdict.reason).toContain('¥5,000.00')
    expect(test.events.some((event) => event.type === 'sentry/honesty-corrected')).toBe(true)
    expect(test.handle.trace.counters.escalations).toBe(1)
  })

  it('金额一致（含千分位 / 万元 / 元角分）→ accept', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    say(test, '余额为 ¥12,345.67，另有 1.5 万元与 12 元 3 角 4 分。')
    const verdict = await test.postExecute(
      { callId: 'c-1', name: 'account_balance', args: {} },
      '余额 ¥12,345.67；理财 1.5 万元；手续费 12 元 3 角 4 分',
    )
    expect(verdict.kind).toBe('accept')
  })

  it('声明值在参数备注里也参与对账', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    const verdict = await test.postExecute(
      {
        callId: 'c-1',
        name: 'transfer_create',
        args: { remark: '按客户要求转 5,000 元' },
      },
      '转账成功：¥800.00',
    )
    expect(verdict.kind).toBe('block')
  })

  it('参数里的数字 / 布尔值不参与金额抽取（只取字符串）', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    say(test, '已转出 800 元。')
    const verdict = await test.postExecute(
      {
        callId: 'c-1',
        name: 'transfer_create',
        args: { amount: 800, confirmed: true },
      },
      '转账成功：¥800.00',
    )
    expect(verdict.kind).toBe('accept')
  })

  it('没有可识别金额 / 下游已非 accept 时不动判决', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    expect(
      (await test.postExecute({ callId: 'c-1', name: 'verify_sms', args: {} }, '验证通过')).kind,
    ).toBe('accept')

    const ctx = test.ctx
    const result = (await ctx.events.waterfall('tools/post-execute', {
      call: { callId: 'c-2', name: 'transfer_create', args: {} },
      content: [{ type: 'text', text: '¥800.00' }],
      verdict: { kind: 'addContext', texts: ['已有纠正'] },
    })) as { verdict: { kind: string } }
    expect(result.verdict.kind).toBe('addContext')
  })

  it('honesty.numeric=false 时不阻塞', async () => {
    const test = harness({ honesty: { numeric: false } })
    test.emit('turn/start', { turn: 1 })
    say(test, '这笔转账金额是 5,000 元。')
    const verdict = await test.postExecute(
      { callId: 'c-1', name: 'transfer_create', args: {} },
      '转账成功：¥800.00',
    )
    expect(verdict.kind).toBe('accept')
  })
})

describe('honesty（turn-stopping：无工具结果不陈述）', () => {
  it('T-SNT-007 本 turn 无工具结果却陈述余额 → 纠正提示 + 审计（同 turn 只纠正一次）', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    say(test, '您的账户余额是 ¥12,345.67。')
    await test.turnStopping(1)
    expect(test.nudges).toHaveLength(1)
    expect(test.nudges[0]?.agentId).toBe('a-1')
    expect(test.nudges[0]?.text).toContain('没有任何工具结果')
    const corrected = test.events.filter((event) => event.type === 'sentry/honesty-corrected')
    expect(corrected).toHaveLength(1)
    expect(corrected[0]?.data['kind']).toBe('no-result')

    await test.turnStopping(1)
    expect(test.nudges).toHaveLength(1)
  })

  it('本 turn 有 read/* 结果 → 不纠正', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    test.emit('read/balance', { result: {} })
    test.emit('tool/result', {
      callId: 'c-1',
      name: 'account_balance',
      isError: false,
      content: [{ type: 'text', text: '余额 ¥12,345.67' }],
    })
    say(test, '您的账户余额是 ¥12,345.67。')
    await test.turnStopping(1)
    expect(test.nudges).toEqual([])
  })

  it('全 turn 数值复核：陈述 5,000 元但权威值 ¥800.00 → numeric 纠正', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    say(test, '已转出 5,000 元。')
    test.emit('tool/result', {
      callId: 'c-1',
      name: 'transfer_create',
      isError: false,
      content: [{ type: 'text', text: '转账成功：¥800.00' }],
    })
    await test.turnStopping(1)
    expect(test.nudges).toHaveLength(1)
    expect(test.nudges[0]?.text).toContain('¥800.00')
    expect(test.nudges[0]?.text).toContain('¥5,000.00')
  })

  it('全 turn 数值一致 → 不纠正', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    say(test, '已转出 800 元。')
    test.emit('tool/result', {
      callId: 'c-1',
      name: 'transfer_create',
      isError: false,
      content: [{ type: 'text', text: '转账成功：¥800.00' }],
    })
    await test.turnStopping(1)
    expect(test.nudges).toEqual([])
  })

  it('S-1 拒绝后仍称完成 → 行动断言纠正（不是数值纠正）', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    test.emit('tool/result', {
      callId: 'c-1',
      name: 'transfer_create',
      isError: true,
      code: 'approval-rejected',
      content: [{ type: 'text', text: '未执行：审批被拒绝' }],
    })
    say(test, '已为您完成 800 元转账，已审批并核销。')

    await test.turnStopping(1)

    expect(test.nudges).toHaveLength(1)
    expect(test.nudges[0]?.text).toContain('行动断言')
    expect(test.nudges[0]?.text).toContain('核销完成')
    const corrected = test.events.filter((event) => event.type === 'sentry/honesty-corrected')
    expect(corrected).toHaveLength(1)
    expect(corrected[0]?.data['kind']).toBe('action-claim')
    expect(test.stopped).toEqual([])
  })

  it('S-1 只有读结果却称"已转账" → 纠正（转账必须有 transfer_create 成功）', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    test.emit('tool/result', {
      callId: 'c-1',
      name: 'account_balance',
      isError: false,
      content: [{ type: 'text', text: '余额 ¥12,345.67' }],
    })
    say(test, '已转账成功，800 元已经到账。')

    await test.turnStopping(1)

    expect(test.nudges).toHaveLength(1)
    expect(test.nudges[0]?.text).toContain('没有成功的转账结果')
    expect(test.stopped).toEqual([])
  })

  it('S-1 转账真的成功 → 不纠正', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    test.emit('tool/result', {
      callId: 'c-1',
      name: 'transfer_create',
      isError: false,
      content: [{ type: 'text', text: '转账成功：¥800.00 → 王建国' }],
    })
    say(test, '已转账 800 元。')

    await test.turnStopping(1)

    expect(test.nudges).toEqual([])
    expect(test.stopped).toEqual([])
  })

  it('S-1 纠正过一次仍不改口 → 判停（同一 turn 不再重复 nudge）', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    test.emit('tool/result', {
      callId: 'c-1',
      name: 'transfer_create',
      isError: true,
      code: 'approval-rejected',
      content: [{ type: 'text', text: '未执行：审批被拒绝' }],
    })
    say(test, '已转账成功。')

    await test.turnStopping(1)
    await test.turnStopping(1)

    expect(test.nudges).toHaveLength(1)
    expect(test.stopped).toHaveLength(1)
    expect(test.stopped[0]).toContain('已纠正过一次')
  })

  /**
   * `complete` 这一类的两句文案是**给用户看的诚实陈述**（「办理完成」/「没有任何成功的工具结果」），
   * 既有 3 个类别里只有它没被断过。这里断**完整字符串**而不是 `toContain`：
   * 改一个字就红，防止有人把"没有任何成功的工具结果"润色成"尚未执行"这类失真说法。
   */
  it('S-1 没有任何成功工具却称"操作成功" → 纠正文案逐字钉死（办理完成 / 没有任何成功的工具结果）', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    say(test, '您的业务已受理，操作成功。')

    await test.turnStopping(1)

    expect(test.nudges).toHaveLength(1)
    expect(test.nudges[0]?.agentId).toBe('a-1')
    expect(test.nudges[0]?.text).toBe(
      '【行动断言】本 turn 的工具结局不支持你声称的「办理完成」：没有任何成功的工具结果。' +
        '请据实说明未执行或失败的原因，不得声称已完成。',
    )
    const corrected = test.events.filter((event) => event.type === 'sentry/honesty-corrected')
    expect(corrected).toHaveLength(1)
    expect(corrected[0]?.data['kind']).toBe('action-claim')
    expect(test.stopped).toEqual([])
  })

  /**
   * "有结果但全失败"与"一个结果都没有"对 `complete` 断言来说是同一个结局：
   * 核对的是**成功工具数**（`successfulToolCount()`），不是结果条数。
   */
  it('S-1 只有失败结果却称"已处理" → 同一句 complete 文案（成功数为 0 即不支持）', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    test.emit('tool/result', {
      callId: 'c-1',
      name: 'wealth_purchase',
      isError: true,
      code: 'approval-rejected',
      content: [{ type: 'text', text: '未执行：审批被拒绝' }],
    })
    say(test, '您的申购已处理完毕。')

    await test.turnStopping(1)

    expect(test.nudges).toHaveLength(1)
    expect(test.nudges[0]?.text).toBe(
      '【行动断言】本 turn 的工具结局不支持你声称的「办理完成」：没有任何成功的工具结果。' +
        '请据实说明未执行或失败的原因，不得声称已完成。',
    )
  })

  /**
   * 复审实测（2026-10-23）暴露的漏判，正是**演示主路径上最可能出现的说法**：
   * 预览成功、创建被拒（用户点了拒绝）之后，模型说"转账已完成"——
   * 旧规则只把它归到 `complete`，而 `complete` 在"有任一成功工具"时不拦，
   * 于是这句假话不会被纠正。这条用例钉住"transfer 必须由 transfer_create 背书"。
   */
  it('S-1 预览成功但创建被拒 → "转账已完成"必须纠正（complete 不替 transfer 兜底）', async () => {
    const test = harness()
    test.emit('turn/start', { turn: 1 })
    test.emit('tool/result', {
      callId: 'c-preview',
      name: 'transfer_preview',
      isError: false,
      content: [{ type: 'text', text: '试算结果：转账 800 元，手续费 ¥0.00' }],
    })
    test.emit('tool/result', {
      callId: 'c-create',
      name: 'transfer_create',
      isError: true,
      code: 'approval-rejected',
      content: [{ type: 'text', text: '未执行：审批被拒绝' }],
    })
    say(test, '审批被拒绝，但转账已完成。')

    await test.turnStopping(1)

    expect(test.nudges).toHaveLength(1)
    expect(test.nudges[0]?.text).toContain('没有成功的转账结果')
    expect(test.stopped).toEqual([])
  })

  /**
   * 分句判定与否定词的边界。
   *
   * 三条都是"整句判定会判错"的样本，改动 `CLAUSE_SEP` / `NON_SUCCESS` 前先看这里。
   */
  it('S-1 断言识别：转折句 / "待确认" / 办事动词各自按分句判定', () => {
    // 转折连词处切断：前半句的"拒绝"不能把后半句的真假一起放掉
    expect(detectActionClaims(['审批被拒绝，但转账已完成。'])).toEqual(['transfer'])
    expect(detectActionClaims(['转账已完成，请注意查收。'])).toEqual(['transfer'])
    // `待` 不是否定词：钱已经动了，"待确认收款"说的是后续动作
    expect(detectActionClaims(['已完成转账，待您确认收款。'])).toEqual(['transfer'])
    expect(detectActionClaims(['已为您办理成功，无需再次确认。'])).toEqual(['complete'])
    // 未执行 / 查询类完成，都不是行动断言
    expect(detectActionClaims(['本次转账未执行：审批被拒绝。'])).toEqual([])
    expect(detectActionClaims(['我已完成查询，您的余额为 1,234.56 元。'])).toEqual([])
    expect(detectActionClaims(['查询操作成功，余额 ¥1.00。'])).toEqual([])
    // "已提交"不是"已完成"：提交只进了审批队列
    expect(detectActionClaims(['已提交转账申请，请等待审批。'])).toEqual([])
  })

  it('S-1 断言识别：否定 / 将来语境不算断言', () => {
    expect(detectActionClaims(['预计 2 小时内到账，请耐心等待。'])).toEqual([])
    expect(detectActionClaims(['转账未成功，已拒绝。'])).toEqual([])
    expect(detectActionClaims(['已核销。'])).toEqual(['redeem'])
    expect(detectActionClaims(['已转账 800 元。'])).toEqual(['transfer'])
  })

  it('T-SNT-011 同 turn 工具数超限 → stop + guard/repeat-tool', async () => {
    const test = harness({ guard: { maxToolsPerTurn: 1 } })
    test.emit('turn/start', { turn: 1 })
    test.emit('tool/call', { callId: 'a', name: 'account_balance' })
    test.emit('tool/call', { callId: 'b', name: 'account_balance' })
    await test.turnStopping(1)
    expect(test.stopped).toHaveLength(1)
    expect(test.stopped[0]).toContain('工具调用数超限')
    expect(test.events.some((event) => event.type === 'guard/repeat-tool')).toBe(true)
  })

  it('账户事实识别器只认断言，不认问句 / 一般陈述', () => {
    expect(detectAccountFacts(['您的账户余额是 ¥1.00'])).toBe(true)
    expect(detectAccountFacts(['请问您想查询哪个账户的余额？'])).toBe(false)
    expect(detectAccountFacts(['已为你完成转账'])).toBe(false)
    expect(detectAccountFacts([])).toBe(false)
  })
})
