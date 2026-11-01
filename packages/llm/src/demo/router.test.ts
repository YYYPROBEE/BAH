/**
 * 离线意图路由（`@bah/llm/demo`）。
 *
 * 这一组用例守的是"**不许答非所问**"：
 * - 认得出的意图必须走到对应工具，而不是吐一句固定文案；
 * - 认不出的一律追问，不许猜一个默认收款人/默认金额；
 * - 转账必须走预览 → 执行两步，不许一步扣款。
 */

import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import type { LlmMessage, LlmRequest } from '../llm/types.ts'

import {
  classifyIntent,
  extractAmount,
  extractPayee,
  lastUserText,
  parseTransfer,
  planFor,
  planFromRequest,
  type DemoIntent,
} from './router.ts'

/** 造一条用户消息。 */
function user(text: string): LlmMessage {
  return { role: 'user', content: [{ kind: 'text', text }] }
}

/** 造一条 assistant 消息（内容不重要，只用来数"本轮第几步"）。 */
function assistant(): LlmMessage {
  return { role: 'assistant', content: [{ kind: 'text', text: '……' }] }
}

describe('意图识别：认得出 / 认不出就追问', () => {
  it('余额类 → balance', () => {
    for (const text of ['帮我查下余额', '我还有多少钱', '卡里还剩多少', '账户余额多少']) {
      expect(classifyIntent(text).kind, text).toBe('balance')
    }
  })

  it('转账类 → transfer，且抽出金额与收款人', () => {
    const intent = classifyIntent('给王建国转 800 元房租')
    expect(intent.kind).toBe('transfer')
    if (intent.kind !== 'transfer') return
    expect(intent.request).toMatchObject({ amount: 800, payeeName: '王建国' })
  })

  it('认不出的问题 → 追问，不猜意图', () => {
    const intent = classifyIntent('帮我写一首关于春天的诗')
    expect(intent.kind).toBe('clarify')
    if (intent.kind !== 'clarify') return
    expect(intent.question).toContain('查账户余额')
  })

  it('空消息 → 追问', () => {
    expect(classifyIntent('   ').kind).toBe('clarify')
  })
})

describe('要素抽取：抽不全就追问，不补默认值', () => {
  it('带"元"的数字优先，不把卡号当金额', () => {
    expect(extractAmount('尾号 3333 的卡，转 800 元')).toBe(800)
    expect(extractAmount('转 1,200.50 元')).toBe(1200.5)
    expect(extractAmount('转八元')).toBe(8)
    expect(extractAmount('给王建国转账')).toBeUndefined()
  })

  it('"给 X 转" 与 "转给 X" 两种说法都能抽姓名', () => {
    expect(extractPayee('给王建国转 800 元')).toBe('王建国')
    expect(extractPayee('转给李四 200 元')).toBe('李四')
    expect(extractPayee('转 800 元')).toBeUndefined()
  })

  it('11 位手机号可作为收款人', () => {
    expect(extractPayee('给 13800005678 转 2000')).toBe('13800005678')
    expect(extractPayee('转给 13800005678 200 元')).toBe('13800005678')
    expect(parseTransfer('给 13800005678 转 2000')).toMatchObject({
      kind: 'transfer',
      request: { amount: 2000, payeeName: '13800005678' },
    })
  })

  it('只有金额没姓名 → 改道意图平面，追问目标仍是收款人（03 单）', () => {
    const intent = classifyIntent('转 800 元')
    expect(intent).toMatchObject({ kind: 'intent', route: 'slotGap', scene: 'transfer' })
    if (intent.kind !== 'intent') return
    expect(intent.ask?.slot).toBe('payee')
    expect(intent.ask?.question).toContain('收款人')
  })

  it('只有姓名没金额 → 改道意图平面，但不硬发选择题（askHint 才是指挥棒）', () => {
    const intent = classifyIntent('给王建国转账')
    expect(intent).toMatchObject({ kind: 'intent', route: 'slotGap' })
    if (intent.kind !== 'intent') return
    // router 不知道 intent_resolve 的 askHint 指向哪个槽位：缺金额时只发意图工具 + 文案
    expect(intent.ask).toBeUndefined()
  })
})

describe('步骤规划：转账必须走预览 → 执行 → 收尾', () => {
  const intent: DemoIntent = {
    kind: 'transfer',
    request: { amount: 800, payeeName: '王建国' },
  }

  it('三步且顺序固定，第一步是只读预览', () => {
    const steps = planFor(intent)
    expect(steps).toHaveLength(3)

    const first = steps[0]?.content?.[0]
    expect(first).toMatchObject({ kind: 'tool-call', name: 'transfer_preview' })

    const second = steps[1]?.content?.[0]
    expect(second).toMatchObject({ kind: 'tool-call', name: 'transfer_create' })

    // 收尾按工具结局二选一，不写死"已完成"
    expect(steps[2]?.outcome?.tool).toBe('transfer_create')
    expect(steps[2]?.outcome?.failed).toContain('未执行')
  })

  it('金额与收款人来自原话，不是写死的 800 / 王建国', () => {
    const other = planFor({ kind: 'transfer', request: { amount: 250, payeeName: '李四' } })
    const args = other[0]?.content?.[0]
    expect(args).toMatchObject({ args: { amount: 250, payee: { name: '李四' } } })
    expect(other[2]?.outcome?.ok).toContain('250')
  })

  it('余额是两步：查 → 复述结果（不自己编数字）', () => {
    const steps = planFor({ kind: 'balance' })
    expect(steps).toHaveLength(2)
    expect(steps[0]?.content?.[0]).toMatchObject({ kind: 'tool-call', name: 'account_balance' })
    expect(steps[1]?.reflect?.tool).toBe('account_balance')
  })

  it('追问是一步纯文本，不调工具', () => {
    const steps = planFor({ kind: 'clarify', question: '要转给谁？' })
    expect(steps).toHaveLength(1)
    expect(steps[0]?.content?.[0]).toMatchObject({ kind: 'text', text: '要转给谁？' })
  })
})

