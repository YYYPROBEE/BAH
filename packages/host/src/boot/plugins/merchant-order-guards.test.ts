/**
 * `merchant_order(viaCardId)` 的**资金守卫**（扣款先于下单那条线的回归网）。
 *
 * 为什么这组用例比"下单成功"更重要：这条路径先扣钱、后下单。任何一条守卫被改松，
 * 表现都不是报错，而是**用户被扣了钱、回执却说没订成 / 或订成了别的价**。
 * 现有 `merchant-card-spend.test.ts` 只钉了成功、扣款失败、没搜过、缺货四种情形；
 * 这里补的是剩余四条不可达路径与两阶段提交的失败映射。
 *
 * 断言口径统一为「结果码 + 扣款调用次数」：钱有没有动，只认端口收到的调用。
 */

import { createContext } from '@bah/core'
import { ToolRegistry, provideTools } from '@bah/runtime'
import { asSessionId } from '@bah/test-support'

import { describe, expect, it } from 'vitest'

import type { Context, ToolExecContext } from '@bah/core'
import type { CardSpendResult, MerchantFault } from '@bah/bank'
import type { ToolDefinition } from '@bah/runtime'

import { bankIds } from '@bah/bank'

import { BANK_CARD_SPEND, type CardSpendProbeReq } from './bank-tools.ts'
import { MERCHANT_SERVICE, merchantPlugin } from './merchant.ts'
import { RUN_SERVICE } from '../boot.ts'
import { testRunContext } from '../test-run-context.ts'

const SESSION = asSessionId('s-order-guards')

const CALL_CTX: ToolExecContext = {
  sessionId: SESSION,
  callId: 'c-order-guard',
  signal: new AbortController().signal,
}

interface RecordingPort {
  readonly calls: { readonly sessionId: string; readonly req: CardSpendProbeReq }[]
  spend(sessionId: string, req: CardSpendProbeReq): Promise<CardSpendResult>
}

/**
 * 可控扣款端口。
 *
 * `amountDelta` 用来模拟"银行实际扣款与请求金额不一致"（手续费 / 币种舍入）——
 * 这正是 `payment-without-order` 守卫要防的现实输入。
 */
function createRecordingPort(
  behaviour: 'ok' | 'fail' = 'ok',
  options: { readonly amountDelta?: number } = {},
): RecordingPort {
  const calls: { readonly sessionId: string; readonly req: CardSpendProbeReq }[] = []
  return {
    calls,
    spend: async (sessionId, req) => {
      calls.push({ sessionId, req })
      if (behaviour === 'fail') {
        throw new Error('扣款端口不应被调用')
      }
      const chargedCents = req.amountCents + (options.amountDelta ?? 0)
      return {
        cardId: bankIds.card(req.cardId),
        tail: '5678',
        txnId: bankIds.txn(`t-guard-${String(calls.length)}`),
        merchantCategory: req.merchantCategory,
        amountCents: chargedCents,
        ...(req.memo === undefined ? {} : { memo: req.memo }),
        dailyUsedCents: chargedCents,
        dailyLimitCents: 200_000,
        monthlyUsedCents: chargedCents,
        monthlyLimitCents: 800_000,
        balanceCents: 1_234_567 - chargedCents,
        availableCents: 1_234_567 - chargedCents,
        at: 1,
      }
    },
  }
}

