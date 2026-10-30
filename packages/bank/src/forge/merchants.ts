/**
 * 商户域种子与订购（G4）：**mock 商户**，不是真实商户 API（06 §12 自陈没有接口）。
 *
 * 三条纪律：
 * 1. **纯函数**：搜索与下单都不读时钟/随机；故障由 `fault` 入参决定（演示开关）；
 * 2. **稳定排序**：先价格、再 offerId —— 同一输入任何机器上输出一致（快照可复现）；
 * 3. **资金腿不在这里**：付钱永远走 `transfer_create`（银行工具、治理面完整）；
 *    这里只回执"货订到没有"。
 */

import { assertNever } from '@bah/util'

/**
 * 商品品类（封闭联合）。
 *
 * 命名说明：这里说的是**商品**品类（花 / 蛋糕），与 `core/merchant.ts` 的
 * `MerchantCategory`（交易分类 9 值：dining / coffee / …）是**两个不同概念**。
 * 合并两条支线时两者曾同名，经包入口 `export *` 撞成 TS2308 —— 故此处改名隔离。
 */
export type OfferCategory = 'flower' | 'cake'

/** 故障开关（演示失败补偿用）。 */
export type MerchantFault = 'none' | 'stockout' | 'timeout' | 'price-up'

/** 全部故障取值（门禁/配置用）。 */
export const MERCHANT_FAULTS: readonly MerchantFault[] = ['none', 'stockout', 'timeout', 'price-up']

/** 一条可售商品。 */
export interface MerchantOffer {
  readonly offerId: string
  readonly merchantId: string
  readonly merchantName: string
  readonly name: string
  readonly category: OfferCategory
  /** 单价（分）。 */
  readonly priceCents: number
  /** 预计送达（分钟）。 */
  readonly etaMinutes: number
  readonly stock: number
}

/** 搜索条件。 */
export interface MerchantConstraints {
  readonly category?: OfferCategory
  readonly budgetCents?: number
  readonly maxEtaMinutes?: number
  /** 排除的商户（"这家不行换一家"）。 */
  readonly excludeMerchants?: readonly string[]
}

/** 种子：3 家花店 + 2 家蛋糕店，各 2 个商品（价格覆盖 100–300 元）。 */
export const MERCHANT_OFFERS: readonly MerchantOffer[] = [
  // 花店 A：便宜但慢
  { offerId: 'o-flower-a1', merchantId: 'm-flower-a', merchantName: '青野花艺', name: '红玫瑰花束 11 支', category: 'flower', priceCents: 19_900, etaMinutes: 120, stock: 5 },
  { offerId: 'o-flower-a2', merchantId: 'm-flower-a', merchantName: '青野花艺', name: '向日葵花束', category: 'flower', priceCents: 15_900, etaMinutes: 120, stock: 3 },
  // 花店 B：中等价格，快
  { offerId: 'o-flower-b1', merchantId: 'm-flower-b', merchantName: '南巷花房', name: '香槟玫瑰 19 支', category: 'flower', priceCents: 26_900, etaMinutes: 60, stock: 4 },
  { offerId: 'o-flower-b2', merchantId: 'm-flower-b', merchantName: '南巷花房', name: '混搭花束', category: 'flower', priceCents: 21_900, etaMinutes: 60, stock: 6 },
  // 花店 C：贵但最快
  { offerId: 'o-flower-c1', merchantId: 'm-flower-c', merchantName: '即刻花', name: '进口玫瑰礼盒', category: 'flower', priceCents: 39_900, etaMinutes: 30, stock: 2 },
  { offerId: 'o-flower-c2', merchantId: 'm-flower-c', merchantName: '即刻花', name: '康乃馨花束', category: 'flower', priceCents: 12_900, etaMinutes: 30, stock: 8 },
  // 蛋糕店 D：中等
  { offerId: 'o-cake-d1', merchantId: 'm-cake-d', merchantName: '麦田蛋糕', name: '草莓奶油蛋糕 6 寸', category: 'cake', priceCents: 22_900, etaMinutes: 90, stock: 3 },
  { offerId: 'o-cake-d2', merchantId: 'm-cake-d', merchantName: '麦田蛋糕', name: '巧克力慕斯 6 寸', category: 'cake', priceCents: 25_900, etaMinutes: 90, stock: 2 },
  // 蛋糕店 E：便宜
  { offerId: 'o-cake-e1', merchantId: 'm-cake-e', merchantName: '小满烘焙', name: '水果蛋糕 6 寸', category: 'cake', priceCents: 16_900, etaMinutes: 150, stock: 5 },
  { offerId: 'o-cake-e2', merchantId: 'm-cake-e', merchantName: '小满烘焙', name: '提拉米苏 6 寸', category: 'cake', priceCents: 18_900, etaMinutes: 150, stock: 4 },
]

