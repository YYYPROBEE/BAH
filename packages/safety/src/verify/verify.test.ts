/**
 * W05 断言核验门 · 纯函数面（抽取 / 归一化 / 三态路由）。
 *
 * TC-W05-01~06 在本文件；07~10（宿主装配与出站文本）在
 * `packages/host/src/boot/plugins/verify.test.ts`。
 */

import { describe, expect, it } from 'vitest'

import {
  ASSERTION_REJECT_CODE,
  UNVERIFIED_PREFIX,
  chineseToDecimal,
  collectEvidence,
  extractAssertions,
  moneyToCents,
  rateToBasisPoints,
  refusalText,
  verifyReply,
} from './index.ts'

describe('W05 · 归一化（防绕过）', () => {
  it('TC-W05-04 “八百元 / 800.00 元 / ¥800 / 800块”归一化到同一个值', () => {
    const inputs = ['余额 八百元', '余额 800.00 元', '余额 ¥800', '余额 800块']
    const values = inputs.map((text) => {
      const [first] = extractAssertions(text)
      return first?.value
    })
    expect(values).toEqual(['80000', '80000', '80000', '80000'])
  })

  it('TC-W05-05 千分位 “1,200.00” 与 “1200.00” 判定一致', () => {
    const comma = extractAssertions('余额 1,200.00 元')[0]
    const plain = extractAssertions('余额 1200.00 元')[0]
    expect(comma?.value).toBe('120000')
    expect(plain?.value).toBe('120000')

    const evidence = ['账户余额 ¥1,200.00，可用 ¥1,200.00。']
    expect(verifyReply({ text: '余额 1,200.00 元', evidence }).decision).toBe('pass')
    expect(verifyReply({ text: '余额 1200.00 元', evidence }).decision).toBe('pass')
    expect(verifyReply({ text: '余额 1200 元', evidence }).decision).toBe('pass')
  })

  it('中文数字与数量级：十万 / 一千二百 / 1.2万 / 三点五', () => {
    expect(chineseToDecimal('八百')).toBe('800')
    expect(chineseToDecimal('十万')).toBe('100000')
    expect(chineseToDecimal('一千二百')).toBe('1200')
    expect(chineseToDecimal('一千二百三十四')).toBe('1234')
    expect(chineseToDecimal('一百零五')).toBe('105')
    expect(chineseToDecimal('三点五')).toBe('3.5')
    expect(moneyToCents('1.2', '万')).toBe(1_200_000)
    expect(moneyToCents('十万')).toBe(10_000_000)
    expect(rateToBasisPoints('0.3', 'percent')).toBe(30)
    expect(rateToBasisPoints('三', 'permille')).toBe(30)
  })

  it('口语省略写法拒绝解析（一百五 ≠ 105：宁可漏判也不误判）', () => {
    expect(chineseToDecimal('一百五')).toBeUndefined()
    expect(chineseToDecimal('两千五')).toBeUndefined()
    expect(chineseToDecimal('三万五')).toBeUndefined()
    expect(chineseToDecimal('一千二百三')).toBeUndefined()
  })
})

describe('W05 · 三态路由', () => {
  it('TC-W05-01 工具返回余额 ¥800.00，回复写“余额 800 元” → verified，不拦截', () => {
    const outcome = verifyReply({
      text: '余额 800 元。',
      evidence: ['账户尾号 1234：余额 ¥800.00，可用 ¥800.00，冻结 ¥0.00。'],
    })
    expect(outcome.verified).toBe(1)
    expect(outcome.needsEvidence).toBe(0)
    expect(outcome.rejected).toBe(0)
    expect(outcome.decision).toBe('pass')
    expect(outcome.text).toBe('余额 800 元。')
  })

  it('TC-W05-02 无任何工具证据，回复写“余额 5000 元” → needs-evidence（加前缀后发出）', () => {
    const outcome = verifyReply({ text: '你的余额 5000 元。', evidence: [] })
    expect(outcome.needsEvidence).toBe(1)
    expect(outcome.decision).toBe('annotate')
    expect(outcome.text.startsWith(UNVERIFIED_PREFIX)).toBe(true)
    expect(outcome.text).toContain('余额 5000 元')
  })

  it('TC-W05-03 “余额充足，已为你转出 800 元”但本 turn 无转账 → reject', () => {
    const outcome = verifyReply({
      text: '余额充足，已为你转出 800 元。',
      evidence: ['账户尾号 1234：余额 ¥8,000.00，可用 ¥8,000.00。'],
    })
    expect(outcome.rejected).toBe(1)
    expect(outcome.decision).toBe('reject')
    expect(outcome.text).toBe(refusalText())
    expect(outcome.text).toContain(`reasonCode: ${ASSERTION_REJECT_CODE}`)
  })

  it('TC-W05-06 四个计数之和 = 抽取总数（自洽）', () => {
    const outcome = verifyReply({
      text: '余额 800 元；费率 0.3%；2026年10月26日 到期。',
      evidence: ['账户余额 ¥800.00。', '活期费率 0.3%。'],
    })
    expect(outcome.total).toBe(3)
    expect(outcome.verified).toBe(2)
    expect(outcome.needsEvidence).toBe(1)
    expect(outcome.rejected).toBe(0)
    expect(outcome.verified + outcome.needsEvidence + outcome.rejected).toBe(outcome.total)
  })

  it('资金动作声明只认“成功”出参：余额证据不能证明“已转出”', () => {
    const balanceOnly = verifyReply({
      text: '已为你转出 800 元。',
      evidence: ['账户尾号 1234：余额 ¥800.00。'],
    })
    expect(balanceOnly.decision).toBe('reject')

    const transferred = verifyReply({
      text: '已为你转出 800 元。',
      evidence: ['转账成功：¥800.00 → 王建国；流水号 txn-1；余额 ¥7,200.00。'],
    })
    expect(transferred.decision).toBe('pass')
    expect(transferred.verified).toBe(1)
  })

  it('日期允许省略年份；账号尾号只认四位数字', () => {
    const date = verifyReply({
      text: '账单截至 10月26日。',
      evidence: ['账单周期：2026-10-26 至 2026-11-25。'],
    })
    expect(date.decision).toBe('pass')

    const tail = verifyReply({
      text: '尾号 1234 的账户可用。',
      evidence: ['账户尾号 1234：余额 ¥1.00。'],
    })
    expect(tail.decision).toBe('pass')
    expect(extractAssertions('尾号 1234')[0]?.kind).toBe('account-tail')
  })

  it('无高影响断言 → 零计数直通（不拦闲聊）', () => {
    const outcome = verifyReply({ text: '今天天气不错，有什么可以帮你？', evidence: [] })
    expect(outcome.total).toBe(0)
    expect(outcome.decision).toBe('pass')
    expect(outcome.text).toBe('今天天气不错，有什么可以帮你？')
  })

  it('证据里“消费 800 元”不会把“已转出 800 元”算成已发生', () => {
    const evidence = collectEvidence(['今日消费 ¥800.00，余额 ¥7,200.00。'])
    expect(evidence.actionValues.has('80000')).toBe(false)
  })

  it('否定语境不按资金动作拒答（转账失败的诚实说明 → 仅未核实）', () => {
    const outcome = verifyReply({
      text: '已尝试转出 800 元，但转账失败，资金未动。',
      evidence: [],
    })
    expect(outcome.decision).toBe('annotate')
    expect(outcome.rejected).toBe(0)
  })
})