async function withMerchant(
  options: {
    readonly fault?: MerchantFault
    readonly port?: RecordingPort
    /** `false` = 模拟 profile 没装 `bank:tools`（卡消费端口缺失）。 */
    readonly providePort?: boolean
  },
  run: (harness: { ctx: Context; registry: ToolRegistry; port?: RecordingPort }) => Promise<void> | void,
): Promise<void> {
  const ctx = createContext()
  ctx.provide(RUN_SERVICE, testRunContext({ sessionId: SESSION }))
  if (options.providePort !== false && options.port !== undefined) {
    ctx.provide(BANK_CARD_SPEND, options.port)
  }
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

describe('merchant_order(viaCardId)：扣款前的守卫', () => {
  it('viaCardId + 不存在的 offer ⇒ unknown-offer，一分钱不扣', async () => {
    const port = createRecordingPort()
    await withMerchant({ port }, async ({ registry }) => {
      const result = (await orderTool(registry).execute(
        { offerId: 'o-ghost', viaCardId: 'c-2' },
        CALL_CTX,
      )) as { status: string; attempts: readonly { code?: string }[] }

      expect(result.status).toBe('failed')
      expect(result.attempts[0]?.code).toBe('unknown-offer')
      expect(port.calls).toHaveLength(0)
    })
  })

  it('viaCardId + 预算低于报价 ⇒ over-budget，一分钱不扣', async () => {
    const port = createRecordingPort()
    await withMerchant({ port }, async ({ registry }) => {
      await registry.get('merchant_search').execute({ category: 'cake' }, CALL_CTX)
      const result = (await orderTool(registry).execute(
        { offerId: 'o-cake-d1', budgetYuan: 100, viaCardId: 'c-2' },
        CALL_CTX,
      )) as { status: string; attempts: readonly { code?: string }[] }

      expect(result.status).toBe('failed')
      expect(result.attempts[0]?.code).toBe('over-budget')
      expect(port.calls).toHaveLength(0)
    })
  })

  it('没装配卡消费端口 ⇒ 抛 card-spend-unavailable（不静默跳过扣款直接下单）', async () => {
    await withMerchant({ providePort: false }, async ({ registry }) => {
      await registry.get('merchant_search').execute({ category: 'cake' }, CALL_CTX)
      const error = await orderTool(registry)
        .execute({ offerId: 'o-cake-d1', budgetYuan: 300, viaCardId: 'c-2' }, CALL_CTX)
        .then(
          () => undefined,
          (reason: unknown) => reason,
        )

      expect(error).toMatchObject({ code: 'card-spend-unavailable' })
    })
  })
})

describe('merchant_order(viaCardId)：扣款后的对账守卫', () => {
  it('扣款金额与成交金额不一致 ⇒ status 强制 failed + payment-without-order（不许装作已下单）', async () => {
    // 端口多扣 1 元：成交 229 元，扣款 230 元——两者对不上就不许报成功
    const port = createRecordingPort('ok', { amountDelta: 100 })
    await withMerchant({ port }, async ({ registry }) => {
      await registry.get('merchant_search').execute({ category: 'cake' }, CALL_CTX)
      const result = (await orderTool(registry).execute(
        { offerId: 'o-cake-d1', budgetYuan: 300, viaCardId: 'c-2' },
        CALL_CTX,
      )) as {
        status: string
        order?: { offerId: string; totalCents: number }
        payment?: CardSpendResult
        attempts: readonly { code?: string }[]
      }

      expect(result.status).toBe('failed')
      expect(result.attempts.map((attempt) => attempt.code)).toContain('payment-without-order')
      // 事实如实保留：订单在、扣款也在，只是不许说"已下单"
      expect(result.order?.offerId).toBe('o-cake-d1')
      expect(result.order?.totalCents).toBe(22_900)
      expect(result.payment?.amountCents).toBe(23_000)
      expect(port.calls).toHaveLength(1)
    })
  })
})

describe('两阶段预占的 commit 失败映射', () => {
  it('价格变了 ⇒ price-changed；offer 不存在 ⇒ unknown-offer（都返回结构化失败，不抛）', async () => {
    await withMerchant({ port: createRecordingPort() }, async ({ ctx, registry }) => {
      await registry.get('merchant_search').execute({ category: 'cake' }, CALL_CTX)
      const service = ctx.get(MERCHANT_SERVICE)
      const reserved = service.reserve(String(SESSION), 'o-cake-d1', 'seq-1')
      if (!reserved.ok) throw new Error(`预占不应失败：${JSON.stringify(reserved.attempts)}`)

      // 预占价被改过（商户在确认时涨价）：提交必须失败，调用方据此冲正银行腿
      const priceChanged = service.commit({
        ...reserved.reservation,
        totalCents: reserved.reservation.totalCents + 1,
      })
      expect(priceChanged).toMatchObject({
        ok: false,
        attempts: [{ offerId: 'o-cake-d1', ok: false, code: 'price-changed' }],
      })

      const unknown = service.commit({ ...reserved.reservation, offerId: 'o-ghost' })
      expect(unknown).toMatchObject({
        ok: false,
        attempts: [{ offerId: 'o-ghost', ok: false, code: 'unknown-offer' }],
      })
    })
  })
})
