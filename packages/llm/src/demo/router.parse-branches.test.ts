/**
 * 演示路由的**未走到的分支**（02 单账单 / 04 单卡片）。
 *
 * `router.test.ts` 已钉住每种意图的一条主路径，本文件补它没经过的那半边：
 * 年度口径、按收款人分组、两种卡片理由、解冻的工具名。
 * 这几条都是"认得出但算错口径"型的风险——回答得很快、很自信，数字却是错的：
 * 把"近一年"按本月算，或把"按收款人"按品类分组，用户看不出来。
 */

import { describe, expect, it } from 'vitest'

import { classifyIntent, planFor } from './router.ts'

describe('账单口径：年度与收款人分组', () => {
  it.each([
    '分析近一年的账单',
    '把账单按十二个月看一下',
    '看一下 12 个月的收支',
    '看一下12个月的收支',
  ])('「%s」⇒ period=year（不回落本月）', (text) => {
    expect(classifyIntent(text)).toMatchObject({ kind: 'bill', period: 'year' })
  })

  it('季度优先于年度：「近三个月」不能被年度词抢走', () => {
    expect(classifyIntent('近三个月的账单')).toMatchObject({ kind: 'bill', period: 'quarter' })
  })

  it.each([
    '本月账单按收款人分析',
    '账单按对方分析',
  ])('「%s」⇒ groupBy=payee（不是默认的 category）', (text) => {
    expect(classifyIntent(text)).toMatchObject({
      kind: 'bill',
      action: 'analyze',
      groupBy: 'payee',
    })
  })

  it('收款人分组也要走到工具：参数原样进 bill_analyze', () => {
    const steps = planFor(classifyIntent('近一年的账单按收款人分析'))
    expect(steps[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'bill_analyze',
      args: { period: 'year', groupBy: 'payee' },
    })
  })
})

describe('卡片理由：盗刷与遗失走不同文案', () => {
  it('疑似盗刷 ⇒ reason=疑似盗刷（挂失也是这个理由）', () => {
    expect(classifyIntent('挂失尾号 5678 的银行卡，疑似盗刷')).toEqual({
      kind: 'card',
      action: 'reportLost',
      cardId: 'c-2',
      reason: '疑似盗刷',
    })
  })

  it('卡找不到 ⇒ reason=卡片暂时找不到（冻结才把理由带进参数）', () => {
    expect(classifyIntent('冻结尾号 1234 的银行卡，卡找不到了')).toEqual({
      kind: 'card',
      action: 'freeze',
      cardId: 'c-1',
      reason: '卡片暂时找不到',
    })
  })

  it('冻结带理由 ⇒ card_freeze 的 args 里有 reason，且不硬编码到别的动作上', () => {
    const steps = planFor(classifyIntent('冻结尾号 1234 的银行卡，疑似盗刷'))
    expect(steps[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'card_freeze',
      args: { cardId: 'c-1', reason: '疑似盗刷' },
    })
  })

  it('解冻 ⇒ 工具名是 card_unfreeze（不能落回 card_freeze），且不带 reason', () => {
    expect(classifyIntent('解冻尾号 1234 的银行卡')).toEqual({
      kind: 'card',
      action: 'unfreeze',
      cardId: 'c-1',
    })
    const steps = planFor(classifyIntent('解冻尾号 1234 的银行卡'))
    expect(steps[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'card_unfreeze',
      args: { cardId: 'c-1' },
    })
    // 解冻不带 reason：只有冻结把理由传给工具（04 单 §理由口径）
    expect(steps[1]?.outcome?.tool).toBe('card_unfreeze')
  })
})
