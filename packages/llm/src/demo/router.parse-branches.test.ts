/**
 * 演示路由的**未走到的分支**（02 单账单 / 04 单卡片）。
 *
 * `router.test.ts` 已钉住每种意图的一条主路径，本文件补它没经过的那半边：
 * 年度口径、按收款人分组、两种卡片理由、解冻的工具名。
 * 这几条都是"认得出但算错口径"型的风险——回答得很快、很自信，数字却是错的：
 * 把"近一年"按本月算，或把"按收款人"按品类分组，用户看不出来。
 */

import { describe, expect, it } from 'vitest'

import { classifyIntent, planFor, type DemoIntent } from './router.ts'

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

describe('额度与交易限制：缺什么问什么，绝不替用户猜', () => {
  const questionOf = (intent: DemoIntent): string =>
    String((intent as { readonly question?: string }).question ?? '')

  it('只说「调整额度」不给卡 ⇒ 追问是哪张卡', () => {
    const intent = classifyIntent('帮我调整额度')
    expect(intent).toMatchObject({ kind: 'clarify' })
    expect(questionOf(intent)).toContain('哪张卡的额度')
  })

  it('给了卡但没给金额 ⇒ 追问调到多少元', () => {
    const intent = classifyIntent('尾号 1234 的卡调整额度')
    expect(intent).toMatchObject({ kind: 'clarify' })
    expect(questionOf(intent)).toContain('调到多少元')
  })

  it('日限额与信用卡授信额度分别落参数（两种额度不混投）', () => {
    expect(classifyIntent('把尾号 1234 的卡日限额调到 5000')).toMatchObject({
      kind: 'card',
      action: 'setLimit',
      cardId: 'c-1',
      dailyLimitYuan: 5000,
    })
    expect(classifyIntent('把尾号 2468 的信用卡额度调到 50000')).toMatchObject({
      kind: 'card',
      action: 'setLimit',
      cardId: 'c-3',
      creditLimitYuan: 50000,
    })
  })

  it('「关闭线上支付」不给卡 ⇒ 追问是哪张卡的交易限制', () => {
    const intent = classifyIntent('关闭线上支付')
    expect(intent).toMatchObject({ kind: 'clarify' })
    expect(questionOf(intent)).toContain('交易限制')
  })

  it('AA 缺总额 ⇒ 追问总额；只有一个名字 ⇒ 名单正则不认，追问有哪几个人', () => {
    const noAmount = classifyIntent('我们几个 AA 一下')
    expect(noAmount).toMatchObject({ kind: 'clarify' })
    expect(questionOf(noAmount)).toContain('AA 一共多少钱')

    // 正则要求"名字 + 分隔符 + 名字"，单人说法根本匹配不上名单 ⇒ 走"有哪几个人"
    const oneName = classifyIntent('张三 AA 300')
    expect(oneName).toMatchObject({ kind: 'clarify' })
    expect(questionOf(oneName)).toContain('哪几个人')

    expect(classifyIntent('张三、李四 AA 300')).toMatchObject({
      kind: 'aa',
      totalYuan: 300,
      participants: ['张三', '李四'],
    })
  })
})

describe('planFor 的收尾话术：状态、动作与对象都要对得上', () => {
  const flat = (intent: DemoIntent): string => JSON.stringify(planFor(intent))

  it('资金锁定三态各有自己的话术（不把解除说成已锁定）', () => {
    expect(flat({ kind: 'fundLock', action: 'status' })).toContain('已查到当前锁定金额')
    expect(flat({ kind: 'fundLock', action: 'lock', amountYuan: 500 })).toContain('资金已锁定')
    expect(flat({ kind: 'fundLock', action: 'release' })).toContain('已解除锁定')
  })

  it('交易密码：发起交办与查状态是两条话术', () => {
    expect(flat({ kind: 'password', action: 'request' })).toContain('已发起交易密码修改')
    expect(flat({ kind: 'password', action: 'status' })).toContain('最近改密时刻')
  })

  it('商户：search 只反思结果，order 才承诺"已下单"', () => {
    const search = flat({ kind: 'merchant', action: 'search', category: 'flower' })
    expect(search).toContain('merchant_search')
    expect(search).not.toContain('已下单')
    const order = flat({ kind: 'merchant', action: 'order', category: 'cake', budgetYuan: 200 })
    expect(order).toContain('merchant_order')
    expect(order).toContain('已下单')
  })

  it('月限额与授信额度分别进 card_limit_set 的参数', () => {
    expect(flat({ kind: 'card', action: 'setLimit', cardId: 'c-1', monthlyLimitYuan: 20000 })).toContain(
      'monthlyLimitYuan',
    )
    expect(flat({ kind: 'card', action: 'setLimit', cardId: 'c-3', creditLimitYuan: 50000 })).toContain(
      'creditLimitYuan',
    )
  })

  it('记住事实：ISO 日期换算成"X 月 Y 日"给人看', () => {
    expect(
      flat({ kind: 'factRemember', person: '爱人', relation: 'spouse', date: '1990-03-08' }),
    ).toContain('03 月 08 日')
  })
})
