/**
 * 票据记账平面（`tools/result`）：只读 bank-core 状态，不核销。
 */

import { createContext } from '@bah/core'
import type { Context, SessionId } from '@bah/core'
import { describe, expect, it } from 'vitest'

import { provideSentry, resolveSentrySettings, type SentryHandle } from './index.ts'

/** 记账平面测试台：票据状态由用例注入。 */
function harness(statuses: Readonly<Record<string, string>>): {
  readonly ctx: Context
  readonly handle: SentryHandle
  result(callId: string, isError: boolean, code?: string): Promise<void>
} {
  const ctx = createContext()
  let now = 1_000
  const handle = provideSentry(ctx, resolveSentrySettings({ trace: { sink: 'memory' } }), {
    sessionId: 's-ticket' as SessionId,
    now: () => {
      now += 1
      return now
    },
    record: () => {},
    toolTier: () => undefined,
    ticketStatus: (ticketId) => statuses[ticketId],
    revokeTickets: () => 0,
    nudge: () => {},
  })
  return {
    ctx,
    handle,
    async result(callId, isError, code) {
      await ctx.events.emit('tools/result', {
        callId,
        name: 'transfer_create',
        isError,
        ...(code === undefined ? {} : { code }),
        content: [],
      })
    },
  }
}

describe('ticketing（消费 / 阻断 / 不知情）', () => {
  it('核销 + 成功 → consumed（计数位 + 审计记录）', async () => {
    const test = harness({ 'ticket:c-1': 'redeemed' })
    await test.result('c-1', false)
    expect(test.handle.trace.counters.ticketsConsumed).toBe(1)
    const record = test.handle.trace.recent().find((item) => item['kind'] === 'ticket')
    expect(record).toMatchObject({ ticketId: 'ticket:c-1', coreStatus: 'redeemed', accounting: 'consumed' })
  })

  it('核销 + 失败 → blocked（不消费）', async () => {
    const test = harness({ 'ticket:c-1': 'redeemed' })
    await test.result('c-1', true, 'tool-failed')
    expect(test.handle.trace.counters.ticketsConsumed).toBe(0)
    expect(test.handle.trace.recent().find((item) => item['kind'] === 'ticket')).toMatchObject({
      accounting: 'blocked',
      code: 'tool-failed',
    })
  })

  it('未审批 / 已阻断 / 已消费 / 未知状态都给出确定记账', async () => {
    const test = harness({
      'ticket:issued': 'issued',
      'ticket:approved': 'approved',
      'ticket:blocked': 'blocked',
      'ticket:consumed': 'consumed',
      'ticket:mystery': 'mystery',
    })
    await test.result('issued', true, 'approval-not-completed')
    await test.result('approved', false)
    await test.result('blocked', true)
    await test.result('consumed', false)
    await test.result('mystery', false)
    const accounting = test.handle.trace
      .recent()
      .filter((item) => item['kind'] === 'ticket')
      .map((item) => `${String(item['callId'])}:${String(item['accounting'])}`)
    expect(accounting).toEqual([
      'issued:blocked',
      'approved:blocked',
      'blocked:blocked',
      'consumed:consumed',
      'mystery:unknown',
    ])
  })

  it('没有票据的调用不产生记账（无票据不等于 blocked）', async () => {
    const test = harness({})
    await test.result('c-1', false)
    expect(test.handle.trace.recent().filter((item) => item['kind'] === 'ticket')).toEqual([])
  })
})
