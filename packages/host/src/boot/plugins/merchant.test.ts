/**
 * `bank:merchant`：商户域的宿主接线（G4）。
 *
 * 判据不是"能下单"，而是三条**安全/资金边界**真的成立：
 * - offerId 引用闭包：本会话没搜过的商户一律拒单（模型/执行器不能"点名"）；
 * - 不擅自加价：涨价后的报价超预算就不成交，绝不"先下单再解释"；
 * - 换店有上限：缺货/超时最多试两家，试完如实报失败，不无限重试。
 *
 * 工具面还钉住暴露级别：`merchant_order` 必须是 `internal`（模型看不见），
 * 否则上面的引用闭包会被"直接调工具"绕过。
 */

import { createContext } from '@bah/core'
import { TOOLS_SERVICE, ToolRegistry, provideTools } from '@bah/runtime'
import { asSessionId, captureThrown } from '@bah/test-support'
import { BahError } from '@bah/util'

import { describe, expect, it } from 'vitest'

import type { Context, ToolExecContext } from '@bah/core'
import type { ToolDefinition } from '@bah/runtime'

/** 直接调工具体时管线不在场；ctx 只提供会话/中止信号。 */
const CALL_CTX: ToolExecContext = {
  sessionId: asSessionId('s-merchant'),
  callId: 'c-tool',
  signal: new AbortController().signal,
}

import { RUN_SERVICE } from '../boot.ts'
import { testRunContext } from '../test-run-context.ts'
import {
  DEFAULT_MERCHANT,
  MERCHANT_SERVICE,
  merchantPlugin,
  type MerchantService,
} from './merchant.ts'

interface Harness {
  readonly ctx: Context
  readonly registry: ToolRegistry
  readonly service: MerchantService
}

async function withMerchant(
  config: Readonly<Record<string, unknown>>,
  run: (harness: Harness) => Promise<void> | void,
): Promise<void> {
  const ctx = createContext()
  ctx.provide(RUN_SERVICE, testRunContext({ sessionId: asSessionId('s-merchant') }))
  const registry = new ToolRegistry()
  provideTools(ctx, registry)
  await ctx.use(merchantPlugin.plugin, merchantPlugin.validate(config))
  await ctx.start()
  try {
    await run({ ctx, registry, service: ctx.get(MERCHANT_SERVICE) })
  } finally {
    await ctx.dispose()
  }
}

function toolOf(harness: Harness, name: string): ToolDefinition<unknown, unknown> {
  return harness.registry.get(name)
}

describe('bank:merchant 配置面', () => {
  it('缺省开启且无故障', () => {
    expect(merchantPlugin.validate({})).toEqual(DEFAULT_MERCHANT)
    expect(DEFAULT_MERCHANT).toEqual({ enabled: true, fault: 'none' })
  })

  it('接受合法故障开关', () => {
    expect(merchantPlugin.validate({ fault: 'stockout' })).toEqual({ enabled: true, fault: 'stockout' })
    expect(merchantPlugin.validate({ enabled: false })).toEqual({ enabled: false, fault: 'none' })
  })

  it('服务只读观测口回报当前故障开关', async () => {
    await withMerchant({ fault: 'timeout' }, ({ service }) => {
      expect(service.fault()).toBe('timeout')
    })
  })

  it('未知键与非法枚举值都 fail-loud', () => {
    const unsupported = captureThrown(() => merchantPlugin.validate({ mode: 'x' }))
    expect(unsupported.code).toBe('unknown-config-key')
    const invalidFault = captureThrown(() => merchantPlugin.validate({ fault: 'explode' }))
    expect(invalidFault.code).toBe('invalid-config')
  })
})