describe('从请求规划：步骤由消息决定，不由调用次数决定', () => {
  it('同一份适配器，问余额与问转账得到不同规划', () => {
    const balance = planFromRequest({ modelId: 'router-chat', messages: [user('查下余额')] })
    const transfer = planFromRequest({ modelId: 'router-chat', messages: [user('给李四转 250 元')] })

    expect(balance[0]?.content?.[0]).toMatchObject({ name: 'account_balance' })
    expect(transfer[0]?.content?.[0]).toMatchObject({ name: 'transfer_preview', args: { amount: 250 } })
  })

  it('只看最后一条用户消息（多轮里历史意图不串台）', () => {
    const messages = [user('查下余额'), assistant(), user('给李四转 250 元')]
    const text = lastUserText(messages)
    expect(text).toBe('给李四转 250 元')
    expect(planFromRequest({ modelId: 'router-chat', messages })[0]?.content?.[0]).toMatchObject({
      name: 'transfer_preview',
    })
  })
})

describe('转账要素缺失的追问分支（缺一件问一件，两件都缺问整句）', () => {
  it('既没说收款人也没说金额 → 追问"要转给谁、转多少"（不是分别只问一件）', () => {
    // "转账" 命中粗筛但抽不出任何要素，走 parseTransfer 的最上游 clarify
    expect(parseTransfer('我要转账')).toMatchObject({
      kind: 'clarify',
      question: expect.stringContaining('要转给谁、转多少'),
    })
    // 03 单：追问从纯文案升级为结构化选择题（对外仍「遇到缺参就追问」）
    expect(classifyIntent('我要转账')).toMatchObject({ kind: 'intent', route: 'slotGap' })
  })

  it('只缺金额 → 追问里点名已识别的收款人（说明路由真的读到了姓名）', () => {
    expect(parseTransfer('给王建国转账')).toMatchObject({
      kind: 'clarify',
      question: expect.stringContaining('王建国'),
    })
  })

  it('只缺收款人 → 只问"要转给谁"', () => {
    expect(parseTransfer('转 800 元')).toMatchObject({
      kind: 'clarify',
      question: expect.stringContaining('收款人'),
    })
  })
})

describe('阿拉伯数字金额解析（无单位走 plain 分支；≥7 位当卡号不当金额）', () => {
  it('无"元/块"后缀的裸数字仍当金额（plain 分支）', () => {
    expect(extractAmount('转 800')).toBe(800)
  })

  it('裸数字带千分位逗号也解析正确', () => {
    expect(extractAmount('转 1,200')).toBe(1200)
  })

  it('明显的卡号/尾号（≥7 位）不进金额，宁可追问也不误扣真钱', () => {
    // 1234567 ≥ 1e6 → plain 判定当卡号跳过；无中文数字 → 金额 undefined
    expect(extractAmount('转 1234567')).toBeUndefined()
  })
})

describe('封闭联合兜底：新增意图忘了规划会当场红', () => {
  it('planFor 收到未知 kind → assertNever 抛 demo-intent（不静默返回空步骤）', () => {
    const bogus = { kind: 'not-a-real-intent' } as unknown as DemoIntent
    let caught: unknown
    try {
      planFor(bogus)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BahError)
    expect((caught as BahError).message).toContain('demo-intent')
  })
})

describe('意图平面的四条路由（03 单 §7.3；router 只认形态，不做语义判定）', () => {
  it('隐含意图：场景陈述且无转账线索 → implicit/unknown', () => {
    expect(classifyIntent('我爱人生日快到了')).toMatchObject({
      kind: 'intent',
      route: 'implicit',
      scene: 'unknown',
    })
  })

  it('模糊复现：历史指代 + 重办语义 → recall/transfer', () => {
    expect(classifyIntent('上次那个转账再来一次')).toMatchObject({
      kind: 'intent',
      route: 'recall',
      scene: 'transfer',
    })
  })

  it('跨场景引用 → crossScene', () => {
    expect(classifyIntent('把那边的事接着办')).toMatchObject({
      kind: 'intent',
      route: 'crossScene',
      scene: 'cross_scene',
    })
  })

  it('slotGap 的候选与演示夹具同源（两个收款人）', () => {
    const intent = classifyIntent('转500给他')
    expect(intent).toMatchObject({ kind: 'intent', route: 'slotGap' })
    if (intent.kind !== 'intent') return
    expect(intent.ask?.candidates).toEqual(['王建国', '张伟'])
  })

  it('四条路由的第一步都是 intent_resolve（不抢意图工具的活）', () => {
    const inputs = ['我爱人生日快到了', '上次那个转账再来一次', '把那边的事接着办', '转500给他']
    for (const text of inputs) {
      const steps = planFromRequest({
        modelId: 'router-chat',
        messages: [{ role: 'user', content: [{ kind: 'text', text }] }],
      } as never)
      expect(steps[0]?.content?.[0]).toMatchObject({ name: 'intent_resolve' })
    }
  })

  it('有转账线索时场景词不劫持（「爱人生日快到了，给张三转520」仍是转账）', () => {
    expect(classifyIntent('爱人生日快到了，给张三转520')).toMatchObject({ kind: 'transfer' })
  })
})

