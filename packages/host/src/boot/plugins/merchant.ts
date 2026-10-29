/**
 * `bank:merchant`：商户域的宿主接线（G4）。
 *
 * 三条边界（与方案 §3.3「两处低头」一致）：
 * 1. **商户腿不进 DAG**：`merchant_order` 标记 `exposure:'internal'`，只由唤醒执行器调用；
 * 2. **资金腿仍走银行工具**：付钱是 `transfer_create`（治理面 100% 覆盖），这里只回执货物；
 * 3. **offerId 引用闭包**：下单的 offerId 必须来自**本会话** `merchant_search` 的结果，
 *    执行器不能凭空指定商户（否则"约束过滤"的产品承诺可以绕过）。
 */

import { defineService } from '@bah/core'
import { TOOLS_SERVICE } from '@bah/runtime'
import {
  MERCHANT_OFFERS,
  MERCHANT_FAULTS,
  applyFault,
  orderOffer,
  searchOffers,
  type MerchantCategory,
  type MerchantConstraints,
  type MerchantFault,
  type MerchantOffer,
} from '@bah/bank'
import { BahError } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { readBoolean, readEnum, rejectUnknownKeys } from '../config.ts'

/** 一次履约的尝试（逐条可审计）。 */
export interface MerchantAttempt {
  readonly offerId: string
  readonly ok: boolean
  readonly code?: string
}

/** 履约结论（执行器只记录，不解释）。 */
export interface MerchantFulfilment {
  readonly status: 'ok' | 'fallback' | 'failed'
  readonly order?: {
    readonly orderId: string
    readonly offerId: string
    readonly merchantName: string
    readonly totalCents: number
  }
  readonly attempts: readonly MerchantAttempt[]
}

/** 商户服务（窄面：搜索 + 履约）。 */
export interface MerchantService {
  readonly search: (constraints: MerchantConstraints, sessionKey: string) => readonly MerchantOffer[]
  /** 下单 + 失败换店（上限 2 家）；`offerId` 不在本会话搜索闭包里即拒。 */
  readonly fulfil: (
    sessionKey: string,
    offerId: string,
    budgetCents: number,
  ) => MerchantFulfilment
  /** 当前故障开关（只读观测）。 */
  readonly fault: () => MerchantFault
}

/** 服务键：`bank:merchant`。 */
export const MERCHANT_SERVICE = defineService<MerchantService>('bank:merchant')

/** 配置。 */
export interface MerchantSettings {
  readonly enabled: boolean
  /** 演示故障开关（`none` / `stockout` / `timeout` / `price-up`）。 */
  readonly fault: MerchantFault
}

export const DEFAULT_MERCHANT: MerchantSettings = { enabled: true, fault: 'none' }

const WHERE = 'bank:merchant'

/** 换店上限（含原店）：超过就如实报"没订成"，不无限试。 */
const MAX_MERCHANTS = 2

