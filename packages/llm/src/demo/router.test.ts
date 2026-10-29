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

import type { LlmMessage } from '../llm/types.ts'

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
