/**
 * ADR-0008：票据携带授权来源。
 *
 * 三条断言：
 * 1. 不传 `authorization` ⇒ 事件里没有该字段（老日志/老调用零改动）；
 * 2. 传了 ⇒ `ticket/issued` 与 `ticket/approved` 都带 `{kind:'window', ref, digest}`；
 * 3. 回放/渲染侧读到缺省值 ⇒ 视为 `human`（这里用"字段缺省"表达，渲染层同口径）。
 */

import { describe, expect, it } from 'vitest'

import { TicketLedger } from './ticket-ledger.ts'
import type { InteractionRecord } from './events.ts'

function collector(): { records: InteractionRecord[]; record: (item: InteractionRecord) => void } {
  const records: InteractionRecord[] = []
  return { records, record: (item) => records.push(item) }
}

const WINDOW = { kind: 'window', ref: 'w-call-1', digest: 'digest-1' } as const

describe('TicketLedger · authorization', () => {
  it('缺省不带字段（老行为逐字节不变）', () => {
    const sink = collector()
    const ledger = new TicketLedger({ record: sink.record })
    ledger.issue({ ticketId: 't-1', callId: 'c-1', name: 'transfer_create', fingerprint: 'fp', expiresAt: 100, at: 1 })
    ledger.approve('t-1', 2)
    const issued = sink.records.find((item) => item.type === 'ticket/issued')
    const approved = sink.records.find((item) => item.type === 'ticket/approved')
    expect(issued?.data).not.toHaveProperty('authorization')
    expect(approved?.data).not.toHaveProperty('authorization')
  })

  it('窗口代签：签发与批准都带授权来源', () => {
    const sink = collector()
    const ledger = new TicketLedger({ record: sink.record })
    ledger.issue({
      ticketId: 't-2',
      callId: 'c-2',
      name: 'transfer_create',
      fingerprint: 'fp',
      expiresAt: 100,
      authorization: WINDOW,
      at: 1,
    })
    ledger.approve('t-2', 2, WINDOW)
    const issued = sink.records.find((item) => item.type === 'ticket/issued')
    const approved = sink.records.find((item) => item.type === 'ticket/approved')
    expect(issued?.data).toMatchObject({ authorization: WINDOW })
    expect(approved?.data).toMatchObject({ authorization: WINDOW })
  })

  it('批准时不给来源 ⇒ 即使签发带了，批准事件也不带（两个面各自如实）', () => {
    const sink = collector()
    const ledger = new TicketLedger({ record: sink.record })
    ledger.issue({
      ticketId: 't-3',
      callId: 'c-3',
      name: 'transfer_create',
      fingerprint: 'fp',
      expiresAt: 100,
      authorization: WINDOW,
      at: 1,
    })
    ledger.approve('t-3', 2)
    const approved = sink.records.find((item) => item.type === 'ticket/approved')
    expect(approved?.data).not.toHaveProperty('authorization')
  })
})