export const merchantPlugin: HostPlugin<MerchantSettings> = {
  id: 'bank:merchant',

  plugin: {
    name: 'bank:merchant',
    inject: [RUN_SERVICE.id],
    apply(ctx, settings) {
      if (!settings.enabled) return
      const run = ctx.get(RUN_SERVICE)

      /** 会话 → 本会话搜索过的 offerId（引用闭包）。 */
      const seen = new Map<string, Set<string>>()
      let orderSeq = 0

      const service: MerchantService = {
        fault: () => settings.fault,
        search: (constraints, sessionKey) => {
          const offers = searchOffers(applyFault(MERCHANT_OFFERS, settings.fault), constraints)
          const bucket = seen.get(sessionKey) ?? new Set<string>()
          for (const offer of offers) bucket.add(offer.offerId)
          seen.set(sessionKey, bucket)
          return offers
        },
        fulfil: (sessionKey, offerId, budgetCents) => {
          const allowed = seen.get(sessionKey)
          if (allowed === undefined || !allowed.has(offerId)) {
            // 引用闭包：没搜过的商户不许下单（模型/执行器都不能"点名"）
            return { status: 'failed', attempts: [{ offerId, ok: false, code: 'offer-not-searched' }] }
          }
          const attempts: MerchantAttempt[] = []
          const tried = new Set<string>()
          let current = offerId
          for (let round = 0; round < MAX_MERCHANTS; round += 1) {
            orderSeq += 1
            const result = orderOffer(MERCHANT_OFFERS, current, settings.fault, orderSeq)
            if (result.ok && result.totalCents > budgetCents) {
              // 不擅自加价：商户报价超预算一律不成交（涨价后"先下单再解释"是不可接受的）
              attempts.push({ offerId: current, ok: false, code: 'over-budget' })
              const original = MERCHANT_OFFERS.find((offer) => offer.offerId === offerId)
              if (original === undefined) break
              tried.add(current)
              const cheaper = searchOffers(MERCHANT_OFFERS, {
                category: original.category,
                budgetCents,
                excludeMerchants: [...new Set([...tried].map((id) => MERCHANT_OFFERS.find((o) => o.offerId === id)?.merchantId ?? ''))].filter((id) => id.length > 0),
              }).find((offer) => !tried.has(offer.offerId))
              if (cheaper === undefined) break
              current = cheaper.offerId
              continue
            }
            if (result.ok) {
              attempts.push({ offerId: current, ok: true })
              return {
                status: attempts.length === 1 ? 'ok' : 'fallback',
                order: {
                  orderId: result.orderId,
                  offerId: result.offerId,
                  merchantName: result.merchantName,
                  totalCents: result.totalCents,
                },
                attempts,
              }
            }
            attempts.push({ offerId: current, ok: false, code: result.code })
            const original = MERCHANT_OFFERS.find((offer) => offer.offerId === offerId)
            if (result.code === 'unknown-offer' || original === undefined) break
            tried.add(current)
            // 缺货 / 超时 → 换一家（同品类、预算内、排除已试）
            const alternative = searchOffers(
              applyFault(MERCHANT_OFFERS, settings.fault),
              {
                category: original.category,
                budgetCents,
                excludeMerchants: [...new Set([...tried].map((id) => MERCHANT_OFFERS.find((o) => o.offerId === id)?.merchantId ?? ''))].filter((id) => id.length > 0),
              },
            ).find((offer) => !tried.has(offer.offerId))
            if (alternative === undefined) break
            current = alternative.offerId
          }
          return { status: 'failed', attempts }
        },
      }

      ctx.effect(ctx.provide(MERCHANT_SERVICE, service))
      ctx.effect(() => seen.clear())

      // 工具：搜索（模型可见、只读）与下单（内部，仅执行器）
      const registry = ctx.get(TOOLS_SERVICE)
      ctx.effect(
        registry.register({
          name: 'merchant_search',
          description:
            '在商户目录里按品类/预算/时效搜索可订商品（只读，mock 商户）。返回的 offerId 是下单的唯一凭据；' +
            '不要自己编 offerId。',
          schema: {
            type: 'object',
            properties: {
              category: { type: 'string', enum: ['flower', 'cake'], description: '品类' },
              budgetYuan: { type: 'number', description: '预算上限（元）' },
              maxEtaMinutes: { type: 'number', description: '最长送达时间（分钟）' },
              excludeMerchants: { type: 'array', items: { type: 'string' }, description: '排除的商户 id' },
            },
          },
          tier: { level: 'green' },
          sideEffect: 'none',
          execute: async (args) => {
            const record = args as Readonly<Record<string, unknown>>
            const constraints: MerchantConstraints = {
              ...(record['category'] === 'flower' || record['category'] === 'cake'
                ? { category: record['category'] as MerchantCategory }
                : {}),
              ...(typeof record['budgetYuan'] === 'number'
                ? { budgetCents: Math.round(record['budgetYuan'] * 100) }
                : {}),
              ...(typeof record['maxEtaMinutes'] === 'number'
                ? { maxEtaMinutes: record['maxEtaMinutes'] }
                : {}),
              ...(Array.isArray(record['excludeMerchants'])
                ? {
                    excludeMerchants: record['excludeMerchants'].filter(
                      (item): item is string => typeof item === 'string',
                    ),
                  }
                : {}),
            }
            return { offers: service.search(constraints, String(run.sessionId)) }
          },
        }),
      )
      ctx.effect(
        registry.register({
          name: 'merchant_order',
          description: '向商户下单（内部工具；不暴露给模型）。',
          schema: {
            type: 'object',
            properties: { offerId: { type: 'string', description: 'merchant_search 返回的 offerId' } },
            required: ['offerId'],
          },
          tier: { level: 'yellow' },
          sideEffect: 'write',
          exposure: 'internal',
          execute: async (args) => {
            const record = args as Readonly<Record<string, unknown>>
            const offerId = typeof record['offerId'] === 'string' ? record['offerId'] : ''
            if (offerId.length === 0) {
              throw new BahError('merchant-invalid', 'merchant_order: offerId 必填', {})
            }
            return service.fulfil(String(run.sessionId), offerId, Number.MAX_SAFE_INTEGER)
          },
        }),
      )
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['enabled', 'fault'], WHERE)
    return {
      enabled: readBoolean(config, 'enabled', WHERE, DEFAULT_MERCHANT.enabled),
      fault: readEnum(config, 'fault', WHERE, MERCHANT_FAULTS) ?? DEFAULT_MERCHANT.fault,
    }
  },
}
