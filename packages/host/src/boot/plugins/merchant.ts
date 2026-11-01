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
  commitOffer,
  merchantCategoryOf,
  orderOffer,
  releaseOffer,
  reserveOffer,
  searchOffers,
  type CardSpendResult,
  type MerchantCommitResult,
  type MerchantFault,
  type MerchantOffer,
  type MerchantReservation,
  type OfferCategory,
  type MerchantConstraints,
} from '@bah/bank'
import { BahError } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { readBoolean, readEnum, rejectUnknownKeys } from '../config.ts'
import { BANK_CARD_SPEND } from './bank-tools.ts'

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
  /** 涨价降级时的事实（分）：用户批准价 vs 唤醒时预占价（ADR-0013）。 */
  readonly price?: {
    readonly approvedCents: number
    readonly currentCents: number
  }
}

/** 预占结论（先订后付的"订"；**不产生任何资金动作**）。 */
export type MerchantReserveOutcome =
  | {
      readonly ok: true
      readonly attempts: readonly MerchantAttempt[]
      readonly reservation: MerchantReservation
    }
  | { readonly ok: false; readonly attempts: readonly MerchantAttempt[] }

/** 提交结论（把预占转成成交）。 */
export type MerchantCommitOutcome =
  | {
      readonly ok: true
      readonly attempts: readonly MerchantAttempt[]
      readonly order: {
        readonly orderId: string
        readonly offerId: string
        readonly merchantName: string
        readonly totalCents: number
      }
    }
  | { readonly ok: false; readonly attempts: readonly MerchantAttempt[] }

