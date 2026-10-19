/**
 * 票据生命周期账本（施工单 09 §3）：转移合法性 + `ticket/*` 事件。
 *
 * 核销属主仍是 bank-core；本账本只是**观察者 + 记账者**，用例只断言它自己的状态与事件。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { TicketLedger, type TicketIssueInput } from './ticket-ledger.ts'
import type { InteractionRecord } from './events.ts'

/** 一条签发输入（默认 800 元、TTL 1s）。 */
function issue(overrides: Partial<TicketIssueInput> = {}): TicketIssueInput {
  return {
    ticketId: 'ticket:c1',
    callId: 'c1',
    name: 'transfer_create',
    fingerprint: 'fp',
    amountCents: 80_000,
    expiresAt: 1_000,
    at: 10,
    ...overrides,
  }
}

/** 收集事件。 */
function recorder(): { list: InteractionRecord[]; record: (item: InteractionRecord) => void } {
  const list: InteractionRecord[] = []
  return { list, record: (item) => list.push(item) }
}

describe('签发', () => {
  it('issue → issued，并落 ticket/issued（含金额与 TTL 绑定）', () => {
    const sink = recorder()
    const ledger = new TicketLedger({ record: sink.record })
    const entry = ledger.issue(issue())

    expect(entry.status).toBe('issued')
    expect(entry.amountCents).toBe(80_000)
    expect(ledger.size).toBe(1)
    expect(ledger.get('ticket:c1')).toEqual(entry)
    expect(ledger.forCall('c1')).toEqual(entry)
    expect(ledger.forCall('c-other')).toBeUndefined()
    expect(ledger.entries()).toHaveLength(1)
    expect(sink.list[0]).toEqual({
      type: 'ticket/issued',
      data: {
        ticketId: 'ticket:c1',
        callId: 'c1',
        name: 'transfer_create',
        fingerprint: 'fp',
        amountCents: 80_000,
        expiresAt: 1_000,
        at: 10,
      },
    })
  })

  it('无金额工具：事件里不带 amountCents', () => {
    const sink = recorder()
    const ledger = new TicketLedger({ record: sink.record })
    ledger.issue(issue({ amountCents: undefined, name: 'card_unfreeze' }))
    expect(sink.list[0]?.data).not.toHaveProperty('amountCents')
  })

  it('重复签发：ticket-duplicate', () => {
    const ledger = new TicketLedger()
    ledger.issue(issue())
    expect(captureThrown(() => ledger.issue(issue())).code).toBe('ticket-duplicate')
  })

  it('缺省无审计出口也能工作（纯内存）', () => {
    const ledger = new TicketLedger()
    expect(ledger.issue(issue()).status).toBe('issued')
  })
})

describe('批准与核销', () => {
  it('issued → approved → redeemed → consumed，事件按序落账', () => {
    const sink = recorder()
    const ledger = new TicketLedger({ record: sink.record })
    ledger.issue(issue())
    expect(ledger.approve('ticket:c1', 20).status).toBe('approved')
    expect(ledger.redeem('ticket:c1', 30).status).toBe('redeemed')
    expect(ledger.consume('ticket:c1', 40).status).toBe('consumed')
    expect(sink.list.map((item) => item.type)).toEqual([
      'ticket/issued',
      'ticket/approved',
      'ticket/redeemed',
      'ticket/consumed',
    ])
    expect(ledger.get('ticket:c1')).toMatchObject({
      approvedAt: 20,
      redeemedAt: 30,
      consumedAt: 40,
    })
  })

  it('重复批准 / 重复核销 / 重复消费是幂等 no-op（不重复落事件）', () => {
    const sink = recorder()
    const ledger = new TicketLedger({ record: sink.record })
    ledger.issue(issue())
    ledger.approve('ticket:c1', 20)
    ledger.approve('ticket:c1', 21)
    ledger.redeem('ticket:c1', 30)
    ledger.redeem('ticket:c1', 31)
    ledger.consume('ticket:c1', 40)
    ledger.consume('ticket:c1', 41)
    expect(sink.list).toHaveLength(4)
  })

  it('未批准就核销：ticket-not-approved', () => {
    const ledger = new TicketLedger()
    ledger.issue(issue())
    expect(captureThrown(() => ledger.redeem('ticket:c1', 20)).code).toBe('ticket-not-approved')
  })

  it('已阻断的票据不能批准 / 核销 / 消费', () => {
    const ledger = new TicketLedger()
    ledger.issue(issue())
    ledger.block('ticket:c1', 'approval-rejected', 20)
    expect(captureThrown(() => ledger.approve('ticket:c1', 21)).code).toBe('ticket-closed')
    expect(captureThrown(() => ledger.redeem('ticket:c1', 22)).code).toBe('ticket-closed')
    expect(captureThrown(() => ledger.consume('ticket:c1', 23)).code).toBe('ticket-closed')
  })

  it('未核销就消费：ticket-closed', () => {
    const ledger = new TicketLedger()
    ledger.issue(issue())
    ledger.approve('ticket:c1', 20)
    expect(captureThrown(() => ledger.consume('ticket:c1', 30)).code).toBe('ticket-closed')
  })

  it('未知票据：每次转移都 ticket-unknown', () => {
    const ledger = new TicketLedger()
    for (const run of [
      () => ledger.approve('nope', 1),
      () => ledger.redeem('nope', 1),
      () => ledger.consume('nope', 1),
      () => ledger.block('nope', 'x', 1),
    ]) {
      expect(captureThrown(run).code).toBe('ticket-unknown')
    }
  })
})

describe('阻断', () => {
  it('签发后直接阻断（拒绝 / 超时）→ blocked，落 ticket/blocked', () => {
    const sink = recorder()
    const ledger = new TicketLedger({ record: sink.record })
    ledger.issue(issue())
    const blocked = ledger.block('ticket:c1', 'approval-unavailable', 25)
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockedReason).toBe('approval-unavailable')
    expect(sink.list.at(-1)).toEqual({
      type: 'ticket/blocked',
      data: {
        ticketId: 'ticket:c1',
        callId: 'c1',
        name: 'transfer_create',
        reason: 'approval-unavailable',
        at: 25,
      },
    })
  })

  it('重复阻断幂等；已消费的票据不能再阻断', () => {
    const ledger = new TicketLedger()
    ledger.issue(issue())
    ledger.block('ticket:c1', 'x', 20)
    expect(ledger.block('ticket:c1', 'y', 21).blockedReason).toBe('x')

    const other = new TicketLedger()
    other.issue(issue({ ticketId: 'ticket:c2', callId: 'c2' }))
    other.approve('ticket:c2', 10)
    other.redeem('ticket:c2', 11)
    other.consume('ticket:c2', 12)
    expect(captureThrown(() => other.block('ticket:c2', 'late', 13)).code).toBe('ticket-closed')
  })

  it('执行失败：核销后仍可阻断（审计留痕）', () => {
    const ledger = new TicketLedger()
    ledger.issue(issue())
    ledger.approve('ticket:c1', 10)
    ledger.redeem('ticket:c1', 11)
    expect(ledger.block('ticket:c1', 'tool-failed', 12).status).toBe('blocked')
  })
})
