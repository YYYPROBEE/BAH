/**
 * 卡消费通道的宿主接线（B-03）。
 *
 * 两条判据：
 * 1. `merchant_order(viaCardId)` 的**扣款先于下单**，且扣款失败/未搜过/缺货超时不落订单；
 * 2. 卡消费探针的身份只来自会话——调用方不能传 userId（跨会话刷别人的卡不成立）。
 *
 * 这里用可控的 `BANK_CARD_SPEND` 桩：真实扣款与账本断言在
 * `packages/bank/src/core/mock.card-limits.test.ts`（同一个 core 方法）。
 */

import { createContext } from '@bah/core'
import { TOOLS_SERVICE, ToolRegistry, provideTools } from '@bah/runtime'
import { asSessionId } from '@bah/test-support'
import { BahError } from '@bah/util'

import { describe, expect, it } from 'vitest'

import type { Context, ToolExecContext } from '@bah/core'
import type { BankAudit, CardSpendResult, MerchantFault } from '@bah/bank'
import type { ToolDefinition } from '@bah/runtime'

import { bankIds } from '@bah/bank'

import { BANK_CARD_SPEND, createCardSpendProbe, type CardSpendProbeReq } from './bank-tools.ts'
import { merchantPlugin } from './merchant.ts'
import { RUN_SERVICE } from '../boot.ts'
import { testRunContext } from '../test-run-context.ts'

const SESSION = asSessionId('s-card-spend')

/** 直接调工具体时管线不在场；ctx 只提供会话/中止信号。 */
const CALL_CTX: ToolExecContext = {
  sessionId: SESSION,
  callId: 'c-card-spend',
  signal: new AbortController().signal,
}

interface RecordingPort {
  readonly calls: { readonly sessionId: string; readonly req: CardSpendProbeReq }[]
  spend(sessionId: string, req: CardSpendProbeReq): Promise<CardSpendResult>
}

function createRecordingPort(behaviour: 'ok' | 'fail' = 'ok'): RecordingPort {
  const calls: { readonly sessionId: string; readonly req: CardSpendProbeReq }[] = []
  return {
    calls,
    spend: async (sessionId, req) => {
      calls.push({ sessionId, req })
      if (behaviour === 'fail') {
        throw new BahError('card-restricted', '尾号 5678 的卡已限制线上交易', {})
      }
      const balanceCents = 1_234_567 - req.amountCents
      return {
        cardId: bankIds.card(req.cardId),
        tail: '5678',
        txnId: bankIds.txn(`t-card-${String(calls.length)}`),
        merchantCategory: req.merchantCategory,
        amountCents: req.amountCents,
        ...(req.memo === undefined ? {} : { memo: req.memo }),
        dailyUsedCents: req.amountCents,
        dailyLimitCents: 200_000,
        monthlyUsedCents: req.amountCents,
        monthlyLimitCents: 800_000,
        balanceCents,
        availableCents: balanceCents,
        at: 1,
      }
    },
  }
}

async function withMerchant(
  options: { fault?: MerchantFault; port: RecordingPort },
  run: (harness: { ctx: Context; registry: ToolRegistry; port: RecordingPort }) => Promise<void> | void,
): Promise<void> {
  const ctx = createContext()
  ctx.provide(RUN_SERVICE, testRunContext({ sessionId: SESSION }))
  ctx.provide(BANK_CARD_SPEND, options.port)
  const registry = new ToolRegistry()
  provideTools(ctx, registry)
  await ctx.use(merchantPlugin.plugin, merchantPlugin.validate({ fault: options.fault ?? 'none' }))
  await ctx.start()
  try {
    await run({ ctx, registry, port: options.port })
  } finally {
    await ctx.dispose()
  }
}

function orderTool(registry: ToolRegistry): ToolDefinition<unknown, unknown> {
  return registry.get('merchant_order')
}

