/**
 * 收益承诺类禁词检测（H-13）：4 类必须拒、7 类必须放行。
 *
 * 这组用例的重点不是"能认出保本"，而是**不误杀**：
 * 否定（不保本）、疑问（保本吗？）、引用（您说的『保本』）、规范语境（禁止承诺保本）
 * 都是必须能正常说出去的话。误杀一次，演示现场就少一句正确表述。
 */

import { describe, expect, it } from 'vitest'

import { detectProhibitedClaims } from './claims.ts'

describe('claims：四类禁词必须命中', () => {
  it('保本类：「该产品保本保息，风险为零。」', () => {
    const claims = detectProhibitedClaims('该产品保本保息，风险为零。')
    expect(claims.length).toBeGreaterThan(0)
    expect(claims[0]?.rule).toBe('principal')
    expect(claims[0]?.raw).toBe('保本保息')
  })

  it('收益承诺类：「稳赚不赔，闭眼买。」', () => {
    expect(detectProhibitedClaims('稳赚不赔，闭眼买。')[0]?.rule).toBe('return')
  })

  it('走势断言类：「这只基金必涨，绝对安全。」', () => {
    const rules = detectProhibitedClaims('这只基金必涨，绝对安全。').map((claim) => claim.rule)
    expect(rules).toContain('trend')
    expect(rules).toContain('riskless')
  })

  it('风险断言类：「保证收益 5%，无风险。」', () => {
    const rules = detectProhibitedClaims('保证收益 5%，无风险。').map((claim) => claim.rule)
    expect(rules).toContain('return')
    expect(rules).toContain('riskless')
  })
})

describe('claims：以下表述必须放行（误杀面）', () => {
  it('否定窗口：「本产品不保本，历史业绩不代表未来表现。」', () => {
    expect(detectProhibitedClaims('本产品不保本，历史业绩不代表未来表现。')).toEqual([])
  })

  it('无禁词：「理财非存款，投资有风险。」', () => {
    expect(detectProhibitedClaims('理财非存款，投资有风险。')).toEqual([])
  })

  it('疑问 + 否定：「您是想问保本吗？本产品不承诺保本保收益。」', () => {
    expect(detectProhibitedClaims('您是想问保本吗？本产品不承诺保本保收益。')).toEqual([])
  })

  it('「基准」不是「保本」：业绩比较基准 3.2%，不代表实际收益', () => {
    expect(detectProhibitedClaims('业绩比较基准 3.2%，不代表实际收益。')).toEqual([])
  })

  it('规范语境：「监管禁止承诺保本保收益，我们不会这样表述。」', () => {
    expect(detectProhibitedClaims('监管禁止承诺保本保收益，我们不会这样表述。')).toEqual([])
  })

  it('纯提问（无引用）：「保本吗？」——问号不在紧邻位置，也要放行', () => {
    expect(detectProhibitedClaims('保本吗？')).toEqual([])
  })

  it('引用语境：「您说的『保本』，我们不会这样表述。」', () => {
    expect(detectProhibitedClaims('您说的『保本』，我们不会这样表述。')).toEqual([])
  })
})

describe('claims：实现细节的两个边界', () => {
  it('分句不借否定：前一句的「不」不能放行后一句的「稳赚」', () => {
    const claims = detectProhibitedClaims('不保本。稳赚不赔。')
    expect(claims.map((claim) => claim.rule)).toContain('return')
  })

  it('连续调用结果稳定（g 正则的 lastIndex 已归零）', () => {
    const text = '该产品保本保息。'
    const first = detectProhibitedClaims(text)
    const second = detectProhibitedClaims(text)
    expect(second).toEqual(first)
  })
})
