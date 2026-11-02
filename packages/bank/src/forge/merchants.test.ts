import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import {
  MERCHANT_OFFERS,
  applyFault,
  orderOffer,
  searchOffers,
  type MerchantFault,
  type MerchantOffer,
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

describe('商户域：判决边界（同价稳定序 / 零库存 / 未知故障开关）', () => {
  // 真实数据集里价格互不重复，比较器的第二档（同价 ⇒ 按 offerId）永远走不到；
  // 而"换店候选"要的正是这一档——缺了它，同价报价的顺序就取决于数组传入顺序。
  const tied: readonly MerchantOffer[] = [
    {
      offerId: 'o-tie-zzz',
      merchantId: 'm-tie',
      merchantName: '同价花房',
      name: '花束乙',
      category: 'flower',
      priceCents: 10_000,
      etaMinutes: 30,
      stock: 1,
    },
    {
      offerId: 'o-tie-aaa',
      merchantId: 'm-tie',
      merchantName: '同价花房',
      name: '花束甲',
      category: 'flower',
      priceCents: 10_000,
      etaMinutes: 30,
      stock: 1,
    },
  ]

  it('同价 ⇒ 按 offerId 升序；输入顺序换了结果不变（确定性）', () => {
    const forward = searchOffers(tied, {})
    expect(forward.map((offer) => offer.offerId)).toEqual(['o-tie-aaa', 'o-tie-zzz'])
    expect(searchOffers([...tied].reverse(), {})).toEqual(forward)
  })

  it('库存 0 的报价即使绕过搜索直接下单也必须 out-of-stock（不超卖）', () => {
    const soldOut: readonly MerchantOffer[] = [
      {
        offerId: 'o-empty-1',
        merchantId: 'm-tie',
        merchantName: '同价花房',
        name: '售罄花束',
        category: 'flower',
        priceCents: 10_000,
        etaMinutes: 30,
        stock: 0,
      },
    ]
    expect(orderOffer(soldOut, 'o-empty-1', 'none', 1)).toMatchObject({
      ok: false,
      code: 'out-of-stock',
    })
  })

  // `channel:merchant` 的 `fault` 已由 `readEnum` 在配置层拦住非法值，所以这条 default
  // 在现装配下走不到；钉它的理由是穷尽性本身：将来给 `MerchantFault` 加一档而忘了
  // 在这里分支时，必须立刻红，而不是静默按"没故障"把报价原样返回。
  it('未知故障开关 ⇒ unreachable-branch（assertNever 收尾，不静默按 none）', () => {
    const error = captureThrown(() =>
      applyFault(MERCHANT_OFFERS, 'power-down' as MerchantFault),
    )
    expect(error.code).toBe('unreachable-branch')
  })
})
