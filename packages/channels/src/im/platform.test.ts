/**
 * 平台契约的纯工具用例（施工单 01 §5；契约类型本身由 02 门禁 G13 钉住）。
 *
 * `outboundText` 是"适配器只能发送文本"的唯一取值点，三种出站都要在这里过一遍。
 */

import { describe, expect, it } from 'vitest'

import { outboundText } from './platform.ts'
import type { ImOutbound } from './render.ts'

describe('outboundText', () => {
  it('text / approval / handoff 都只取 .text（附加字段不进平台报文）', () => {
    const text: ImOutbound = { kind: 'text', text: '普通回复' }
    const approval: ImOutbound = {
      kind: 'approval',
      ticketId: 'ticket:abc',
      text: '【审批】转账',
      tier: 'red',
      expiresAt: 1_700_000_000_000,
    }
    const handoff: ImOutbound = { kind: 'text', text: '【转人工】已交回智能助手' }
    expect(outboundText(text)).toBe('普通回复')
    expect(outboundText(approval)).toBe('【审批】转账')
    expect(outboundText(handoff)).toBe('【转人工】已交回智能助手')
  })
})