describe('merchant_search / merchant_order 工具面', () => {
  it('注册一绿一黄：搜索只读可，下单对模型可见且可只给品类', async () => {
    await withMerchant({}, ({ ctx, registry, service }) => {
      expect(ctx.get(TOOLS_SERVICE).names()).toEqual(['merchant_search', 'merchant_order'])
      const search = toolOf({ ctx, registry, service }, 'merchant_search')
      const order = toolOf({ ctx, registry, service }, 'merchant_order')
      expect(search.tier).toEqual({ level: 'green' })
      expect(search.sideEffect).toBe('none')
      expect(order.tier).toEqual({ level: 'yellow' })
      expect(order.sideEffect).toBe('write')
      /**
       * 2026-11-01：`merchant_order` 从 `exposure:'internal'` 改为模型可。
       *
       * 理由：用户说"帮我订一束花"时手里没有 offerId，内部工具等于这条意图永远不可达。
       * 引用闭包（搜过才可下单）没有放开——只是把"搜"与"订"两步合到一次调用里。
       */
      expect(order.exposure).not.toBe('internal')
      expect(order.schema.required ?? []).not.toContain('offerId')
      expect(Object.keys(order.schema.properties ?? {})).toEqual(
        expect.arrayContaining(['offerId', 'category']),
      )
    })
  })

  it('搜索按品类/预算/时效过滤，budgetYuan 转分且价格升序', async () => {
    await withMerchant({}, async ({ ctx, registry, service }) => {
      const search = toolOf({ ctx, registry, service }, 'merchant_search')
      const result = (await search.execute(
        {
          category: 'cake',
          budgetYuan: 200,
        },
        CALL_CTX,
      )) as { offers: readonly { offerId: string; priceCents: number; category: string }[] }
      expect(result.offers.map((offer) => offer.offerId)).toEqual(['o-cake-e1', 'o-cake-e2'])
      expect(result.offers.every((offer) => offer.category === 'cake')).toBe(true)
      expect(result.offers.every((offer) => offer.priceCents <= 20_000)).toBe(true)
      // 两家 120 分钟的花店被 60 分钟时效过滤掉
      const flowers = (await search.execute(
        { category: 'flower', maxEtaMinutes: 60 },
        CALL_CTX,
      )) as {
        offers: readonly { offerId: string }[]
      }
      expect(flowers.offers.map((offer) => offer.offerId)).toEqual([
        'o-flower-c2',
        'o-flower-b2',
        'o-flower-b1',
        'o-flower-c1',
      ])
    })
  })

  it('merchant_order 缺 offerId 直接拒绝（不落成"空名下单个"）', async () => {
    await withMerchant({}, async ({ ctx, registry, service }) => {
      const order = toolOf({ ctx, registry, service }, 'merchant_order')
      await expect(order.execute({}, CALL_CTX)).rejects.toBeInstanceOf(BahError)
      await expect(order.execute({}, CALL_CTX)).rejects.toMatchObject({ code: 'merchant-invalid' })
      await expect(order.execute({ offerId: 42 }, CALL_CTX)).rejects.toMatchObject({
        code: 'merchant-invalid',
      })
    })
  })

  it('只给品类：服务端现搜后下单，引用闭包仍生效（别的会话不可复用）', async () => {
    await withMerchant({}, async ({ ctx, registry, service }) => {
      const order = toolOf({ ctx, registry, service }, 'merchant_order')
      // 不先调用 merchant_search：工具体自己按品类+预算搜一次
      const result = (await order.execute({ category: 'cake', budgetYuan: 200 }, CALL_CTX)) as {
        status: string
        order?: { offerId: string; totalCents: number }
      }
      expect(result).toMatchObject({
        status: 'ok',
        order: { offerId: 'o-cake-e1', totalCents: 16_900 },
      })
      // 搜出来的 offer 只写进本会话闭包；其他会话依旧不可下单
      expect(service.orderable('s-merchant', 'o-cake-e1')).toBe(true)
      expect(service.orderable('s-other', 'o-cake-e1')).toBe(false)
    })
  })

  it('只给品类但预算内无候选：如实 no-offer，不编造 offerId', async () => {
    await withMerchant({}, async ({ ctx, registry, service }) => {
      const order = toolOf({ ctx, registry, service }, 'merchant_order')
      const result = (await order.execute({ category: 'cake', budgetYuan: 1 }, CALL_CTX)) as {
        status: string
        attempts: readonly { offerId: string; ok: boolean; code?: string }[]
      }
      expect(result.status).toBe('failed')
      expect(result.attempts).toEqual([{ offerId: '', ok: false, code: 'no-offer' }])
      // 失败不把任何 offer 写进闭包
      expect(service.orderable('s-merchant', 'o-cake-e1')).toBe(false)
    })
  })

  it('搜索入参做入口归一化：非法品类/预算被忽略，excludeMerchants 只留字符串', async () => {
    await withMerchant({}, async ({ ctx, registry, service }) => {
      const search = toolOf({ ctx, registry, service }, 'merchant_search')
      const result = (await search.execute(
        {
          category: 'book',
          budgetYuan: '100',
          maxEtaMinutes: null,
          excludeMerchants: ['m-flower-c', 42],
        },
        CALL_CTX,
      )) as { offers: readonly { offerId: string }[] }
      // 品类/预算/时效都没生效 → 花与蛋糕都在；排除商户生效
      expect(result.offers).toHaveLength(8)
      expect(result.offers.some((offer) => offer.offerId === 'o-flower-c1')).toBe(false)
      expect(result.offers.some((offer) => offer.offerId === 'o-cake-d1')).toBe(true)
    })
  })

  it('工具下单走同一套闭包：先 search 再 order 才成交', async () => {
    await withMerchant({}, async ({ ctx, registry, service }) => {
      const search = toolOf({ ctx, registry, service }, 'merchant_search')
      const order = toolOf({ ctx, registry, service }, 'merchant_order')
      await expect(order.execute({ offerId: 'o-cake-e1' }, CALL_CTX)).resolves.toMatchObject({
        status: 'failed',
      })
      await search.execute({ category: 'cake' }, CALL_CTX)
      await expect(order.execute({ offerId: 'o-cake-e1' }, CALL_CTX)).resolves.toMatchObject({
        status: 'ok',
        order: { offerId: 'o-cake-e1', totalCents: 16_900 },
      })
    })
  })
})

