import { describe, expect, it } from 'vitest'

import {
  MERCHANT_OFFERS,
  applyFault,
  orderOffer,
  searchOffers,
} from './merchants.ts'

describe('商户域：搜索（纯函数）', () => {
  it('按品类过滤，价格升序、同价按 offerId（稳定排序）', () => {
    const flowers = searchOffers(MERCHANT_OFFERS, { category: 'flower' })
    expect(flowers.every((offer) => offer.category === 'flower')).toBe(true)
    const prices = flowers.map((offer) => offer.priceCents)
    expect([...prices].sort((a, b) => a - b)).toEqual(prices)
  })

  it('预算与时效过滤生效；缺货商品不进候选', () => {
    const cheap = searchOffers(MERCHANT_OFFERS, { budgetCents: 20_000 })
    expect(cheap.every((offer) => offer.priceCents <= 20_000)).toBe(true)
    const fast = searchOffers(MERCHANT_OFFERS, { maxEtaMinutes: 60 })
    expect(fast.every((offer) => offer.etaMinutes <= 60)).toBe(true)

    const withZero = [...MERCHANT_OFFERS, { ...MERCHANT_OFFERS[0]!, offerId: 'o-zero', stock: 0 }]
    expect(searchOffers(withZero).some((offer) => offer.offerId === 'o-zero')).toBe(false)
  })

  it('排除商户后不再出现', () => {
    const offers = searchOffers(MERCHANT_OFFERS, { excludeMerchants: ['m-flower-a'] })
    expect(offers.some((offer) => offer.merchantId === 'm-flower-a')).toBe(false)
  })

  it('同一输入两次搜索结果逐字相等（无时钟/随机）', () => {
    expect(searchOffers(MERCHANT_OFFERS, { category: 'cake' })).toEqual(
      searchOffers(MERCHANT_OFFERS, { category: 'cake' }),
    )
  })
})

describe('商户域：故障与下单', () => {
  it('stockout 不改搜索结果（售罄发生在下单时）', () => {
    expect(applyFault(MERCHANT_OFFERS, 'stockout')).toEqual(MERCHANT_OFFERS)
  })

  it('price-up 全线 +30%', () => {
    const offers = applyFault(MERCHANT_OFFERS, 'price-up')
    expect(offers[0]?.priceCents).toBe(Math.round((MERCHANT_OFFERS[0]?.priceCents ?? 0) * 1.3))
  })

  it('下单成功：orderId 由 seq 派生（确定性）', () => {
    const result = orderOffer(MERCHANT_OFFERS, 'o-cake-e1', 'none', 7)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.orderId).toBe('mo-7-o-cake-e1')
    expect(result.totalCents).toBe(16_900)
  })

  it('timeout 不返回成功（无法证明是否已下单）', () => {
    const result = orderOffer(MERCHANT_OFFERS, 'o-cake-e1', 'timeout', 1)
    expect(result).toEqual({ ok: false, code: 'merchant-timeout', offerId: 'o-cake-e1' })
  })

  it('未知 offerId、售罄商户、正常商户各有独立结果', () => {
    expect(orderOffer(MERCHANT_OFFERS, 'o-nope', 'none', 1)).toMatchObject({ ok: false, code: 'unknown-offer' })
    expect(orderOffer(MERCHANT_OFFERS, 'o-flower-a1', 'stockout', 1)).toMatchObject({
      ok: false,
      code: 'out-of-stock',
    })
    // 别家照常能下（换店才有意义）
    expect(orderOffer(MERCHANT_OFFERS, 'o-flower-b1', 'stockout', 1)).toMatchObject({ ok: true })
  })

  it('price-up 下单按涨价后的价格结算', () => {
    const result = orderOffer(MERCHANT_OFFERS, 'o-flower-b1', 'price-up', 1)
    if (!result.ok) throw new Error('unreachable')
    expect(result.totalCents).toBe(Math.round(26_900 * 1.3))
  })
})
