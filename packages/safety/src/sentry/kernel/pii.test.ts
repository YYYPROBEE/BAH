/**
 * 内核·代币化编译器用例。
 * 源用例：`tests/kernel.test.js` 的 pii 段 4 条全量搬迁（A1 全量替换回归在内）；
 * 另补 B2 预检、掩码口径、模式表覆盖与"随机段可注入"的用例。
 */

import { describe, expect, it } from 'vitest'

import { DETOKEN_DESTINATIONS, TokenizerVault, maskValue } from './pii.ts'

/** 定值随机段工厂：代币串可预测，断言能钉到字符级。 */
function deterministicVault(): TokenizerVault {
  let counter = 0
  return new TokenizerVault({ randomHex: () => (counter += 1).toString(16).padStart(8, '0') })
}

describe('compile·A1 全量替换回归', () => {
  it('重复出现的 PII 不留原文', () => {
    const vault = deterministicVault()
    const [compiled, replaced] = vault.compile('卡号 6222020200112233，再确认 6222020200112233', 'user_message')
    expect(replaced).toEqual([
      { token: '⟦TK:BANKCARD:00000001⟧', type: 'BANKCARD', source: 'user_message' },
    ])
    expect(compiled).toBe('卡号 ⟦TK:BANKCARD:00000001⟧，再确认 ⟦TK:BANKCARD:00000001⟧')
    expect(compiled.includes('6222020200112233')).toBe(false)
    expect(compiled.split('⟦TK:BANKCARD:00000001⟧').length - 1).toBe(2)
  })

  it('多种类型按模式表顺序依次编译', () => {
    const vault = deterministicVault()
    expect(vault.compile('联系我 13800138000 或 a@b.com', 'user_message')).toEqual([
      '联系我 ⟦TK:PHONE:00000001⟧ 或 ⟦TK:EMAIL:00000002⟧',
      [
        { token: '⟦TK:PHONE:00000001⟧', type: 'PHONE', source: 'user_message' },
        { token: '⟦TK:EMAIL:00000002⟧', type: 'EMAIL', source: 'user_message' },
      ],
    ])
  })

  it('机密串（SECRET_KEY）与身份证（IDCARD）同样进编译', () => {
    const vault = deterministicVault()
    const [compiled] = vault.compile('密钥 sk-abcdefghijklmnop1234 与 口令=abcdefghij123456789', 'tool_result')
    expect(compiled).toBe('密钥 ⟦TK:SECRET_KEY:00000001⟧ 与 ⟦TK:SECRET_KEY:00000002⟧')
    expect(vault.map.get('⟦TK:SECRET_KEY:00000001⟧')).toEqual({
      original: 'sk-abcdefghijklmnop1234',
      type: 'SECRET_KEY',
      source: 'tool_result',
    })
  })

  it('B2 预检：零命中直接返回，不建映射', () => {
    const vault = deterministicVault()
    expect(vault.compile('纯文本没有敏感信息', 'user_message')).toEqual(['纯文本没有敏感信息', []])
    expect(vault.map.size).toBe(0)
  })

  it('缺省随机段仍产 8 位 hex 代币', () => {
    const vault = new TokenizerVault()
    const [, replaced] = vault.compile('卡号 6222020200112233', 'tool_result')
    expect(replaced).toHaveLength(1)
    expect(replaced[0]?.token).toMatch(/^⟦TK:BANKCARD:[0-9a-f]{8}⟧$/)
  })
})

describe('detect·只检测不替换', () => {
  it('命中类型与掩码（重复出现各记一笔）', () => {
    const vault = deterministicVault()
    expect(vault.detect('联系我 13800138000 或 a@b.com')).toEqual([
      { type: 'PHONE', masked: '1380***' },
      { type: 'EMAIL', masked: 'a@b.***' },
    ])
    expect(vault.detect('卡号 6222020200112233，再确认 6222020200112233').map((hit) => hit.type)).toEqual([
      'BANKCARD',
      'BANKCARD',
    ])
    expect(vault.detect('纯文本没有敏感信息')).toEqual([])
  })

  it('身份证按模式表顺序先被 PHONE 咬住一段（源行为，非新缺陷）', () => {
    const vault = deterministicVault()
    expect(vault.detect('身份证 11010119900307777X')).toEqual([
      { type: 'PHONE', masked: '1990***' },
      { type: 'IDCARD', masked: '1101***' },
    ])
  })

  it('detect 不写映射表', () => {
    const vault = deterministicVault()
    vault.detect('电话 13800138000')
    expect(vault.map.size).toBe(0)
  })
})

describe('detokenize·目的地白名单（deny-by-default）', () => {
  it('白名单工具 + 白名单槽才还原', () => {
    const vault = deterministicVault()
    const [compiled] = vault.compile('电话 13800138000', 'user_message')
    expect(vault.detokenize('send_email', 'to', compiled)).toBe('电话 13800138000')
    expect(vault.detokenize('response_body', 'text', compiled)).toBe('电话 13800138000')
  })

  it('非白名单槽 / 非白名单工具都原样返回（代币不可还原）', () => {
    const vault = deterministicVault()
    const [compiled] = vault.compile('电话 13800138000', 'user_message')
    expect(vault.detokenize('send_email', 'subject', compiled)).toBe('电话 ⟦TK:PHONE:00000001⟧')
    expect(vault.detokenize('transfer', 'to', compiled)).toBe('电话 ⟦TK:PHONE:00000001⟧')
    expect(vault.detokenize('transfer', 'to', compiled)).not.toBe('电话 13800138000')
  })

  it('白名单表就是这两项（新增目的地必须显式登记）', () => {
    expect(DETOKEN_DESTINATIONS).toEqual({ send_email: ['to', 'body'], response_body: ['text'] })
  })
})

describe('leakReport·出站残留原文', () => {
  it('代币化文本干净，原文出站即记泄露', () => {
    const vault = new TokenizerVault()
    const [compiled] = vault.compile('卡号 6222020200112233', 'user_message')
    expect(vault.leakReport(compiled)).toEqual([])
    expect(vault.leakReport('出站里有 6222020200112233')).toEqual(['6222***'])
  })
})

describe('maskValue·审计掩码口径', () => {
  it('保留前 4 位 + 三个星', () => {
    expect(maskValue('13800138000')).toBe('1380***')
    expect(maskValue('a@b.com')).toBe('a@b.***')
    expect(maskValue(12)).toBe('12***')
    expect(maskValue('6222020200112233')).toBe('6222***')
  })
})