describe('生日案例两幕（04 单）', () => {
  it('"下个月…生日" → birthday/propose；脚本含意图、目标、提案三件套', () => {
    const intent = classifyIntent('我下个月 8 号我爱人生日')
    expect(intent).toMatchObject({ kind: 'birthday', phase: 'propose' })
    const steps = planFor(intent)
    const calls = steps.flatMap((step) =>
      (step.content ?? []).filter((block) => block.kind === 'tool-call').map((block) => block.name),
    )
    expect(calls).toEqual(['intent_resolve', 'goal_set', 'plan_propose'])
  })

  it('主动提醒的「给爱人订生日计划」能落到提案分支（04 单闭环）', () => {
    const intent = classifyIntent('给爱人订生日计划')
    expect(intent).toMatchObject({ kind: 'birthday', phase: 'propose' })
    const calls = planFor(intent).flatMap((step) =>
      (step.content ?? []).filter((block) => block.kind === 'tool-call').map((block) => block.name),
    )
    expect(calls).toEqual(['intent_resolve', 'goal_set', 'plan_propose'])
  })

  it('"确认执行生日计划" → birthday/execute；只发 plan_execute 并带同一张 DAG', () => {
    const intent = classifyIntent('确认执行生日计划')
    expect(intent).toMatchObject({ kind: 'birthday', phase: 'execute' })
    const steps = planFor(intent)
    const calls = steps.flatMap((step) =>
      (step.content ?? []).filter((block) => block.kind === 'tool-call'),
    )
    expect(calls.map((block) => block.name)).toEqual(['plan_execute'])
    const args = calls[0]?.kind === 'tool-call' ? (calls[0].args as { nodes: unknown[] }) : undefined
    expect(args?.nodes).toHaveLength(6)
  })

  it('不带时间锚点的生日说法仍走 03 单 implicit（不与意图平面抢话语）', () => {
    expect(classifyIntent('我爱人生日快到了')).toMatchObject({ kind: 'intent', route: 'implicit' })
  })
})

describe('理财演示路由（04 单：只认两句；缺参追问，不猜）', () => {
  it('理财：列表意图', () => {
    expect(classifyIntent('有什么理财产品')).toMatchObject({ kind: 'wealth', action: 'list' })
  })

  it('理财：买 4 号 1000 元', () => {
    expect(classifyIntent('买 4 号，1000 元')).toMatchObject({
      kind: 'wealth',
      action: 'purchase',
      productNo: 4,
      amount: 1000,
    })
  })

  it('理财：买 4 号 1 万元 → 10000', () => {
    expect(classifyIntent('买 4 号 1 万元')).toMatchObject({ amount: 10_000 })
  })

  it('理财：缺编号 → 追问，不猜', () => {
    expect(classifyIntent('我想买理财')).toMatchObject({ kind: 'clarify' })
  })

  it('理财：编号超出 1–5 → 追问，不猜产品', () => {
    expect(classifyIntent('买 9 号，1000 元')).toMatchObject({ kind: 'clarify' })
  })

  it('不误判：给王建国转 800 元仍是转账', () => {
    expect(classifyIntent('给王建国转 800 元')).toMatchObject({ kind: 'transfer' })
  })

  it('理财先于转账：「转 1 万买理财」不当转账（宾语是产品，不是收款人）', () => {
    expect(classifyIntent('转 1 万买理财').kind).toBe('clarify')
  })

  it('规划：列表 = wealth_list + 复述（不自己编产品）', () => {
    const steps = planFor(classifyIntent('有什么理财产品'))
    expect(steps[0]?.content?.[0]).toMatchObject({ kind: 'tool-call', name: 'wealth_list' })
    expect(steps[1]?.reflect?.tool).toBe('wealth_list')
  })

  it('规划：购买 = wealth_purchase，productId 由编号推导', () => {
    const plan = planFor(classifyIntent('买 4 号，1000 元'))
    const call = plan[0]?.content?.[0] as { kind: string; name?: string; args?: unknown }
    expect(call).toMatchObject({ kind: 'tool-call', name: 'wealth_purchase' })
    expect(call.args).toMatchObject({ productId: 'w-4', amount: 1000 })
    expect(plan[1]?.outcome?.tool).toBe('wealth_purchase')
  })
})

describe('场景 5：订阅 / 代扣路由', () => {
  it('列表话语形态 → sub_list', () => {
    expect(classifyIntent('我有哪些订阅')).toEqual({ kind: 'subscription', action: 'list' })
    expect(classifyIntent('每月固定扣多少钱')).toEqual({ kind: 'subscription', action: 'list' })
    expect(classifyIntent('有没有扣了很久忘了的')).toEqual({ kind: 'subscription', action: 'list' })
  })

  it('退订：识别演示商户 → sub_cancel（默认立即，不确认合约）', () => {
    expect(classifyIntent('视频会员退订')).toEqual({
      kind: 'subscription',
      action: 'cancel',
      subscriptionId: 's-video',
      mode: 'now',
      confirmContract: false,
    })
  })

  it('「确认，到期即断」= 第二幕：视频会员 + 到期即断 + 确认合约', () => {
    expect(classifyIntent('确认，到期即断')).toEqual({
      kind: 'subscription',
      action: 'cancel',
      subscriptionId: 's-video',
      mode: 'at-next-cycle',
      confirmContract: true,
    })
  })

  it('关协议：彻底停掉某商户 → sub_authorize（不是 sub_cancel）', () => {
    expect(classifyIntent('彻底停掉视频会员的扣款')).toEqual({
      kind: 'subscription',
      action: 'authorize',
      merchant: '视频会员',
    })
  })

  it('提醒：抽提前量；「不用了」写 idle 标注', () => {
    expect(classifyIntent('提前三天提醒我续费云音乐')).toEqual({
      kind: 'subscription',
      action: 'watch',
      subscriptionId: 's-music',
      watch: 'remind',
      aheadDays: 3,
    })
    expect(classifyIntent('云存储我不用了')).toEqual({
      kind: 'subscription',
      action: 'watch',
      subscriptionId: 's-storage',
      watch: 'idle',
    })
  })

  it('认不出商户 → 追问，不猜', () => {
    expect(classifyIntent('退订那个会员').kind).toBe('clarify')
    expect(classifyIntent('彻底停掉这家扣款').kind).toBe('clarify')
    expect(classifyIntent('提醒我订阅续费').kind).toBe('clarify')
  })

  it('理财的两个兜底分支仍可达：买 N 号缺金额 / 只提基金按列表', () => {
    expect(classifyIntent('买 4 号')).toMatchObject({ kind: 'clarify' })
    expect(classifyIntent('基金')).toEqual({ kind: 'wealth', action: 'list' })
  })

  it('规划：退订带 confirmContract 只在需要确认时出现', () => {
    const plain = planFor(classifyIntent('视频会员退订'))
    const plainCall = plain[0]?.content?.[0] as { args?: Record<string, unknown> }
    expect(plainCall.args).toEqual({ subscriptionId: 's-video', mode: 'now' })

    const confirmed = planFor(classifyIntent('确认，到期即断'))
    const confirmedCall = confirmed[0]?.content?.[0] as { args?: Record<string, unknown> }
    expect(confirmedCall.args).toEqual({
      subscriptionId: 's-video',
      mode: 'at-next-cycle',
      confirmContract: true,
    })
  })

  it('规划：列表只读；关协议走 sub_authorize', () => {
    const list = planFor(classifyIntent('我有哪些订阅'))
    expect(list[0]?.content?.[0]).toMatchObject({ kind: 'tool-call', name: 'sub_list' })
    const authorize = planFor(classifyIntent('彻底停掉视频会员的扣款'))
    expect(authorize[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'sub_authorize',
      args: { merchant: '视频会员' },
    })
    const watch = planFor(classifyIntent('提醒我续费云音乐'))
    expect(watch[0]?.content?.[0]).toMatchObject({ kind: 'tool-call', name: 'sub_watch' })
    expect(watch[1]?.outcome?.tool).toBe('sub_watch')
  })
})

