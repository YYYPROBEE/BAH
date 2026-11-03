/**
 * 金额 / 合规文本 / 格式化的用例（T-WEB-005 的纯函数面）。
 *
 * 这些函数是"幻觉防护 UI 侧"的全部逻辑：它们错了，界面上就会凭空出现一个金额。
 */

import { describe, expect, it } from 'vitest'

import {
  amountFromArgs,
  extractDisclaimer,
  maskedPayeePhoneFromArgs,
  maskPhone,
  payeeFromArgs,
} from './amount.ts'
import { buildCard } from './cards.ts'
import { formatCents, shortId, timeText, yuanToCents } from './format.ts'

describe('金额提取', () => {
  it('元参数换算成分；分参数原样保留（口径来自）', () => {
    expect(amountFromArgs({ amount: 800 })).toBe(80_000)
    expect(amountFromArgs({ amount: 0.01 })).toBe(1)
    expect(amountFromArgs({ amountCents: 12_345 })).toBe(12_345)
    expect(amountFromArgs({ minAmountCents: 100_000 })).toBe(100_000)
  })

  it('非法金额返回 undefined（不猜 0、不猜正数）', () => {
    expect(amountFromArgs({})).toBeUndefined()
    expect(amountFromArgs({ amount: 0 })).toBeUndefined()
    expect(amountFromArgs({ amount: -1 })).toBeUndefined()
    expect(amountFromArgs({ amount: '800' })).toBeUndefined()
    expect(amountFromArgs(undefined)).toBeUndefined()
    expect(amountFromArgs([])).toBeUndefined()
  })

  it('收款人只认 payee.name', () => {
    expect(payeeFromArgs({ payee: { name: '王建国' } })).toBe('王建国')
    expect(payeeFromArgs({ payee: { name: '  ' } })).toBeUndefined()
    expect(payeeFromArgs({ payee: '王建国' })).toBeUndefined()
    expect(payeeFromArgs({})).toBeUndefined()
  })

  it('收款人手机只从 payee.phone 取，且返回时已脱敏', () => {
    expect(maskedPayeePhoneFromArgs({ payee: { phone: '13900002222' } })).toBe('139****2222')
    expect(maskedPayeePhoneFromArgs({ payee: { phone: ' 13900002222 ' } })).toBe('139****2222')
    expect(maskedPayeePhoneFromArgs({ payee: { phone: '' } })).toBeUndefined()
    expect(maskedPayeePhoneFromArgs({ payee: { phone: 139_0000_2222 } })).toBeUndefined()
    expect(maskedPayeePhoneFromArgs({ phone: '13900002222' })).toBeUndefined()
  })

  it('短号码整段遮掉（不猜"保留几位才安全"）', () => {
    expect(maskPhone('123456')).toBe('****')
    expect(maskPhone('1234567')).toBe('123****4567')
  })
})

describe('格式化', () => {
  it('分 → ¥1,234.56（无 locale 依赖）', () => {
    expect(formatCents(123_456)).toBe('¥1,234.56')
    expect(formatCents(0)).toBe('¥0.00')
    expect(formatCents(1)).toBe('¥0.01')
    expect(formatCents(-100)).toBe('-¥1.00')
    expect(formatCents(123_456_789)).toBe('¥1,234,567.89')
  })

  it('元 → 分四舍五入', () => {
    expect(yuanToCents(1.005)).toBe(101)
    expect(yuanToCents(0)).toBeUndefined()
  })

  it('时间固定 UTC（跨时区渲染必须逐字一致）', () => {
    expect(timeText(Date.UTC(2026, 9, 20, 1, 2, 3))).toBe('01:02:03')
  })

  it('短码只保留末段', () => {
    expect(shortId('ticket:call-1')).toBe('call-1')
    expect(shortId('abcdefghij', 4)).toBe('…ghij')
  })
})

