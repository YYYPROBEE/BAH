/**
 * W05 断言抽取的边界（解析类，误判即误杀或漏判）。
 *
 * 这里钉的是此前没被任何用例走到的分支：重叠匹配去重、亿级金额、
 * 千分率与百分率分派、`****1234` 尾号写法、不可解析的中文数字**不猜**，
 * 以及「动作证据只来自成功句」的句子级口径。
 */

import { describe, expect, it } from 'vitest'

import { collectEvidence, extractAssertions } from './extract.ts'

describe('金额抽取：重叠与数量级', () => {
  it('`¥800元` 同时命中符号与单位规则，只记一条（重复计数会放大 total）', () => {
    const assertions = extractAssertions('余额 ¥800元')
    expect(assertions).toHaveLength(1)
    expect(assertions[0]).toMatchObject({ kind: 'balance', value: '80000', raw: '¥800' })
  })

  it('亿级金额按分换算（2 亿 = 20000000000 分）', () => {
    const [assertion] = extractAssertions('人民币 2亿')
    expect(assertion).toMatchObject({ kind: 'amount', value: '20000000000' })
  })

  it('不可解析的中文省略写法（一百五）宁可不抽，也不猜成 105', () => {
    expect(extractAssertions('报价 ¥一百五')).toEqual([])
  })

  it('白名单外的高位数字（流水号 / 电话）不产生断言', () => {
    expect(extractAssertions('流水号 12345678，电话 13800138000')).toEqual([])
  })

  it('空文本 / 空证据不崩，也不产生断言', () => {
    expect(extractAssertions('')).toEqual([])
    expect(collectEvidence([]).values.size).toBe(0)
  })
})

describe('费率与尾号', () => {
  it('千分之 → 基点按 permille 换算，百分之 → 按 percent 换算', () => {
    const rates = extractAssertions('费率千分之三，另一档百分之三')
    expect(rates.map((item) => [item.kind, item.value])).toEqual([
      ['rate', '30'],
      ['rate', '300'],
    ])
  })

  it('`****1234` 与「尾号 1234」等价，都归一为四位尾号', () => {
    const [masked] = extractAssertions('账户 ****1234')
    expect(masked).toMatchObject({ kind: 'account-tail', value: '1234' })
  })
})

describe('句子级归属：余额与资金动作', () => {
  it('同一回复里按句子区分 balance / amount，不把余额算成动账金额', () => {
    const assertions = extractAssertions('余额 800 元；转账成功 800 元。')
    expect(assertions.map((item) => item.kind)).toEqual(['balance', 'amount'])
  })

  it('动作证据只取「成功句」里的金额：余额句不进入 actionValues', () => {
    const evidence = collectEvidence([
      '转账成功：¥800.00 → 王建国；流水号 txn-1；余额 ¥7,200.00。',
    ])
    expect(evidence.actionValues.has('80000')).toBe(true)
    expect(evidence.actionValues.has('720000')).toBe(false)
  })

  it('纯余额证据不构成任何「已转出」的动作证据', () => {
    const evidence = collectEvidence(['账户余额 ¥800.00，可用 ¥800.00。'])
    expect(evidence.actionValues.size).toBe(0)
    expect(evidence.values.get('balance')?.has('80000')).toBe(true)
  })
})