describe('账单/卡片演示路由（02/04 单）', () => {
  it('账单：本月分析 / 季度按商户 / 报告', () => {
    expect(classifyIntent('分析一下这个月的账单')).toEqual({
      kind: 'bill',
      action: 'analyze',
      period: 'month',
      groupBy: 'category',
    })
    expect(classifyIntent('近三个月的收支按商户分析')).toEqual({
      kind: 'bill',
      action: 'analyze',
      period: 'quarter',
      groupBy: 'merchant',
    })
    expect(classifyIntent('出一份本月账单报告')).toEqual({
      kind: 'bill',
      action: 'report',
      period: 'month',
      format: 'summary',
    })
  })

  /**
   * 历史账期（2026-11-01 补）：这三条以前全是"追问"，等于对着用户说"查不了"。
   * 现在路由只翻成相对参数，日期由工具用注入钟算——路由没有时钟，算日期回放就错。
   */
  it('账单：上个月 / 指定月份 / 指定年份 都能落到账期锚点', () => {
    expect(classifyIntent('上个月的账单')).toMatchObject({
      kind: 'bill',
      action: 'analyze',
      period: 'month',
      monthOffset: -1,
    })
    expect(classifyIntent('看一下 9 月账单')).toMatchObject({
      kind: 'bill',
      period: 'month',
      monthOfYear: 9,
    })
    expect(classifyIntent('2025 年花了多少')).toMatchObject({
      kind: 'bill',
      action: 'analyze',
      period: 'year',
      year: '2025',
    })
    expect(classifyIntent('去年的年度账单报告')).toMatchObject({
      kind: 'bill',
      action: 'report',
      period: 'year',
      monthOffset: -12,
    })
  })

  it('卡片：冻结/解冻/挂失/列表；缺卡号追问，不默认操作', () => {
    expect(classifyIntent('冻结尾号 1234 的银行卡')).toEqual({
      kind: 'card',
      action: 'freeze',
      cardId: 'c-1',
    })
    expect(classifyIntent('解冻尾号 1234 的卡')).toEqual({
      kind: 'card',
      action: 'unfreeze',
      cardId: 'c-1',
    })
    expect(classifyIntent('挂失尾号 5678 的银行卡')).toEqual({
      kind: 'card',
      action: 'reportLost',
      cardId: 'c-2',
    })
    expect(classifyIntent('我的银行卡状态')).toEqual({ kind: 'card', action: 'list' })
    expect(classifyIntent('冻结银行卡')).toMatchObject({ kind: 'clarify' })
  })

  it('规划：账单走 bill_*，卡片走 card_* / account_list', () => {
    const bill = planFor(classifyIntent('分析一下这个月的账单'))
    expect(bill[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'bill_analyze',
      args: { period: 'month', groupBy: 'category' },
    })
    const report = planFor(classifyIntent('出一份本月账单报告'))
    expect(report[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'bill_report',
      args: { period: 'month', format: 'summary' },
    })
    const freeze = planFor(classifyIntent('冻结尾号 1234 的银行卡'))
    expect(freeze[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'card_freeze',
      args: { cardId: 'c-1' },
    })
    expect(freeze[1]?.outcome?.tool).toBe('card_freeze')
    const lost = planFor(classifyIntent('挂失尾号 5678 的银行卡'))
    expect(lost[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'card_report_lost',
      args: { cardId: 'c-2' },
    })
    const list = planFor(classifyIntent('我的银行卡状态'))
    expect(list[0]?.content?.[0]).toMatchObject({ kind: 'tool-call', name: 'account_list' })
  })

  it('不误判：转账不被账单/卡片路由劫持', () => {
    expect(classifyIntent('给王建国转 800 元').kind).toBe('transfer')
  })
})

