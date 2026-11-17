/**
 * `fund_lock` 的**票前金额**（治理面 `evaluateCall`）。
 *
 * 为什么单独一组：`fund_lock` 的金额字段是 `amountYuan`，票据却按分值核销。
 * 治理面不把这笔金额算出来，审批卡就是 0 元，工具体带实际分值去核销时
 * `TicketStore.redeem()` 会以 `ticket-binding-mismatch` 拒绝——2026-11-15 的
 * 快照场景实测过这条缺陷。这里钉住三件事：
 * 1. `lock` / `release` 的审批金额 = `amountYuan`，且票据能按实际分值核销；
 * 2. `status` 是只读动作，不签票、也不需要金额；
 * 3. 金额非法时治理面不抢答（不抛错、不签非零票），由工具体 fail-loud。
 */

import { describe, expect, it } from 'vitest'

import { createPipelineHarness, type PipelineHarness } from './testing.ts'

/** 取审批请求的会话事件载荷（与 `governance-cases.test.ts` 同一口径）。 */
function asked(h: PipelineHarness): Record<string, unknown>[] {
  return h
    .events()
    .filter((event) => event.type === 'approval/asked')
    .map((event) => event.data as Record<string, unknown>)
}

describe('资金锁定票前金额（fund_lock）', () => {
  it('lock：审批卡金额 = amountYuan，票据按实际分值核销成功', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('fund_lock', { action: 'lock', amountYuan: 500 })

      expect(execution.result.isError).toBe(false)
      expect(asked(h)[0]).toMatchObject({ name: 'fund_lock', amount: 500 })
      const created = h.audits.filter((record) => record.type === 'transfer/created')
      expect(created).toHaveLength(1)
      expect(created[0]?.data).toMatchObject({ result: { amountCents: 50_000 } })
    } finally {
      await h.dispose()
    }
  })

  it('status：只读动作不签票，也不需要金额', async () => {
    const h = createPipelineHarness()
    try {
      const execution = await h.run('fund_lock', { action: 'status' })

      expect(execution.result.isError).toBe(false)
      expect(asked(h)).toHaveLength(0)
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it('金额非法：治理面不抢答，工具体 fail-loud 且不产生资金流水', async () => {
    const cases: readonly { readonly amountYuan: unknown; readonly code: string }[] = [
      { amountYuan: 0, code: 'tool-args-invalid' },
      { amountYuan: -10, code: 'money-invalid' },
      // 模型把数字写成字符串：治理面只认有限数字，类型错同样交给工具体报
      { amountYuan: '500', code: 'tool-args-invalid' },
    ]
    for (const { amountYuan, code } of cases) {
      const h = createPipelineHarness({ approval: 'allowed-once' })
      try {
        const execution = await h.run('fund_lock', { action: 'lock', amountYuan })

        expect(execution.result.code, `amountYuan=${String(amountYuan)}`).toBe(code)
        // 治理面只做"读得出来就带上"：非法金额不会被算成一张非零票
        expect(asked(h)[0]).toMatchObject({ name: 'fund_lock', amount: 0 })
        expect(h.audits.filter((record) => record.type === 'transfer/created')).toHaveLength(0)
      } finally {
        await h.dispose()
      }
    }
  })
})