describe('offerId 引用闭包', () => {
  it('目录里存在但本会话没搜过 → 拒单', async () => {
    await withMerchant({}, ({ service }) => {
      service.search({ category: 'flower' }, 's1')
      const result = service.fulfil('s1', 'o-cake-d1', 50_000)
      expect(result.status).toBe('failed')
      expect(result.attempts).toEqual([
        { offerId: 'o-cake-d1', ok: false, code: 'offer-not-searched' },
      ])
      expect(result.order).toBeUndefined()
    })
  })

  it('别的会话搜过不算数（会话隔离）', async () => {
    await withMerchant({}, ({ service }) => {
      service.search({ category: 'flower' }, 's2')
      expect(service.fulfil('s1', 'o-flower-a2', 50_000).status).toBe('failed')
      expect(service.fulfil('s1', 'o-flower-a2', 50_000).attempts[0]?.code).toBe('offer-not-searched')
    })
  })

  it('本会话搜过 → 可下单，金额与商户来自目录', async () => {
    await withMerchant({}, ({ service }) => {
      const offers = service.search({ category: 'flower' }, 's1')
      expect(offers.some((offer) => offer.offerId === 'o-flower-a2')).toBe(true)
      const result = service.fulfil('s1', 'o-flower-a2', 50_000)
      expect(result.status).toBe('ok')
      expect(result.attempts).toEqual([{ offerId: 'o-flower-a2', ok: true }])
      expect(result.order).toMatchObject({
        offerId: 'o-flower-a2',
        merchantName: '青野花艺',
        totalCents: 15_900,
      })
    })
  })
})

describe('不擅自加价：预算硬约束', () => {
  it('原报价超预算 → 同品类换更便宜的，第二次成交记为 fallback', async () => {
    await withMerchant({}, ({ service }) => {
      service.search({ category: 'cake' }, 's1')
      const result = service.fulfil('s1', 'o-cake-d2', 20_000)
      expect(result.status).toBe('fallback')
      expect(result.attempts).toEqual([
        { offerId: 'o-cake-d2', ok: false, code: 'over-budget' },
        { offerId: 'o-cake-e1', ok: true },
      ])
      expect(result.order).toMatchObject({ offerId: 'o-cake-e1', totalCents: 16_900 })
      expect(result.order?.totalCents).toBeLessThanOrEqual(20_000)
    })
  })

  it('没有更便宜的候选 → 如实失败，只尝试原报价', async () => {
    await withMerchant({}, ({ service }) => {
      service.search({ category: 'cake' }, 's1')
      const result = service.fulfil('s1', 'o-cake-e1', 1_000)
      expect(result.status).toBe('failed')
      expect(result.attempts).toEqual([
        { offerId: 'o-cake-e1', ok: false, code: 'over-budget' },
      ])
      expect(result.order).toBeUndefined()
    })
  })

  it('涨价后按新价校验：按原价的预算不再成交，理由如实是 over-budget', async () => {
    await withMerchant({ fault: 'price-up' }, ({ service }) => {
      service.search({ category: 'cake' }, 's1')
      // 小满水果蛋糕原价 169 元，涨 30% 后 219.7 元：200 元预算必须拒
      const result = service.fulfil('s1', 'o-cake-e1', 20_000)
      expect(result.status).toBe('failed')
      expect(result.attempts[0]).toEqual({ offerId: 'o-cake-e1', ok: false, code: 'over-budget' })
    })
  })

  it('涨价在预算内时按涨价后的金额成交（不按旧价记账）', async () => {
    await withMerchant({ fault: 'price-up' }, ({ service }) => {
      service.search({ category: 'cake' }, 's1')
      const result = service.fulfil('s1', 'o-cake-e1', 22_000)
      expect(result.status).toBe('ok')
      expect(result.order?.totalCents).toBe(21_970)
    })
  })
})