describe('官方子能力补齐：理财/卡/AA 路由', () => {
  it('理财：持仓与赎回', () => {
    expect(classifyIntent('我买了什么理财，持仓收益多少')).toEqual({
      kind: 'wealth',
      action: 'positions',
    })
    expect(classifyIntent('赎回我的理财')).toEqual({
      kind: 'wealth',
      action: 'redeem',
      holdingId: 'h-1',
    })
  })

  it('卡片：申请 / 调额 / 交易限制（set/clear）', () => {
    expect(classifyIntent('办一张虚拟卡')).toEqual({ kind: 'card', action: 'apply' })
    expect(classifyIntent('把尾号 1234 的卡日限额调到 500 元')).toEqual({
      kind: 'card',
      action: 'setLimit',
      cardId: 'c-1',
      dailyLimitYuan: 500,
    })
    expect(classifyIntent('关掉尾号 1234 的线上支付')).toEqual({
      kind: 'card',
      action: 'restrict',
      cardId: 'c-1',
      mode: 'set',
      restrictionKind: 'online',
    })
    expect(classifyIntent('恢复尾号 1234 的线上支付')).toEqual({
      kind: 'card',
      action: 'restrict',
      cardId: 'c-1',
      mode: 'clear',
      restrictionKind: 'online',
    })
    expect(classifyIntent('把尾号 5678 的卡境外支付关掉')).toMatchObject({
      kind: 'card',
      action: 'restrict',
      cardId: 'c-2',
      restrictionKind: 'overseas',
    })
    expect(classifyIntent('关掉尾号 1234 的餐饮消费')).toEqual({
      kind: 'card',
      action: 'restrict',
      cardId: 'c-1',
      mode: 'set',
      restrictionKind: 'category',
      restrictionValue: 'dining',
    })
    expect(classifyIntent('恢复尾号 1234 的咖啡消费')).toMatchObject({
      kind: 'card',
      action: 'restrict',
      cardId: 'c-1',
      mode: 'clear',
      restrictionKind: 'category',
      restrictionValue: 'coffee',
    })
  })

  it('信用卡（ADR-0015）：办卡带授信额度、调额投 creditLimitYuan、尾号 2468 指向 c-3', () => {
    expect(classifyIntent('办一张 5000 额度的信用卡')).toEqual({
      kind: 'card',
      action: 'apply',
      cardKind: 'credit',
      creditLimitYuan: 5000,
    })
    // 额度未知的信用卡在工具面开不出来，路由追问而不是猜一个数
    expect(classifyIntent('办一张信用卡')).toMatchObject({ kind: 'clarify' })

    expect(classifyIntent('把尾号 2468 的信用卡额度调到 3000')).toEqual({
      kind: 'card',
      action: 'setLimit',
      cardId: 'c-3',
      creditLimitYuan: 3000,
    })
    // 零回归：没说"信用"的额度仍然投交易日限额
    expect(classifyIntent('把尾号 1234 的卡额度调到 800')).toEqual({
      kind: 'card',
      action: 'setLimit',
      cardId: 'c-1',
      dailyLimitYuan: 800,
    })

    expect(planFor(classifyIntent('办一张 5000 额度的信用卡'))[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'card_apply',
      args: { kind: 'credit', creditLimitYuan: 5000 },
    })
    expect(
      planFor(classifyIntent('把尾号 2468 的信用卡额度调到 3000'))[0]?.content?.[0],
    ).toMatchObject({
      kind: 'tool-call',
      name: 'card_limit_set',
      args: { cardId: 'c-3', creditLimitYuan: 3000 },
    })
  })

  it('AA：参与人必须显式给出，缺了就追问', () => {
    expect(classifyIntent('张三、李四、王五 AA 300')).toEqual({
      kind: 'aa',
      totalYuan: 300,
      participants: ['张三', '李四', '王五'],
    })
    expect(classifyIntent('我们三个人 AA 300')).toMatchObject({ kind: 'clarify' })
    // 组织者"我"也是参与人：「块，三个人」不能抢先被当成名单
    expect(classifyIntent('我们 AA 300 块，三个人：我、张伟、王建国')).toEqual({
      kind: 'aa',
      totalYuan: 300,
      participants: ['我', '张伟', '王建国'],
    })
  })

  it('规划：新能力的工具名与参数', () => {
    expect(planFor(classifyIntent('我买了什么理财，持仓收益多少'))[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'wealth_positions',
    })
    expect(planFor(classifyIntent('赎回我的理财'))[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'wealth_redeem',
      args: { holdingId: 'h-1' },
    })
    expect(planFor(classifyIntent('办一张虚拟卡'))[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'card_apply',
    })
    expect(
      planFor(classifyIntent('把尾号 1234 的卡日限额调到 500 元'))[0]?.content?.[0],
    ).toMatchObject({
      kind: 'tool-call',
      name: 'card_limit_set',
      args: { cardId: 'c-1', dailyLimitYuan: 500 },
    })
    expect(
      planFor(classifyIntent('关掉尾号 1234 的线上支付'))[0]?.content?.[0],
    ).toMatchObject({
      kind: 'tool-call',
      name: 'card_restriction',
      args: { cardId: 'c-1', mode: 'set', kind: 'online' },
    })
    expect(
      planFor(classifyIntent('关掉尾号 1234 的餐饮消费'))[0]?.content?.[0],
    ).toMatchObject({
      kind: 'tool-call',
      name: 'card_restriction',
      args: { cardId: 'c-1', mode: 'set', kind: 'category', value: 'dining' },
    })
    expect(planFor(classifyIntent('张三、李四、王五 AA 300'))[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'aa_create',
      args: {
        title: 'AA 收款',
        totalYuan: 300,
        participants: [{ name: '张三' }, { name: '李四' }, { name: '王五' }],
      },
    })
  })
})

describe('AA 模拟代收（场景 1 子能力）：完成态才认', () => {
  it('「X 已经付了 / 把钱给我了 / 到账了」→ aa-collect，人名取自句子', () => {
    expect(classifyIntent('张三已经付了')).toEqual({ kind: 'aa-collect', participant: '张三' })
    expect(classifyIntent('李四把钱给我了')).toMatchObject({ kind: 'aa-collect', participant: '李四' })
    expect(classifyIntent('王五到账了')).toMatchObject({ kind: 'aa-collect', participant: '王五' })
  })

  it('未完成说法不能被当成到账（那是转账 / 建组）', () => {
    expect(classifyIntent('给张建国转 800 元').kind).not.toBe('aa-collect')
    expect(classifyIntent('张三、李四、王五 AA 300').kind).toBe('aa')
  })

  it('规划：一次 aa_create(action=collect)，组号取演示约定', () => {
    expect(planFor(classifyIntent('张三已经付了'))[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'aa_create',
      args: { action: 'collect', groupId: 'aa-new-1', participant: '张三' },
    })
  })
})

