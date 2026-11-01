/**
 * 审批文本指令解析用例。
 *
 * 关键负控：数字指令后的中文不能被当成票据号——否则「1 万元转账」会被解析成"批准"。
 */

import { describe, expect, it } from 'vitest'

import { IM_COMMAND_MAX_REASON, parseImCommand } from './commands.ts'

describe('parseImCommand：数字与中文别名（T-CH-009）', () => {
  it('0 → 拉取最新结果', () => {
    expect(parseImCommand('0')).toEqual({ kind: 'fetch-latest' })
    expect(parseImCommand(' 0 ')).toEqual({ kind: 'fetch-latest' })
  })

  it('1 / 确认 → approve（票据号可选）', () => {
    expect(parseImCommand('1')).toEqual({ kind: 'approve' })
    expect(parseImCommand('确认')).toEqual({ kind: 'approve' })
    expect(parseImCommand('1 ticket:abc')).toEqual({ kind: 'approve', ticketId: 'ticket:abc' })
    expect(parseImCommand('确认 ap-20261101-001')).toEqual({ kind: 'approve', ticketId: 'ap-20261101-001' })
  })

  it('2 / 拒绝 → reject（理由必填）', () => {
    expect(parseImCommand('2 金额不对')).toEqual({ kind: 'reject', reason: '金额不对' })
    expect(parseImCommand('2 ticket:abc 金额不对')).toEqual({
      kind: 'reject',
      ticketId: 'ticket:abc',
      reason: '金额不对',
    })
    expect(parseImCommand('拒绝 ap-01 收款人是陌生人')).toEqual({
      kind: 'reject',
      ticketId: 'ap-01',
      reason: '收款人是陌生人',
    })
  })

  it('3 / 详情、4 / 验证 → detail / verify（票据号可选）', () => {
    expect(parseImCommand('3')).toEqual({ kind: 'detail' })
    expect(parseImCommand('详情 ticket:abc')).toEqual({ kind: 'detail', ticketId: 'ticket:abc' })
    expect(parseImCommand('4')).toEqual({ kind: 'verify' })
    expect(parseImCommand('验证 ticket:abc')).toEqual({ kind: 'verify', ticketId: 'ticket:abc' })
  })

  it('转人工 → takeover（理由可选）', () => {
    expect(parseImCommand('转人工')).toEqual({ kind: 'takeover' })
    expect(parseImCommand('转人工 转错账了')).toEqual({ kind: 'takeover', reason: '转错账了' })
  })
})

describe('parseImCommand：拒绝理由的边界（T-CH-010）', () => {
  it('2 无理由 ⇒ 不返回 reject', () => {
    expect(parseImCommand('2')).toBeUndefined()
    expect(parseImCommand('2   ')).toBeUndefined()
    expect(parseImCommand('2 ticket:abc')).toBeUndefined()
    expect(parseImCommand('拒绝 ticket:abc')).toBeUndefined()
  })

  it('理由超过 500 字 ⇒ 不返回 reject', () => {
    const long = '很'.repeat(IM_COMMAND_MAX_REASON + 1)
    expect(parseImCommand(`2 ${long}`)).toBeUndefined()
    expect(parseImCommand(`2 ${'很'.repeat(IM_COMMAND_MAX_REASON)}`)).toEqual({
      kind: 'reject',
      reason: '很'.repeat(IM_COMMAND_MAX_REASON),
    })
  })
})

describe('parseImCommand：普通文本不误判（T-CH-011）', () => {
  it('自然语言一律 undefined', () => {
    expect(parseImCommand('我想转账 100 元')).toBeUndefined()
    expect(parseImCommand('1 万元转账')).toBeUndefined()
    expect(parseImCommand('3 点以后再说')).toBeUndefined()
    expect(parseImCommand('0 元能转账吗')).toBeUndefined()
    expect(parseImCommand('')).toBeUndefined()
    expect(parseImCommand('   ')).toBeUndefined()
    expect(parseImCommand('你好')).toBeUndefined()
    expect(parseImCommand('确认一下余额')).toBeUndefined()
    expect(parseImCommand('转人工服务很好')).toBeUndefined()
  })
})
