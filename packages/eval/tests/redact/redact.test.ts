import { describe, expect, it } from 'vitest'

import { redactRecord, redactText, redactValue, tokenize } from '../../src/redact/redact.ts'

/** 三类样本：19 位卡号 / 18 位身份证（末位 X）/ 11 位手机号。 */
const CARD = '6222021234567890123'
const ID_CARD = '11010119900307123X'
const PHONE = '13800138000'

describe('脱敏令牌化', () => {
  // T14
  it('T14 卡号/证件/手机号样本：输出中 0 原文，令牌格式正确', () => {
    const raw = {
      note: `卡号 ${CARD}，证件 ${ID_CARD}，手机 ${PHONE}`,
      nested: { list: [`再次 ${PHONE}`] },
    }

    const redacted = redactRecord(raw)
    const text = JSON.stringify(redacted)

    expect(text).not.toContain(CARD)
    expect(text).not.toContain(ID_CARD)
    expect(text).not.toContain(PHONE)
    expect(text).toMatch(/CARD-[0-9a-f]{8}/)
    expect(text).toMatch(/ID-[0-9a-f]{8}/)
    expect(text).toMatch(/TEL-[0-9a-f]{8}/)
  })

  it('令牌确定：同一原值恒得同一令牌（跨进程可关联）', () => {
    expect(tokenize('card', CARD)).toBe(tokenize('card', CARD))
    expect(tokenize('tel', PHONE)).toBe(tokenize('tel', PHONE))
  })

  it('令牌区分种类：同一串按不同种类散列得到不同令牌', () => {
    expect(tokenize('id', CARD)).not.toBe(tokenize('card', CARD))
  })

  it('换盐后令牌改变（部署面可换机密盐）', () => {
    expect(tokenize('tel', PHONE, { salt: 'a' })).not.toBe(tokenize('tel', PHONE, { salt: 'b' }))
  })

  it('18 位证件号优先于卡号规则（最坏只是种类标错，绝不漏脱敏）', () => {
    const output = redactText(ID_CARD)
    expect(output).toMatch(/^ID-[0-9a-f]{8}$/)
  })

  it('卡号不跨长度误切：19 位整串吃掉，不留残片', () => {
    const output = redactText(CARD)
    expect(output).toMatch(/^CARD-[0-9a-f]{8}$/)
  })

  it('不误伤短数字（订单号 / 金额 / 年份）', () => {
    expect(redactText('订单 2026 金额 5000.01 期数 3')).toBe('订单 2026 金额 5000.01 期数 3')
  })

  it('不误伤被字母包裹的数字串', () => {
    expect(redactText('ref=11010119900307123X9')).toBe('ref=11010119900307123X9')
  })

  it('身份类键下的数值型卡号也会令牌化（防 JSON number 夹带）', () => {
    // 用 16 位（落在 Number.MAX_SAFE_INTEGER 内）：19 位数值本身已不精确，
    // 记下来也不是原文，令牌化它没有意义。
    const redacted = redactValue({ cardNo: 6222021234567890, pan: 13800138000 }) as Record<
      string,
      unknown
    >
    expect(redacted['cardNo']).toMatch(/CARD-[0-9a-f]{8}/)
    expect(redacted['pan']).toMatch(/TEL-[0-9a-f]{8}/)
  })

  it('身份类键下的字符串同样按形状令牌化', () => {
    const redacted = redactValue({ cardNo: CARD, pan: PHONE }) as Record<string, unknown>
    expect(redacted['cardNo']).toMatch(/CARD-[0-9a-f]{8}/)
    expect(redacted['pan']).toMatch(/TEL-[0-9a-f]{8}/)
  })

  it('不安全整数（超出安全范围）原样保留，不伪造令牌', () => {
    const unsafe = 6222021234567890123
    const redacted = redactValue({ cardNo: unsafe }) as Record<string, unknown>
    expect(redacted['cardNo']).toBe(unsafe)
  })

  it('普通键下的数值保持数值（保护 PSA 数值域断言）', () => {
    const redacted = redactValue({ amount: 50000.01, count: 1 }) as Record<string, unknown>
    expect(redacted['amount']).toBe(50000.01)
    expect(redacted['count']).toBe(1)
  })

  it('非字符串非对象的值原样透传', () => {
    expect(redactValue(true)).toBe(true)
    expect(redactValue(null)).toBe(null)
    expect(redactValue(undefined)).toBe(undefined)
  })

  it('Date 原样透传，不被吃成空对象', () => {
    // `typeof new Date()` 是 'object'，按 typeof 递归会得到 `{}`——数据静默消失。
    const date = new Date('2026-10-22T00:00:00.000Z')
    const redacted = redactValue({ at: date }) as Record<string, unknown>

    expect(redacted['at']).toBeInstanceOf(Date)
    expect((redacted['at'] as Date).getTime()).toBe(date.getTime())
  })

  it('数组递归脱敏', () => {
    const redacted = redactValue([PHONE, 'ok', 42]) as unknown[]
    expect(redacted[0]).toMatch(/TEL-[0-9a-f]{8}/)
    expect(redacted[1]).toBe('ok')
    expect(redacted[2]).toBe(42)
  })
})