describe('AA 参与人拒绝（ADR-0017）：否定态才认', () => {
  it('「X 不参加 / 说不去了」→ aa-decline，人名不含"说"', () => {
    expect(classifyIntent('王建国不参加')).toEqual({ kind: 'aa-decline', participant: '王建国' })
    expect(classifyIntent('李四说不去了')).toEqual({ kind: 'aa-decline', participant: '李四' })
  })

  it('「还没付」不是拒绝：不能替参与人表态', () => {
    expect(classifyIntent('王建国还没付').kind).not.toBe('aa-decline')
  })

  it('规划：一次 aa_create(action=decline)，组号取演示约定', () => {
    expect(planFor(classifyIntent('王建国不参加'))[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'aa_create',
      args: { action: 'decline', groupId: 'aa-new-1', participant: '王建国' },
    })
  })
})

describe('AA 查组状态（05 单 §6）：查看不是新建', () => {
  it('「查组状态 / 查一下 AA 状态 / 收款进度」→ aa-status', () => {
    expect(classifyIntent('查组状态')).toEqual({ kind: 'aa-status' })
    expect(classifyIntent('查一下AA状态')).toEqual({ kind: 'aa-status' })
    expect(classifyIntent('AA 收款进度怎么样了')).toEqual({ kind: 'aa-status' })
  })

  it('规划：一次 aa_create(status)，收尾复述工具结果（paid/declined/pending 在正文里）', () => {
    const steps = planFor(classifyIntent('查一下AA状态'))
    expect(steps[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'aa_create',
      args: { action: 'status', groupId: 'aa-new-1' },
    })
    expect(steps[1]?.reflect?.tool).toBe('aa_create')
    expect(steps[1]?.reflect?.fallback).toContain('没有查到 AA 组状态')
  })

  it('动作说法不被当成状态：张三付了仍是 collect', () => {
    expect(classifyIntent('张三已经付了')).toMatchObject({ kind: 'aa-collect' })
  })
})

describe('风险测评路由（C-03）：只发卷 / 只搬运用户答案', () => {
  it('「测评 / 风险问卷 / 我的风险等级」→ risk_assess(action=questions)', () => {
    for (const text of ['我要做风险测评', '给我一份风险问卷', '我的风险等级是什么', '我 risk 等级该更新了']) {
      const intent = classifyIntent(text)
      expect(intent.kind, text).toBe('risk')
      if (intent.kind !== 'risk') throw new Error('unreachable')
      expect(intent.action).toBe('questions')
      expect(planFor(intent)[0]?.content?.[0]).toMatchObject({
        kind: 'tool-call',
        name: 'risk_assess',
        args: { action: 'questions' },
      })
    }
  })

  it('「风险测评作答 …」→ submit，答案逐条来自用户消息（路由不生成答案）', () => {
    const intent = classifyIntent(
      '风险测评作答 rq-3 1=conservative 2=middle 3=aggressive 4=middle 5=conservative',
    )
    expect(intent).toMatchObject({
      kind: 'risk',
      action: 'submit',
      questionnaireId: 'rq-3',
      answers: [
        { index: 1, key: 'conservative' },
        { index: 2, key: 'middle' },
        { index: 3, key: 'aggressive' },
        { index: 4, key: 'middle' },
        { index: 5, key: 'conservative' },
      ],
    })
    expect(planFor(intent)[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'risk_assess',
      args: { action: 'submit', questionnaireId: 'rq-3' },
    })
  })

  it('只写作答但没有问卷 ID / 没有答案 → 不硬当 submit（退回追问）', () => {
    expect(classifyIntent('风险测评作答').kind).toBe('risk')
    expect(classifyIntent('风险测评作答 rq-3').kind).toBe('risk')
    // 没有 rq id 的"作答"不是提交：因为没有 ID 就落不了档，路由不该假装能提交
    expect(classifyIntent('作答 1=middle 2=middle').kind).toBe('clarify')
  })

  it('「理财产品风险等级」仍归理财（产品等级不是客户等级）', () => {
    expect(classifyIntent('这个理财产品风险等级多少').kind).toBe('wealth')
  })
})

