/**
 * 理财工具（施工单 08 §3.9–§3.11）：`disclaimerId` 是硬约束。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import type { TicketId } from '@bah/core'

import { bankIds } from '../core/index.ts'
import type { WealthCompareResult, WealthListResult, WealthPurchaseResult } from './dto.ts'
import { fingerprintOf } from './fingerprint.ts'
import { createBankHarness } from './testing.ts'

/** 给理财购买签发并批准票据。 */
function approvePurchaseTicket(
  h: ReturnType<typeof createBankHarness>,
  callId: string,
  args: Readonly<Record<string, unknown>>,
  amountCents: number,
): void {
  const now = h.deps.now?.() ?? 0
  const ticketId = `ticket:${callId}` as TicketId
  h.core.tickets.issue(
    ticketId,
    {
      sessionId: h.ctx.sessionId,
      tool: 'wealth_purchase',
      fingerprint: fingerprintOf('wealth_purchase', args),
      amountCents,
      expiresAt: now + 120_000,
    },
    now,
  )
  h.core.tickets.approve(ticketId, now)
}

describe('wealth_list / wealth_compare（T-TOOLS-005）', () => {
  it('列表带 disclaimerId；筛选 R1 / 期限生效', async () => {
    const h = createBankHarness()
    const all = (await h.call('wealth_list')) as WealthListResult
    expect(all.products).toHaveLength(5)
    expect(all.disclaimerId).toBe('wealth-risk-v1')
    expect(h.auditsOf('read/wealth')[0]).toMatchObject({ op: 'list' })

    const filtered = (await h.call('wealth_list', {
      filter: { riskGrade: 'r1', maxTermDays: 90 },
    })) as WealthListResult
    expect(filtered.products.map((product) => product.productId)).toEqual(['w-1'])
    expect(filtered.filter).toEqual({ riskGrade: 'R1', maxTermDays: 90 })
  })

  it('对比按传入顺序返回，且带 disclaimerId', async () => {
    const h = createBankHarness()
    const result = (await h.call('wealth_compare', { ids: ['w-3', 'w-1'] })) as WealthCompareResult
    expect(result.products.map((product) => product.productId)).toEqual(['w-3', 'w-1'])
    expect(result.disclaimerId).toBe('wealth-risk-v1')
    expect(h.auditsOf('read/wealth')[0]).toMatchObject({ op: 'compare' })
  })

  it('适当性：列表标注 R4 不可购买，R1 可购买（客户 R2）', async () => {
    const h = createBankHarness()
    const all = (await h.call('wealth_list')) as WealthListResult
    expect(all.customerRisk).toBe('R2')
    const w4 = all.products.find((product) => product.productId === 'w-4')
    expect(w4?.eligible).toBe(false)
    expect(w4?.suitabilityNote).toContain('超出您的风险承受能力 R2')
    expect(all.products.find((product) => product.productId === 'w-1')?.eligible).toBe(true)
  })

  it('适当性：对比同样标注（避免列表能看、对比看不出）', async () => {
    const h = createBankHarness()
    const result = (await h.call('wealth_compare', { ids: ['w-4', 'w-1'] })) as WealthCompareResult
    expect(result.customerRisk).toBe('R2')
    expect(result.products[0]?.eligible).toBe(false)
    expect(result.products[1]?.eligible).toBe(true)
  })

  it('适当性：列表正文带客户等级与「不可购买」标注（渠道卡片从正文派生）', async () => {
    const h = createBankHarness()
    const tool = h.tools.get('wealth_list')!
    const result = (await h.call('wealth_list')) as WealthListResult
    const text = (tool.projectContent?.(result) ?? [])
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
    expect(text).toContain('您的风险承受能力：R2')
    expect(text).toContain('【产品风险等级 R4 超出您的风险承受能力 R2，不可购买】')
  })

  it('对比数量 / 未知产品 / 非法筛选：fail-loud', async () => {
    const h = createBankHarness()
    expect((await captureRejection(() => h.call('wealth_compare', { ids: ['w-1'] }))).code).toBe(
      'tool-args-invalid',
    )
    expect((await captureRejection(() => h.call('wealth_compare', { ids: ['w-1', 'w-999'] }))).code).toBe(
      'product-unknown',
    )
    expect((await captureRejection(() => h.call('wealth_list', { filter: { riskGrade: 'R9' } }))).code).toBe(
      'tool-args-invalid',
    )
    expect((await captureRejection(() => h.call('wealth_list', { filter: { kind: 'stock' } }))).code).toBe(
      'tool-args-invalid',
    )
  })
})