/**
 * 搜索：按品类/预算/时效过滤，稳定排序（价格升序，同价按 offerId）。
 *
 * 只返回**有货**的商品（缺货的不进候选——"先给用户一个买不到的选项"是骗）。
 */
export function searchOffers(
  offers: readonly MerchantOffer[],
  constraints: MerchantConstraints = {},
): readonly MerchantOffer[] {
  const excluded = new Set(constraints.excludeMerchants ?? [])
  return offers
    .filter((offer) => offer.stock > 0)
    .filter((offer) => constraints.category === undefined || offer.category === constraints.category)
    .filter((offer) => constraints.budgetCents === undefined || offer.priceCents <= constraints.budgetCents)
    .filter((offer) => constraints.maxEtaMinutes === undefined || offer.etaMinutes <= constraints.maxEtaMinutes)
    .filter((offer) => !excluded.has(offer.merchantId))
    .slice()
    .sort((left, right) => {
      if (left.priceCents !== right.priceCents) return left.priceCents - right.priceCents
      return left.offerId < right.offerId ? -1 : left.offerId > right.offerId ? 1 : 0
    })
}

/** 应用故障开关（纯函数：同一输入同一输出）。 */
export function applyFault(
  offers: readonly MerchantOffer[],
  fault: MerchantFault,
): readonly MerchantOffer[] {
  switch (fault) {
    case 'none':
      return offers
    case 'stockout':
      // 售罄发生在**下单时**而不是搜索时：搜索仍看得到这家（否则用户根本选不到），
      // 下单才发现卖完了 —— 这才是"换一家"要演的真实顺序。
      return offers
    case 'price-up':
      // 全线涨价 30%（演示"不擅自加价"）
      return offers.map((offer) => ({ ...offer, priceCents: Math.round(offer.priceCents * 1.3) }))
    case 'timeout':
      // 时效劣化到 3 小时（演示"超时催单/换自提"）
      return offers.map((offer) => ({ ...offer, etaMinutes: 180 }))
    default:
      return assertNever(fault, 'merchant-fault')
  }
}

/** 故障开关里"售罄"针对的商户（演示：最便宜的花店先卖完）。 */
export const STOCKOUT_MERCHANT = 'm-flower-a'

/** 下单结果（闭集；执行器按 code 决定换店还是播报）。 */
export type MerchantOrderResult =
  | {
      readonly ok: true
      readonly orderId: string
      readonly offerId: string
      readonly merchantId: string
      readonly merchantName: string
      readonly totalCents: number
      readonly etaMinutes: number
    }
  | {
      readonly ok: false
      readonly code: 'out-of-stock' | 'merchant-timeout' | 'unknown-offer'
      readonly offerId: string
    }

/**
 * 下单（幂等的 `seq` 由调用方给：同一 `seq` 同一 `offerId` 必须得到同一个 `orderId`）。
 *
 * `fault='timeout'` 时**不返回成功**：超时无法证明是否已下单，按"未成交"处理并播报，
 * 由人工决定催单还是换店——这是"不假装成功"的口径。
 */
export function orderOffer(
  offers: readonly MerchantOffer[],
  offerId: string,
  fault: MerchantFault,
  seq: number,
): MerchantOrderResult {
  const offer = offers.find((item) => item.offerId === offerId)
  if (offer === undefined) return { ok: false, code: 'unknown-offer', offerId }
  if (fault === 'stockout' && offer.merchantId === STOCKOUT_MERCHANT) {
    return { ok: false, code: 'out-of-stock', offerId }
  }
  if (offer.stock <= 0) return { ok: false, code: 'out-of-stock', offerId }
  if (fault === 'timeout') return { ok: false, code: 'merchant-timeout', offerId }
  if (fault === 'price-up') {
    // 涨价后仍按原价下不了单：价格以涨价后的目录为准（调用方的预算校验会用新价）
    return {
      ok: true,
      orderId: `mo-${String(seq)}-${offerId}`,
      offerId,
      merchantId: offer.merchantId,
      merchantName: offer.merchantName,
      totalCents: Math.round(offer.priceCents * 1.3),
      etaMinutes: offer.etaMinutes,
    }
  }
  return {
    ok: true,
    orderId: `mo-${String(seq)}-${offerId}`,
    offerId,
    merchantId: offer.merchantId,
    merchantName: offer.merchantName,
    totalCents: offer.priceCents,
    etaMinutes: offer.etaMinutes,
  }
}