describe('追问候选的续接：点选后接回上一轮', () => {
  function askCall(callId: string, slot: string): LlmMessage {
    return {
      role: 'assistant',
      content: [
        {
          kind: 'tool-call',
          id: callId,
          name: 'prompt_ask',
          args: { question: '要转给谁？请给出收款人姓名。', slot, candidates: [] },
        },
      ],
    }
  }

  function askResult(callId: string, labels: readonly string[]): LlmMessage {
    return {
      role: 'tool',
      toolCallId: callId,
      name: 'prompt_ask',
      content: [
        {
          kind: 'text',
          text: JSON.stringify({
            question: '要转给谁？请给出收款人姓名。',
            choices: [
              ...labels.map((label) => ({ label, value: label, kind: 'candidate' })),
              { label: '手动输入', value: '__manual__', kind: 'manual' },
            ],
            allowFreeText: true,
            degraded: false,
            askExhausted: false,
          }),
        },
      ],
    }
  }

  function request(messages: readonly LlmMessage[]): LlmRequest {
    return { modelId: 'router-chat', messages }
  }

  function afterAsk(previous: string, answer = '王建国'): readonly LlmMessage[] {
    return [user(previous), askCall('call-ask', 'payee'), askResult('call-ask', ['王建国', '张伟']), assistant(), user(answer)]
  }

  it('金额取上一轮原话、收款人取点选值 → 直接进转账预览', () => {
    const steps = planFromRequest(request(afterAsk('转 500 给他')))
    expect(steps[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'transfer_preview',
      args: { amount: 500, payee: { name: '王建国' } },
    })
  })

  it('上一轮没给金额 → 接着问金额，而不是回能力清单', () => {
    const steps = planFromRequest(request(afterAsk('转点钱给他')))
    expect(steps[0]?.content?.[0]).toMatchObject({
      kind: 'text',
      text: '给王建国转多少？请给出金额。',
    })
  })

  it('不是候选值的短句不硬当收款人', () => {
    const steps = planFromRequest(request(afterAsk('转 500 给他', '算了')))
    expect(steps[0]?.content?.[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('我现在能办') })
  })

  it('追问之后用户又说过话 → 旧候选过期，按普通消息处理', () => {
    const messages = [...afterAsk('转 500 给他', '先查下余额'), assistant(), user('王建国')]
    const steps = planFromRequest(request(messages))
    expect(steps[0]?.content?.[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('我现在能办') })
  })

  it('非收款人槽位的候选不续接', () => {
    const messages = [
      user('转 500 给他'),
      askCall('call-ask', 'amountCents'),
      askResult('call-ask', ['500', '800']),
      assistant(),
      user('500'),
    ]
    const steps = planFromRequest(request(messages))
    expect(steps[0]?.content?.[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('我现在能办') })
  })

  it('追问结果不是合法 JSON → 不续接', () => {
    const messages = [
      user('转 500 给他'),
      askCall('call-ask', 'payee'),
      {
        role: 'tool',
        toolCallId: 'call-ask',
        name: 'prompt_ask',
        content: [{ kind: 'text', text: 'not-json' }],
      } satisfies LlmMessage,
      assistant(),
      user('王建国'),
    ]
    const steps = planFromRequest(request(messages))
    expect(steps[0]?.content?.[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('我现在能办') })
  })

  it('找不到 prompt_ask 的调用参数 → 不续接', () => {
    const messages = [user('转 500 给他'), askResult('orphan', ['王建国']), assistant(), user('王建国')]
    const steps = planFromRequest(request(messages))
    expect(steps[0]?.content?.[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('我现在能办') })
  })

  it('没有上一轮用户原话 → 仍接着问金额', () => {
    const messages = [askCall('call-ask', 'payee'), askResult('call-ask', ['王建国']), assistant(), user('王建国')]
    const steps = planFromRequest(request(messages))
    expect(steps[0]?.content?.[0]).toMatchObject({
      kind: 'text',
      text: '给王建国转多少？请给出金额。',
    })
  })

  it('callPrefix 给本轮所有工具调用加唯一前缀', () => {
    const steps = planFromRequest(request([user('给王建国转 800 元')]), 'call-7')
    expect(steps[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      id: 'call-7:call-preview',
      name: 'transfer_preview',
    })
    expect(steps[1]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      id: 'call-7:call-create',
      name: 'transfer_create',
    })
  })
})

/**
 * 定时转账（2026-11-01）：含时点的话**绝不能**走立即转账。
 *
 * 这一组的失效模式不是"少个功能"，而是"当场划走本不该动的钱"：
 * 用户说明天转，系统发起今天到期的审批卡，用户照习惯点确认就扣款了。
 */
describe('定时转账：含时点不降级为立即转账', () => {
  const TOOL_NAMES = (text: string): readonly string[] =>
    planFor(classifyIntent(text))
      .map((step) => step.content?.[0])
      .filter((content) => content?.kind === 'tool-call')
      .map((content) => (content as { readonly name: string }).name)

  it('白名单时点原样进 when（明天 / 下周一 / 下个月 8 号 / 3 月 8 号）', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['明天给王建国转 200 元', '明天'],
      ['下周一给王建国转 200 元', '下周一'],
      ['下个月 8 号给王建国转 200 元', '下个月 8 号'],
      ['3 月 8 号给王建国转 200 元', '3 月 8 号'],
    ]
    for (const [text, when] of cases) {
      const intent = classifyIntent(text)
      expect(intent.kind, text).toBe('transfer')
      if (intent.kind !== 'transfer') return
      expect(intent.request.when, text).toBe(when)
      // 金额只认 200：日期里的 3/8/20 都不是金额
      expect(intent.request.amount, text).toBe(200)
    }
  })

  it('只发 transfer_schedule，不补 transfer_create', () => {
    expect(TOOL_NAMES('明天给王建国转 200 元')).toEqual(['transfer_schedule'])
  })

  it('时点格式不可解析 → 追问，不猜时刻、不按现在转', () => {
    for (const text of [
      '明天下午三点给王建国转 200 元',
      '这个月 20 号给王建国转 200',
      '每月 1 号给王建国转 200',
    ]) {
      expect(classifyIntent(text).kind, text).toBe('clarify')
    }
  })

  it('无时点的普通转账仍是预览 → 执行两步', () => {
    expect(TOOL_NAMES('给王建国转 200 元')).toEqual(['transfer_preview', 'transfer_create'])
  })
})

/**
 * 资金锁定（2026-11-01）：场景 6 原文"当月锁定 1000 元活期"。
 *
 * 关键区分：锁定不是给谁付钱，不能走 transfer_create（会占转账日限额、还可能升红），
 * 也不能被卡片"冻结"抢走（那改的是卡状态，不是余额可用性）。
 */