/** 商户服务（窄面：搜索 + 履约 + 只读查价 + 两阶段预占）。 */
export interface MerchantService {
  readonly search: (constraints: MerchantConstraints, sessionKey: string) => readonly MerchantOffer[]
  /**
   * 按 `offerId` 只读查当前报价（含演示故障开关后的生效价）。
   *
   * **不是 `search` 的别名**：`search` 会把结果写进"本会话搜过"的引用闭包，
   * 让该 offer 之后可以被 `fulfil` 下单。审批明细只需要**读价**，绝不能顺手把
   * 一个没搜过的 offer 变成可下单——那等于开了一个绕过引用闭包的后门。
   */
  readonly offer: (offerId: string) => MerchantOffer | undefined
  /** 本会话是否搜到过该 offer（引用闭包的只读探针，不改变闭包）。 */
  readonly orderable: (sessionKey: string, offerId: string) => boolean
  /** 下单 + 失败换店（上限 2 家）；`offerId` 不在本会话搜索闭包里即拒。 */
  readonly fulfil: (
    sessionKey: string,
    offerId: string,
    budgetCents: number,
  ) => MerchantFulfilment
  /**
   * 预占（先订后付的"订"）：**不扣款、不成交，也不判预算**。
   *
   * 引用闭包先判（没搜过的 offer 不许预占），再判缺货/超时。
   * 预算与"用户批准价"的比对由调用方做——只有它知道用户批准的是多少钱。
   * `seq` 由调用方给（同一 seq + 同一 offer → 同一 orderId，可幂等）。
   */
  readonly reserve: (
    sessionKey: string,
    offerId: string,
    seq: string,
  ) => MerchantReserveOutcome
  /** 提交（确认成交）：价格变了 / 库存没了就失败，调用方据此冲正银行腿。 */
  readonly commit: (reservation: MerchantReservation) => MerchantCommitOutcome
  /** 释放预占（不成交；mock 语义动作）。 */
  readonly release: (reservation: MerchantReservation) => void
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
        offer: (offerId) =>
          applyFault(MERCHANT_OFFERS, settings.fault).find((offer) => offer.offerId === offerId),
        orderable: (sessionKey, offerId) => seen.get(sessionKey)?.has(offerId) ?? false,
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
        reserve: (sessionKey, offerId, seq) => {
          // 引用闭包先判：没搜过的 offer 连"占位"都不许（否则预占本身就是后门）
          if (!seen.get(sessionKey)?.has(offerId)) {
            return {
              ok: false,
              attempts: [{ offerId, ok: false, code: 'offer-not-searched' }],
            }
          }
          const reserved = reserveOffer(MERCHANT_OFFERS, offerId, settings.fault, seq)
          if (!reserved.ok) {
            return {
              ok: false,
              attempts: [{ offerId, ok: false, code: reserved.code }],
            }
          }
          return {
            ok: true,
            attempts: [{ offerId, ok: true }],
            reservation: reserved.reservation,
          }
        },
        commit: (reservation) => {
          const committed: MerchantCommitResult = commitOffer(
            MERCHANT_OFFERS,
            reservation,
            settings.fault,
          )
          if (!committed.ok) {
            return {
              ok: false,
              attempts: [{ offerId: committed.offerId, ok: false, code: committed.code }],
            }
          }
          return {
            ok: true,
            attempts: [{ offerId: committed.offerId, ok: true }],
            order: {
              orderId: committed.orderId,
              offerId: committed.offerId,
              merchantName: committed.merchantName,
              totalCents: committed.totalCents,
            },
          }
        },
        release: (reservation) => {
          releaseOffer(reservation)
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
                ? { category: record['category'] as OfferCategory }
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
          description:
            '向商户下单（黄档写操作）。必须先用 merchant_search 拿到 offerId（不许自己编）；' +
            '超预算会换店或失败，全程不擅自加价；带 viaCardId 时先扣款再下单，扣款失败不落订单。' +
            '用户明确说“订/买这束花/这个蛋糕”时用；只查商品请用 merchant_search。',
          schema: {
            type: 'object',
            properties: {
              offerId: {
                type: 'string',
                description: 'merchant_search 返回的 offerId（与 category 二选一；有它就按它订）',
              },
              category: {
                type: 'string',
                enum: ['flower', 'cake'],
                description:
                  '品类（没给 offerId 时必填）：flower=鲜花 / cake=蛋糕。系统在本会话按品类+预算搜一次再订第一个。',
              },
              budgetYuan: { type: 'number', description: '预算上限（元；超预算换店或失败）' },
              viaCardId: {
                type: 'string',
                description: '用哪张卡支付（可选；给了就先扣款再下单，扣款失败不落订单）',
              },
            },
            required: [],
          },
          tier: { level: 'yellow' },
          sideEffect: 'write',
          execute: async (args) => {
            const record = args as Readonly<Record<string, unknown>>
            const budgetCents =
              typeof record['budgetYuan'] === 'number' &&
              Number.isFinite(record['budgetYuan']) &&
              record['budgetYuan'] > 0
                ? Math.round(record['budgetYuan'] * 100)
                : Number.MAX_SAFE_INTEGER
            const sessionKey = String(run.sessionId)
            let offerId = typeof record['offerId'] === 'string' ? record['offerId'].trim() : ''
            /**
             * 没给 offerId 时按品类现搜一次（2026-11-01）。
             *
             * 用户说"订一束 200 的花"时手里没有 offerId；让他先搜再回传，
             * 等于把一次意图拆成两轮。这里的 search 会正常写进"本会话搜过"闭包，
             * 所以引用闭包没有被绕过——只是把两步合在服务端做。
             */
            if (offerId.length === 0) {
              const rawCategory = record['category']
              if (rawCategory !== 'flower' && rawCategory !== 'cake') {
                throw new BahError(
                  'merchant-invalid',
                  'merchant_order: offerId 与 category 必须给一个',
                  {},
                )
              }
              const offers = service.search({ category: rawCategory, budgetCents }, sessionKey)
              const first = offers[0]
              if (first === undefined) {
                return {
                  status: 'failed',
                  attempts: [{ offerId: '', ok: false, code: 'no-offer' }],
                }
              }
              offerId = first.offerId
            }
            const viaCardId =
              typeof record['viaCardId'] === 'string' ? record['viaCardId'].trim() : ''
            let payment: CardSpendResult | undefined
            if (viaCardId.length > 0) {
              const offer = service.offer(offerId)
              if (offer === undefined) {
                return { status: 'failed', attempts: [{ offerId, ok: false, code: 'unknown-offer' }] }
              }
              // 引用闭包先判：没搜过的 offer 一分钱都不该先扣
              if (!service.orderable(sessionKey, offerId)) {
                return {
                  status: 'failed',
                  attempts: [{ offerId, ok: false, code: 'offer-not-searched' }],
                }
              }
              // 扣款前预检（缺货 / 超时 / 超预算）：避免"扣了钱但下不了单"
              const preflight = orderOffer(MERCHANT_OFFERS, offerId, settings.fault, 0)
              if (!preflight.ok) {
                return {
                  status: 'failed',
                  attempts: [{ offerId, ok: false, code: preflight.code }],
                }
              }
              if (preflight.totalCents > budgetCents) {
                return {
                  status: 'failed',
                  attempts: [{ offerId, ok: false, code: 'over-budget' }],
                }
              }
              let port
              try {
                port = ctx.get(BANK_CARD_SPEND)
              } catch (error) {
                if ((error as { code?: string }).code !== 'service-missing') throw error
                throw new BahError(
                  'card-spend-unavailable',
                  'merchant_order: 未装配 bank:tools，卡消费不可用',
                  {},
                )
              }
              payment = await port.spend(sessionKey, {
                cardId: viaCardId,
                merchantCategory: merchantCategoryOf(offer.merchantName),
                amountCents: preflight.totalCents,
                memo: `${offer.merchantName}·${offer.name}`,
              })
            }
            const fulfilment = service.fulfil(sessionKey, offerId, budgetCents)
            const result = fulfilment.order === undefined
              ? { ...fulfilment, ...(payment === undefined ? {} : { payment }) }
              : {
                  ...fulfilment,
                  order: { ...fulfilment.order, totalYuan: fulfilment.order.totalCents / 100 },
                  ...(payment === undefined ? {} : { payment }),
                }
            // 扣款后没有按预检成交：不许装作"已下单"；退款/补偿归提示词 3
            if (
              payment !== undefined &&
              (fulfilment.status !== 'ok' ||
                fulfilment.order?.offerId !== offerId ||
                fulfilment.order?.totalCents !== payment.amountCents)
            ) {
              return {
                ...result,
                status: 'failed',
                attempts: [
                  ...fulfilment.attempts,
                  { offerId, ok: false, code: 'payment-without-order' },
                ],
              }
            }
            return result
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