describe('换店：缺货 / 超时', () => {
  it('首店缺货 → 同品类换店成交，记为 fallback 并保留失败尝试', async () => {
    await withMerchant({ fault: 'stockout' }, ({ service }) => {
      service.search({ category: 'flower' }, 's1')
      const result = service.fulfil('s1', 'o-flower-a2', 30_000)
      expect(result.status).toBe('fallback')
      expect(result.attempts).toEqual([
        { offerId: 'o-flower-a2', ok: false, code: 'out-of-stock' },
        { offerId: 'o-flower-c2', ok: true },
      ])
      expect(result.order).toMatchObject({ merchantName: '即刻花', totalCents: 12_900 })
    })
  })

  it('换店上限 2 家：全部超时后不再重试，如实失败', async () => {
    await withMerchant({ fault: 'timeout' }, ({ service }) => {
      service.search({ category: 'cake' }, 's1')
      const result = service.fulfil('s1', 'o-cake-e1', 50_000)
      expect(result.status).toBe('failed')
      expect(result.attempts).toEqual([
        { offerId: 'o-cake-e1', ok: false, code: 'merchant-timeout' },
        { offerId: 'o-cake-d1', ok: false, code: 'merchant-timeout' },
      ])
      expect(result.order).toBeUndefined()
    })
  })
})

/* ── ADR-0013：两阶段预占（先订后付） ─────────────────────────────────────── */

describe('两阶段预占（reserve / commit / release）', () => {
  it('reserve 幂等：同 seq + 同 offer → 同 orderId，commit 成交', async () => {
    await withMerchant({}, ({ service }) => {
      service.search({ category: 'flower' }, 's1')
      const first = service.reserve('s1', 'o-flower-a2', 'seq-1')
      const second = service.reserve('s1', 'o-flower-a2', 'seq-1')
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      if (!first.ok || !second.ok) return
      expect(first.reservation.orderId).toBe('mo-seq-1-o-flower-a2')
      expect(second.reservation.orderId).toBe(first.reservation.orderId)
      expect(service.commit(first.reservation)).toMatchObject({
        ok: true,
        order: { offerId: 'o-flower-a2', totalCents: 15_900 },
      })
    })
  })

  it('release 后同一 seq 可以重新预占（mock 语义，不是不可逆占用）', async () => {
    await withMerchant({}, ({ service }) => {
      service.search({ category: 'flower' }, 's1')
      const first = service.reserve('s1', 'o-flower-a2', 'seq-2')
      expect(first.ok).toBe(true)
      if (!first.ok) return
      service.release(first.reservation)
      const second = service.reserve('s1', 'o-flower-a2', 'seq-2')
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.reservation.orderId).toBe(first.reservation.orderId)
      expect(service.commit(second.reservation).ok).toBe(true)
    })
  })

  it('没搜过的 offer 连预占都不许（引用闭包在 reserve 就生效）', async () => {
    await withMerchant({}, ({ service }) => {
      const denied = service.reserve('s1', 'o-flower-a2', 'seq-3')
      expect(denied).toMatchObject({
        ok: false,
        attempts: [{ offerId: 'o-flower-a2', ok: false, code: 'offer-not-searched' }],
      })
    })
  })

  it('缺货在预占就失败：不会先扣钱再发现买不到', async () => {
    await withMerchant({ fault: 'stockout' }, ({ service }) => {
      service.search({ category: 'flower' }, 's1')
      const denied = service.reserve('s1', 'o-flower-a2', 'seq-5')
      expect(denied).toMatchObject({
        ok: false,
        attempts: [{ offerId: 'o-flower-a2', ok: false, code: 'out-of-stock' }],
      })
    })
  })
})