describe('资金锁定：锁定 / 释放 / 查询', () => {
  it('锁定 1000 元活期 → fund_lock(lock, 1000)', () => {
    const intent = classifyIntent('帮我把 1000 元活期锁定')
    expect(intent).toMatchObject({ kind: 'fundLock', action: 'lock', amountYuan: 1000 })
    expect(planFor(intent)[0]?.content?.[0]).toMatchObject({ kind: 'tool-call', name: 'fund_lock' })
  })

  it('解除锁定 → release；查锁定额 → status（不需要金额）', () => {
    expect(classifyIntent('解除锁定 500 元')).toMatchObject({
      kind: 'fundLock',
      action: 'release',
      amountYuan: 500,
    })
    expect(classifyIntent('我现在锁了多少钱')).toMatchObject({ kind: 'fundLock', action: 'status' })
  })

  it('说锁定但没给金额 → 追问，不默认 1000', () => {
    expect(classifyIntent('帮我把这笔钱锁定').kind).toBe('clarify')
  })
})

/**
 * 交易密码（01 单 / ADR-0014）。
 *
 * 这条判据的价值不在"认得出改密"，而在**认得出也不带密码**：
 * 用户在消息里打了密码，路由的 args 里仍然只有 `{ action }`。
 */
describe('交易密码：发起交办 / 查状态（密码不进对话）', () => {
  it('「改交易密码」→ password_change(request)，args 里没有密码字段', () => {
    const intent = classifyIntent('我要改交易密码')
    expect(intent).toMatchObject({ kind: 'password', action: 'request' })
    const step = planFor(intent)[0]
    expect(step?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'password_change',
      args: { action: 'request' },
    })
    const shown = JSON.stringify(step)
    expect(shown).not.toContain('oldPassword')
    expect(shown).not.toContain('newPassword')

    // 成功话术引用工具正文：交接页地址与票据号只存在于 tool/result 里（复审 P0-2）
    const closing = planFor(intent)[1]
    expect(closing?.outcome).toMatchObject({
      tool: 'password_change',
      okFromResult: true,
    })
    expect(closing?.outcome?.ok).not.toContain('/secure/password')
  })

  it('「密码还能试几次 / 什么时候改的」→ status；「改登录密码」→ 追问', () => {
    expect(classifyIntent('交易密码还能试几次')).toMatchObject({
      kind: 'password',
      action: 'status',
    })
    expect(classifyIntent('我上次什么时候改的交易密码')).toMatchObject({
      kind: 'password',
      action: 'status',
    })
    expect(classifyIntent('我要改登录密码').kind).toBe('clarify')
  })
})

/**
 * 记住生日（04 单手工验收）：话术必须真的落到 `fact_remember`。
 *
 * 这条以前是闭环缺口：扫描器与快照都在，但演示里没有任何路径把生日写进事实库。
 */
describe('记住生日：话术 → fact_remember（04 单）', () => {
  it('「记住我爱人生日 3 月 8 日」→ spouse/birthday/2000-03-08', () => {
    const intent = classifyIntent('记住我爱人生日 3 月 8 日')
    expect(intent).toEqual({
      kind: 'factRemember',
      person: '爱人',
      relation: 'spouse',
      date: '2000-03-08',
    })

    const steps = planFor(intent)
    expect(steps[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'fact_remember',
      args: {
        person: '爱人',
        relation: 'spouse',
        kind: 'birthday',
        date: '2000-03-08',
        confirmed: true,
      },
    })
    expect(steps[1]?.outcome?.tool).toBe('fact_remember')
  })

  it('「记住我的生日是 3 月 8 日」→ self；称谓抽不出 / 日期不存在 → 追问', () => {
    expect(classifyIntent('记住我的生日是 3 月 8 日')).toMatchObject({
      kind: 'factRemember',
      person: '我',
      relation: 'self',
      date: '2000-03-08',
    })
    expect(classifyIntent('记住王建国生日 3 月 8 日')).toMatchObject({
      kind: 'factRemember',
      person: '王建国',
      relation: 'other',
      date: '2000-03-08',
    })
    expect(classifyIntent('记住我爱人生日').kind).toBe('clarify')
    expect(classifyIntent('记住我爱人生日 2 月 30 日').kind).toBe('clarify')
    expect(classifyIntent('记住生日 3 月 8 日').kind).toBe('clarify')
  })

  it('不带「记住」的生日陈述仍走原分支（不抢 03/04 的话术）', () => {
    expect(classifyIntent('我爱人生日快到了')).toMatchObject({ kind: 'intent', route: 'implicit' })
    expect(classifyIntent('给爱人订生日计划')).toMatchObject({ kind: 'birthday', phase: 'propose' })
  })
})

/**
 * 商户订购（2026-11-01 开放）：先搜后订。
 *
 * 之前这条意图只能得到一句"我能办：① 查余额…"的追问——用户想订花，系统答非所问。
 * 现在路由只发 `merchant_search`（带预算），下单要靠 `merchant_order`（offerId 或品类）。
 */
describe('商户订购：订花 / 蛋糕', () => {
  it('订一束 200 元的花 → merchant_search(flower, 200)', () => {
    const intent = classifyIntent('帮我订一束 200 元的花')
    expect(intent).toMatchObject({
      kind: 'merchant',
      action: 'search',
      category: 'flower',
      budgetYuan: 200,
    })
    expect(planFor(intent)[0]?.content?.[0]).toMatchObject({
      kind: 'tool-call',
      name: 'merchant_search',
    })
  })

  it('「就订」才进 order，否则一律先搜（不让用户接受没见过的价）', () => {
    // `DemoIntent` 是封闭联合，`action` 只存在于 merchant 分支：先窄化再读字段，
    // 直接把联合当 any 读会掩盖"路由改成了别的意图"这种真回归。
    expect(merchantIntentOf('订个蛋糕，就订了').action).toBe('order')
    expect(merchantIntentOf('看看有什么蛋糕').action).toBe('search')
  })
})

/** 取 merchant 分支（类型窄化；不是商户意图就让用例失败，而不是静默读 `undefined`）。 */
function merchantIntentOf(text: string): { readonly action: 'search' | 'order' } {
  const intent = classifyIntent(text)
  if (intent.kind !== 'merchant') throw new BahError('test-intent', `不是商户意图：${intent.kind}`, { text })
  return intent
}
