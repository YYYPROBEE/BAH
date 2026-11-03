/**
 * 赎回的**票前金额**权威（治理面 `checkWealthRedeem`）。
 *
 * 为什么单独一组：`wealth_redeem` 是红级写操作，票据上绑的金额必须等于本次真要赎回的额，
 * 否则执行时 `TicketStore.redeem` 会以 `ticket-binding-mismatch` 拒绝——而更坏的方向是
 * 治理面把"缺省=全额赎回"读错，签出一张与用户批准内容不符的票。
 * 台账上这个函数只有成功路径被执行过，三条拒绝臂（没给定位键 / 持仓不存在 / 金额越界）
 * 与 productId 命中那条路都是黑的；`wealth.test.ts` 里仅有一条"不报错"的粗探针。
 *
 * 判据口径与 `governance-cases.test.ts` 一致：**拒绝必须发生在签发之前**，
 * 即 `approval/asked` 不产生、票据表为空。
 */

import { describe, expect, it } from 'vitest'

import { bankIds } from '../core/index.ts'
import { createPipelineHarness, type PipelineHarness } from './testing.ts'

/** 取审批请求的会话事件载荷（与 `governance-cases.test.ts` 同一口径）。 */
function asked(h: PipelineHarness): Record<string, unknown>[] {
  return h
    .events()
    .filter((event) => event.type === 'approval/asked')
    .map((event) => event.data as Record<string, unknown>)
}

/** 演示账本里第一条持仓（市值与 ID 都从 core 现读，不写死）。 */
async function firstHolding(h: PipelineHarness) {
  const holdings = await h.core.listHoldings(bankIds.user('u-1'))
  const holding = holdings[0]
  if (holding === undefined) throw new Error('夹具账本没有持仓，赎回用例无从谈起')
  return holding
}

describe('赎回票前金额（checkWealthRedeem）', () => {
  it('holdingId 与 productId 都没给 ⇒ tool-args-invalid，且不签票据', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('wealth_redeem', {})
      expect(execution.result.code).toBe('tool-args-invalid')
      expect(asked(h)).toHaveLength(0)
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it('持仓不存在 ⇒ holding-unknown（不能按"全额赎回 0 元"签一张空票）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('wealth_redeem', { holdingId: 'h-does-not-exist' })
      expect(execution.result.code).toBe('holding-unknown')
      expect(asked(h)).toHaveLength(0)
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it('只给 productId：按产品命中持仓，票据金额 = 该持仓市值（缺省=全额赎回读的是 core）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const holding = await firstHolding(h)
      const execution = await h.run('wealth_redeem', { productId: holding.productId })

      expect(execution.result.isError).toBe(false)
      expect(asked(h)[0]).toMatchObject({
        name: 'wealth_redeem',
        amount: holding.marketValueCents / 100,
        challenge: 'sms',
      })
      // 用户批准的额与实际赎回的额必须同源：票据绑的是 core 的市值，不是猜出来的
      const redeemed = h.audits.filter((record) => record.type === 'wealth/redeemed')
      expect(redeemed).toHaveLength(1)
      expect((redeemed[0]?.data as Record<string, unknown>)?.result).toMatchObject({
        amountCents: holding.marketValueCents,
      })
    } finally {
      await h.dispose()
    }
  })

  it('部分赎回：票据金额用给定的 amountYuan，市值只当上限看', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const holding = await firstHolding(h)
      const partCents = Math.floor(holding.marketValueCents / 2 / 100) * 100
      const execution = await h.run('wealth_redeem', {
        holdingId: holding.id,
        amountYuan: partCents / 100,
      })

      expect(execution.result.isError).toBe(false)
      expect(asked(h)[0]).toMatchObject({ name: 'wealth_redeem', amount: partCents / 100 })
    } finally {
      await h.dispose()
    }
  })

  it('赎回金额超过持仓市值 ⇒ 拒绝（票据不能大过用户真正拥有的东西）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const holding = await firstHolding(h)
      const execution = await h.run('wealth_redeem', {
        holdingId: holding.id,
        amountYuan: (holding.marketValueCents + 100_000) / 100,
      })
      expect(execution.result.code).toBe('holding-amount-invalid')
      expect(asked(h)).toHaveLength(0)
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it('赎回金额不是正数 ⇒ 拒签：0 走语义闸，负数先被金额单位闸拦下', async () => {
    // 两道闸的次序是事实：`yuanToCents` 在换算处就拒绝负数，异常由本函数的 catch
    // 归一成结构化码（`money-invalid`），不会被吞成"允许"。
    const cases: readonly { readonly amountYuan: number; readonly code: string }[] = [
      { amountYuan: 0, code: 'holding-amount-invalid' },
      { amountYuan: -10, code: 'money-invalid' },
    ]
    for (const { amountYuan, code } of cases) {
      const h = createPipelineHarness({ approval: 'allowed-once' })
      try {
        const holding = await firstHolding(h)
        const execution = await h.run('wealth_redeem', { holdingId: holding.id, amountYuan })
        expect(execution.result.code, `amountYuan=${String(amountYuan)}`).toBe(code)
        expect(asked(h)).toHaveLength(0)
        expect(h.core.tickets.size).toBe(0)
      } finally {
        await h.dispose()
      }
    }
  })
})
