/**
 * 会话落盘 PII 掩码单测（报告 S3 的持久化侧接线）。
 */

import { describe, expect, it } from 'vitest'

import {
  maskCard,
  maskEmail,
  maskIdCard,
  maskName,
  maskPhone,
  maskText,
  redactValue,
  redactSessionEvent,
} from './redact.ts'

describe('掩码函数', () => {
  it('姓名 / 手机 / 证件 / 银行卡 / 邮箱的边界', () => {
    expect(maskName('')).toBe('***')
    expect(maskName('王')).toBe('王**')
    expect(maskName('王建国')).toBe('王**')
    expect(maskPhone('13900002222')).toBe('139****2222')
    expect(maskPhone('123')).toBe('****')
    expect(maskIdCard('110101199001011234')).toBe('1101**********1234')
    expect(maskIdCard('123')).toBe('********')
    expect(maskCard('6222021234567890')).toBe('****7890')
    expect(maskCard('12')).toBe('****')
    expect(maskEmail('alice@example.com')).toBe('***@example.com')
    expect(maskEmail('not-an-email')).toBe('***')
  })

  it('自由文本同时掩码手机 / 证件 / 银行卡 / 邮箱', () => {
    const text = maskText(
      '电话 13812345678，证件 110101199001011234，卡 6222021234567890，邮箱 a.b@example.com',
    )
    expect(text).toContain('138****5678')
    expect(text).toContain('1101**********1234')
    expect(text).toContain('****7890')
    expect(text).toContain('***@example.com')
    expect(text).not.toContain('13812345678')
  })
})

describe('redactValue', () => {
  it('按敏感键名掩码，非字符串原样保留', () => {
    expect(
      redactValue({
        name: 'transfer_create',
        payee: { name: '王建国' },
        phone: '13900002222',
        idCard: '110101199001011234',
        accountNo: '6222021234567890',
        email: 'alice@example.com',
        password: 'p@ssw0rd',
        amountCents: 500,
        nested: [{ userName: '李雷' }],
      }),
    ).toEqual({
      name: 'transfer_create',
      payee: { name: '王**' },
      phone: '139****2222',
      idCard: '1101**********1234',
      accountNo: '****7890',
      email: '***@example.com',
      password: '[REDACTED]',
      amountCents: 500,
      nested: [{ userName: '李**' }],
    })
  })

  it('深度上限与危险键（原型污染面）', () => {
    let deep: Record<string, unknown> = { value: 'x' }
    for (let index = 0; index < 20; index += 1) deep = { child: deep }
    expect(JSON.stringify(redactValue(deep))).toContain('[DEPTH-LIMIT]')

    const polluted = JSON.parse('{"__proto__":{"x":1},"constructor":2,"prototype":3,"ok":4}')
    expect(redactValue(polluted)).toEqual({ ok: 4 })
  })

  it('redactSessionEvent 只改 data，结构字段不变', () => {
    const event = redactSessionEvent({
      seq: 1,
      at: 2,
      formatVersion: 1,
      type: 'user/message',
      data: { content: '联系 13812345678' },
    })
    expect(event).toMatchObject({ seq: 1, at: 2, type: 'user/message' })
    expect(event.data).toEqual({ content: '联系 138****5678' })
  })
})