describe('wealth_purchase（红级写）', () => {
  const ARGS = { productId: 'w-1', amount: 100 }

  it('没有票据：ticket-missing', async () => {
    const h = createBankHarness()
    expect((await captureRejection(() => h.call('wealth_purchase', ARGS, 'c-no-ticket'))).code).toBe(
      'ticket-missing',
    )
  })

  it('已批准票据：扣款、生成持仓、带 disclaimerId', async () => {
    const h = createBankHarness()
    approvePurchaseTicket(h, 'c-wealth', ARGS, 10_000)

    const result = (await h.call('wealth_purchase', ARGS, 'c-wealth')) as WealthPurchaseResult
    expect(result.productName).toBe('稳盈 90 天')
    expect(result.amountCents).toBe(10_000)
    expect(result.shares).toBe(100)
    expect(result.disclaimerId).toBe('wealth-risk-v1')
    expect(h.auditsOf('wealth/purchased')[0]?.result.holdingId).toBe(result.holdingId)

    const accounts = await h.core.listAccounts(bankIds.user('u-1'))
    expect(accounts[0]?.balanceCents).toBe(1_234_567 - 10_000)
    expect(h.tools.get('wealth_purchase')?.presentResult?.({}, result)).toMatchObject({
      kind: 'bank.wealth-purchased',
    })
  })

  it('低于起投额：below-minimum（票据不被消耗）', async () => {
    const h = createBankHarness()
    approvePurchaseTicket(h, 'c-min', { productId: 'w-3', amount: 1 }, 100)
    const error = await captureRejection(() =>
      h.call('wealth_purchase', { productId: 'w-3', amount: 1 }, 'c-min'),
    )
    expect(error.code).toBe('below-minimum')
    expect(h.core.tickets.status('ticket:c-min' as TicketId)).toBe('approved')
  })

  it('适当性：买 w-4（R4）被拒，票据不被消耗、无成交落账', async () => {
    const h = createBankHarness()
    const args = { productId: 'w-4', amount: 1000 }
    approvePurchaseTicket(h, 'c-suit', args, 100_000)
    const error = await captureRejection(() => h.call('wealth_purchase', args, 'c-suit'))
    // 直接调 execute 绕过了治理面：这里拦得住，说明 `core` 的第二道闸是真的。
    expect(error.code).toBe('suitability-mismatch')
    expect(h.core.tickets.status('ticket:c-suit' as TicketId)).toBe('approved')
    expect(h.auditsOf('wealth/purchased')).toHaveLength(0)
  })

  it('适当性：成交结果带匹配快照 riskMatch（客户 R2 ≥ 产品 R1）', async () => {
    const h = createBankHarness()
    approvePurchaseTicket(h, 'c-match', ARGS, 10_000)
    const result = (await h.call('wealth_purchase', ARGS, 'c-match')) as WealthPurchaseResult
    expect(result.riskMatch).toMatchObject({ customerRisk: 'R2', productRisk: 'R1' })
    expect(result.riskMatch.at).toBe(result.at)
  })

  it('presentCall 是纯函数（黄/红确认卡片契约）', () => {
    const h = createBankHarness()
    const tool = h.tools.get('wealth_purchase')!
    expect(tool.presentCall?.(ARGS)).toEqual(tool.presentCall?.(ARGS))
    expect(tool.presentCall?.(ARGS)).toMatchObject({ kind: 'bank.wealth-confirm' })
  })
})
