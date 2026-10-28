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

  it('lease 的 leaseId 空白 → lease-invalid（签发期就拒，不留半绑定票据）', () => {
    const ledger = new TicketLedger()
    expect(
      captureThrown(() => ledger.issue(issue({ lease: { leaseId: '  ', expiresAt: 20 } }))).code,
    ).toBe('lease-invalid')
    expect(ledger.size).toBe(0)
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

describe('票据账本软上限', () => {
  it('超过上限时清理终态票据，并同步移除 call 索引', () => {
    const ledger = new TicketLedger()
    for (let index = 0; index < 2048; index += 1) {
      const ticketId = `t-${index}`
      ledger.issue(issue({ ticketId, callId: `c-${index}` }))
      ledger.block(ticketId, 'done', 11)
    }
    ledger.issue(issue({ ticketId: 't-active', callId: 'c-active', expiresAt: 100_000 }))

    expect(ledger.size).toBeLessThan(2048)
    expect(ledger.forCall('c-0')).toBeUndefined()
    expect(ledger.forCall('c-active')?.ticketId).toBe('t-active')
  })
})

describe('W12 执行 lease（宿主注入，账本只校验与记账）', () => {
  /** 票据 TTL 到 1000；lease 窗口到 500。 */
  function withLease(overrides: Partial<TicketIssueInput> = {}): TicketLedger {
    const ledger = new TicketLedger()
    ledger.issue(issue({ lease: { leaseId: 'lease:c1', expiresAt: 500 }, ...overrides }))
    return ledger
  }

  it('TC-W12-01 lease 过期后核销 → ticket-expired，票据作废，不落 redeemed', () => {
    const sink = recorder()
    const ledger = new TicketLedger({ record: sink.record })
    ledger.issue(issue({ lease: { leaseId: 'lease:c1', expiresAt: 500 } }))
    expect(ledger.approve('ticket:c1', 20).status).toBe('approved')

    expect(captureThrown(() => ledger.redeem('ticket:c1', 500)).code).toBe('ticket-expired')
    expect(ledger.get('ticket:c1')).toMatchObject({
      status: 'blocked',
      blockedReason: 'ticket-expired',
    })
    expect(sink.list.map((item) => item.type)).toEqual([
      'ticket/issued',
      'ticket/approved',
      'ticket/blocked',
    ])
  })

  it('TC-W12-02 renew() 后同一 leaseId 可核销（前移且 ≤ 票据 TTL）', () => {
    const sink = recorder()
    const ledger = new TicketLedger({ record: sink.record })
    ledger.issue(issue({ lease: { leaseId: 'lease:c1', expiresAt: 500 } }))
    ledger.approve('ticket:c1', 20)

    const renewed = ledger.renewLease('ticket:c1', 900, 400)
    expect(renewed.leaseId).toBe('lease:c1')
    expect(renewed.leaseExpiresAt).toBe(900)
    expect(renewed.expiresAt).toBe(1_000)

    const redeemed = ledger.redeem('ticket:c1', 899)
    expect(redeemed.status).toBe('redeemed')
    expect(sink.list.at(-2)).toEqual({
      type: 'ticket/lease-renewed',
      data: {
        ticketId: 'ticket:c1',
        callId: 'c1',
        name: 'transfer_create',
        leaseId: 'lease:c1',
        previousExpiresAt: 500,
        expiresAt: 900,
        at: 400,
      },
    })
  })

  it('TC-W12-09 lease 越过票据 TTL → 签发期 fail-loud（不静默截断）', () => {
    const ledger = new TicketLedger()
    expect(
      captureThrown(() =>
        ledger.issue(issue({ lease: { leaseId: 'lease:c1', expiresAt: 1_001 } })),
      ).code,
    ).toBe('lease-outlives-ticket')

    expect(
      captureThrown(() =>
        ledger.issue(
          issue({ ticketId: 'ticket:c2', callId: 'c2', lease: { leaseId: 'lease:c2', expiresAt: 10 } }),
        ),
      ).code,
    ).toBe('lease-invalid')
    expect(ledger.size).toBe(0)
  })

  it('已过期的 lease 不能续租（重签 = 复活作废票据）', () => {
    const ledger = withLease()
    ledger.approve('ticket:c1', 20)
    expect(captureThrown(() => ledger.renewLease('ticket:c1', 900, 500)).code).toBe('ticket-expired')
    expect(ledger.get('ticket:c1')?.status).toBe('blocked')
  })

  it('续租只能前移且不越过票据 TTL；终态票据不能续租；无 lease 的票据续租 fail-loud', () => {
    const ledger = withLease()
    expect(captureThrown(() => ledger.renewLease('ticket:c1', 500, 30)).code).toBe(
      'lease-renew-invalid',
    )
    expect(captureThrown(() => ledger.renewLease('ticket:c1', 1_001, 30)).code).toBe(
      'lease-outlives-ticket',
    )

    ledger.approve('ticket:c1', 20)
    ledger.redeem('ticket:c1', 30)
    expect(captureThrown(() => ledger.renewLease('ticket:c1', 900, 40)).code).toBe('ticket-closed')

    const plain = new TicketLedger()
    plain.issue(issue({ ticketId: 'ticket:c9', callId: 'c9' }))
    expect(captureThrown(() => plain.renewLease('ticket:c9', 500, 20)).code).toBe('lease-missing')
  })

  it('未注入 lease 的票据行为完全不变（缺省直通）', () => {
    const ledger = new TicketLedger()
    ledger.issue(issue())
    ledger.approve('ticket:c1', 20)
    expect(ledger.redeem('ticket:c1', 999).status).toBe('redeemed')
  })
})

describe('TC-W12-10 interaction 不反向依赖 @bah/runtime', () => {
  it('package.json 的 dependencies 只有 @bah/core 与 @bah/util（lease 由宿主注入）', async () => {
    const { readFileSync } = await import('node:fs')
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['@bah/core', '@bah/util'])
  })
})