describe('风险提示提取（理财合规）', () => {
  it('从正文抽出 disclaimerId 与整句', () => {
    const text =
      '共 1 个产品：\n- 稳盈90天（W-1）：R2\n风险提示：wealth.disclaimer.v1（必须向用户展示，理财非存款、投资有风险）'
    const found = extractDisclaimer(text)
    expect(found?.id).toBe('wealth.disclaimer.v1')
    expect(found?.text).toContain('必须向用户展示')
  })

  it('没有风险提示时不编造', () => {
    expect(extractDisclaimer('已转账 ¥800.00 给王建国')).toBeUndefined()
  })
})

describe('卡片构造', () => {
  it('金额字段被标记为 amount（视图据此降级）', () => {
    const card = buildCard({
      name: 'transfer_create',
      args: { amount: 800, payee: { name: '王建国' } },
      content: [{ type: 'text', text: '已转账' }],
      isError: false,
      amountConfirmed: true,
    })
    expect(card.template).toBe('transfer')
    expect(card.title).toBe('转账')
    expect(card.fields.find((field) => field.amount)?.value).toBe('¥800.00')
    expect(card.fields.find((field) => field.label === '收款人')?.value).toBe('王建国')
  })

  it('工具名未登记时退回工具名本身（不猜语义）', () => {
    const card = buildCard({
      name: 'mystery_tool',
      args: {},
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      amountConfirmed: true,
    })
    expect(card.title).toBe('mystery_tool')
    expect(card.template).toBe('generic')
  })

  it('失败卡片带"未执行"与理由码', () => {
    const card = buildCard({
      name: 'transfer_create',
      args: { amount: 800 },
      content: [{ type: 'text', text: '危险指令' }],
      code: 'PRV-002',
      isError: true,
      amountConfirmed: false,
    })
    expect(card.tags.map((tag) => tag.text)).toContain('未执行')
    expect(card.code).toBe('PRV-002')
  })

  it('图片块只留摘要（不把 base64 塞进 DOM）', () => {
    const card = buildCard({
      name: 'analysis_calc',
      args: {},
      content: [{ type: 'image', mimeType: 'image/png' }],
      isError: false,
      amountConfirmed: true,
    })
    expect(card.body).toContain('[图片 image/png]')
  })

  it('未知内容块不被静默丢弃（留"非文本内容"这一事实）', () => {
    const card = buildCard({
      name: 'analysis_calc',
      args: {},
      content: [{ type: 'audio' }],
      isError: false,
      amountConfirmed: true,
    })
    expect(card.body).toBe('[非文本内容]')
  })

  it('知识卡必须带「知识校验」徽标与 knowledge 模板（合规标识不能只留在正文里）', () => {
    const card = buildCard({
      name: 'knowledge_answer',
      args: {},
      content: [{ type: 'text', text: '年费按卡等级收取' }],
      isError: false,
      amountConfirmed: true,
    })

    expect(card.template).toBe('knowledge')
    expect(card.title).toBe('知识问答')
    expect(card.tags.map((tag) => tag.text)).toContain('知识校验')
  })

  it('订阅卡片的「即将扣款」没有明细时不出空表，但摘要与依据行仍要在', () => {
    const card = buildCard({
      name: 'sub_list',
      args: {},
      content: [{ type: 'text', text: '共 0 项订阅' }],
      isError: false,
      amountConfirmed: true,
      upcoming: {
        summary: '7 天内没有即将扣款',
        headers: ['即将扣款', '金额', '扣款日'],
        rows: [],
        basisNote: '基于近 30 天 42 笔流水 · 生成于 2023-11-14',
      },
    })

    expect(card.template).toBe('ledger')
    expect(card.fields.find((field) => field.label === '即将扣款')?.value).toBe('7 天内没有即将扣款')
    expect(card.table).toBeUndefined()
    expect(card.note).toBe('基于近 30 天 42 笔流水 · 生成于 2023-11-14')
  })
})
