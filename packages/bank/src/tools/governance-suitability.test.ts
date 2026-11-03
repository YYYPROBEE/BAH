/**
 * 适当性闸门的两条拒绝分支（治理面 `checkWealthPurchase`）。
 *
 * 购买理财的判决顺序是：**参数 → 产品存在 → 起投额 → 客户主体存在 → 风险等级匹配**，
 * 全部在签发票据之前。这一组用例钉两条最近合入却没人测的拒绝臂：
 * 1. 身份能解析但账本里没有这个客户（`user-unknown`）——不能因为"读不到等级"就当低风险放行；
 * 2. 客户等级低于产品等级（`suitability-mismatch`）——治理面必须自己拦一次，
 *    而不是等核心 `purchaseWealth` 的第二道闸门（那是 `mock.purchase-gate.test.ts` 的职责）。
 *
 * 两条都必须**不签票据、不发审批**：一旦先签发再拒绝，用户会看到一张永远核销不掉的待批单。
 */

import { describe, expect, it } from 'vitest'

import { createPipelineHarness } from './testing.ts'

/** 取会话事件载荷。 */
function payloads(
  h: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return h
    .events()
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>)
}

describe('理财购买的适当性拒绝（签发之前）', () => {
  it('身份能解析但账本没有该客户 ⇒ user-unknown，不签票据不发审批', async () => {
    const h = createPipelineHarness({ userId: 'ghost-user', approval: 'allowed-once' })
    try {
      // w-1 的起投额与金额都合规：拒绝只能来自"客户主体读不到"这一条
      const execution = await h.run('wealth_purchase', { productId: 'w-1', amount: 100 })
      expect(execution.result.code).toBe('user-unknown')
      expect(execution.result.isError).toBe(true)
      expect(h.core.tickets.size).toBe(0)
      expect(payloads(h, 'approval/asked')).toHaveLength(0)
      expect(payloads(h, 'wealth/purchased')).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('R2 客户买 R4 产品 ⇒ suitability-mismatch，理由码来自等级比对而不是参数错', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('wealth_purchase', { productId: 'w-4', amount: 1_000 })
      expect(execution.result.code).toBe('suitability-mismatch')
      expect(h.core.tickets.size).toBe(0)
      expect(payloads(h, 'approval/asked')).toHaveLength(0)
      expect(payloads(h, 'wealth/purchased')).toHaveLength(0)
      // 同一个人买 R1 产品仍然放行（证明拒绝来自等级比对，不是把整条路径都关死）
      const ok = await h.run('wealth_purchase', { productId: 'w-1', amount: 100 })
      expect(ok.result.isError).toBe(false)
    } finally {
      await h.dispose()
    }
  })
})