describe('merchant_order(viaCardId)：扣款先于下单', () => {
  it('成交：扣款金额 = 商户报价，回执带 payment', async () => {
    const port = createRecordingPort('ok')
    await withMerchant({ port }, async ({ registry, port: recorded }) => {
      const search = registry.get('merchant_search')
      await search.execute({ category: 'cake' }, CALL_CTX)
      const result = (await orderTool(registry).execute(
        { offerId: 'o-cake-d1', budgetYuan: 300, viaCardId: 'c-2' },
        CALL_CTX,
      )) as { status: string; order?: { totalCents: number }; payment?: CardSpendResult }

      expect(result.status).toBe('ok')
      expect(result.order?.totalCents).toBe(22_900)
      expect(result.payment).toMatchObject({
        amountCents: 22_900,
        merchantCategory: 'dining',
        cardId: 'c-2',
      })
      expect(recorded.calls).toHaveLength(1)
      expect(recorded.calls[0]?.req).toMatchObject({
        cardId: 'c-2',
        amountCents: 22_900,
        merchantCategory: 'dining',
      })
    })
  })

  it('扣款失败：工具体抛错，不返回订单（下单调用在扣款之后）', async () => {
    const port = createRecordingPort('fail')
    await withMerchant({ port }, async ({ registry }) => {
      const search = registry.get('merchant_search')
      await search.execute({ category: 'cake' }, CALL_CTX)
      const error = await orderTool(registry)
        .execute({ offerId: 'o-cake-d1', budgetYuan: 300, viaCardId: 'c-2' }, CALL_CTX)
        .then(
          () => undefined,
          (reason: unknown) => reason,
        )
      expect(error).toMatchObject({ code: 'card-restricted' })
      expect(port.calls).toHaveLength(1)
    })
  })

  it('只给品类 + viaCardId：服务端现搜写入闭包后再扣款，订单金额与扣款同价', async () => {
    const port = createRecordingPort('ok')
    await withMerchant({ port }, async ({ registry, port: recorded }) => {
      const result = (await orderTool(registry).execute(
        { category: 'cake', budgetYuan: 200, viaCardId: 'c-2' },
        CALL_CTX,
      )) as {
        status: string
        order?: { offerId: string; totalCents: number }
        payment?: { amountCents: number }
      }

      expect(result.status).toBe('ok')
      expect(result.order).toMatchObject({ offerId: 'o-cake-e1', totalCents: 16_900 })
      expect(result.payment?.amountCents).toBe(16_900)
      expect(recorded.calls).toHaveLength(1)
      expect(recorded.calls[0]?.req).toMatchObject({ cardId: 'c-2', amountCents: 16_900 })
    })
  })

  it('没搜过的 offer：一分钱都不先扣', async () => {
    const port = createRecordingPort('ok')
    await withMerchant({ port }, async ({ registry, port: recorded }) => {
      const result = (await orderTool(registry).execute(
        { offerId: 'o-cake-d1', viaCardId: 'c-2' },
        CALL_CTX,
      )) as { status: string; attempts: readonly { code?: string }[] }
      expect(result.status).toBe('failed')
      expect(result.attempts[0]?.code).toBe('offer-not-searched')
      expect(recorded.calls).toHaveLength(0)
    })
  })

  it('缺货：扣款前预检即失败，不扣钱', async () => {
    const port = createRecordingPort('ok')
    await withMerchant({ port, fault: 'stockout' }, async ({ registry, port: recorded }) => {
      const search = registry.get('merchant_search')
      await search.execute({ category: 'flower' }, CALL_CTX)
      const result = (await orderTool(registry).execute(
        { offerId: 'o-flower-a2', viaCardId: 'c-2' },
        CALL_CTX,
      )) as { status: string; attempts: readonly { code?: string }[] }
      expect(result.status).toBe('failed')
      expect(result.attempts[0]?.code).toBe('out-of-stock')
      expect(recorded.calls).toHaveLength(0)
    })
  })

  it('不带 viaCardId：零扣款，原有下单路径逐字不变', async () => {
    const port = createRecordingPort('ok')
    await withMerchant({ port }, async ({ registry, port: recorded }) => {
      const search = registry.get('merchant_search')
      await search.execute({ category: 'cake' }, CALL_CTX)
      const result = (await orderTool(registry).execute(
        { offerId: 'o-cake-e1', budgetYuan: 200 },
        CALL_CTX,
      )) as { status: string; order?: { offerId: string } }
      expect(result.status).toBe('ok')
      expect(result.order?.offerId).toBe('o-cake-e1')
      expect(recorded.calls).toHaveLength(0)
    })
  })
})

describe('createCardSpendProbe：身份只从会话解析', () => {
  it('未绑定会话 ⇒ no-identity（扣款函数一次都不调用）', async () => {
    let called = 0
    const audit: BankAudit = { append: () => {} }
    const probe = createCardSpendProbe({
      spend: async () => {
        called += 1
        throw new Error('不可达')
      },
      resolveUserId: () => undefined,
      audit,
    })
    const error = await probe
      .spend('s-anon', { cardId: 'c-1', merchantCategory: 'coffee', amountCents: 1_000 })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      )
    expect(error).toMatchObject({ code: 'no-identity' })
    expect(called).toBe(0)
  })

  it('已绑定 ⇒ userId 由解析器注入，落 card/spent 事件', async () => {
    const events: { type: string; data: unknown }[] = []
    const audit: BankAudit = { append: (type, data) => events.push({ type, data }) }
    const probe = createCardSpendProbe({
      spend: async (req) => ({
        cardId: req.cardId,
        tail: '1234',
        txnId: bankIds.txn('t-port-1'),
        merchantCategory: req.merchantCategory,
        amountCents: req.amountCents,
        dailyUsedCents: req.amountCents,
        dailyLimitCents: 100_000,
        monthlyUsedCents: req.amountCents,
        monthlyLimitCents: 2_000_000,
        balanceCents: 0,
        availableCents: 0,
        at: 7,
      }),
      resolveUserId: () => 'u-1',
      audit,
    })
    const result = await probe.spend('s-bound', {
      cardId: 'c-1',
      merchantCategory: 'coffee',
      amountCents: 6_800,
    })
    expect(result.txnId).toBe('t-port-1')
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('card/spent')
    expect(events[0]?.data).toMatchObject({
      cardId: 'c-1',
      tail: '1234',
      txnId: 't-port-1',
      merchantCategory: 'coffee',
      amountCents: 6_800,
      at: 7,
    })
  })
})
