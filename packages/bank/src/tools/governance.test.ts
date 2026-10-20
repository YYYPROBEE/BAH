/**
 * 治理平面 × 七段管线（施工单 08 §6 的 T-TOOLS-001~004）。
 *
 * 断言口径：只看看得见的东西——会话事件序列、票据状态、审计事件、工具结果。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId } from '@bah/test-support'
import type { TicketId } from '@bah/core'

import { createPipelineHarness, TEST_CONFIG } from './testing.ts'
import { VerifyService } from '../verify/index.ts'

/** 800 元白名单收款人（demo 的王建国）。 */
const TRANSFER_800 = {
  amount: 800,
  payee: { name: '王建国', phone: '13900002222' },
  remark: '房租',
}

/** 取某类会话事件的载荷。 */
function payloads(
  harness: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return harness
    .events()
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>)
}

/** 取某类领域审计事件的载荷（harness 的内存审计出口）。 */
function auditPayloads(
  harness: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return harness.audits
    .filter((record) => record.type === type)
    .map((record) => record.data as Record<string, unknown>)
}

describe('T-TOOLS-001 绿级直行', () => {
  it('account_balance 无审批直接执行，落 read/balance 卡片数据', async () => {
    const h = createPipelineHarness()
    try {
      const execution = await h.run('account_balance')

      expect(execution.result.isError).toBe(false)
      expect(execution.result.code).toBeUndefined()
      expect(payloads(h, 'approval/asked')).toHaveLength(0)
      expect(auditPayloads(h, 'read/balance')).toHaveLength(1)
      expect(h.audits.map((record) => record.type)).toEqual(['tier/decided', 'read/balance'])
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        name: 'account_balance',
        level: 'green',
        verdict: 'allow',
      })
      expect(h.events().map((event) => event.type)).toEqual(['tool/call', 'tool/result'])
      expect(payloads(h, 'tool/call')[0]).toMatchObject({
        name: 'account_balance',
        tier: { level: 'green' },
      })
    } finally {
      await h.dispose()
    }
  })
})

describe('T-TOOLS-002 黄级票据', () => {
  it('800 元白名单：ask + 票据签发 → 批准 → 核销 → 转账成功', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('transfer_create', TRANSFER_800)

      expect(execution.result.isError).toBe(false)
      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ name: 'transfer_create', amount: 800 })
      expect(asked[0]?.['challenge']).toBeUndefined()
      expect(payloads(h, 'approval/decided')[0]?.decision).toBe('allowed-once')
      expect(h.core.tickets.size).toBe(1)
      expect(h.core.tickets.status('ticket:c-1' as TicketId)).toBe('redeemed')
      expect(auditPayloads(h, 'transfer/created')).toHaveLength(1)
      expect(auditPayloads(h, 'transfer/created')[0]?.result).toMatchObject({ amountCents: 80_000 })
    } finally {
      await h.dispose()
    }
  })
})

describe('T-TOOLS-003 日累计升红', () => {
  it('当日累计含本笔 > 上限（6,000 元）：ask + 强验证挑战 sms', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('transfer_create', {
        amount: 6_000,
        payee: { name: '王建国', phone: '13900002222' },
      })

      expect(execution.result.isError).toBe(false)
      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(1)
      expect(asked[0]?.['challenge']).toBe(TEST_CONFIG.redChallenge)
      expect(h.core.tickets.status('ticket:c-1' as TicketId)).toBe('redeemed')
    } finally {
      await h.dispose()
    }
  })
})

describe('T-TOOLS-004 新收款人升红', () => {
  it('新收款人 100 元也走红级挑战', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('transfer_create', {
        amount: 100,
        payee: { name: '韩梅梅' },
      })
      expect(execution.result.isError).toBe(false)
      expect(payloads(h, 'approval/asked')[0]?.['challenge']).toBe(TEST_CONFIG.redChallenge)
    } finally {
      await h.dispose()
    }
  })
})

describe('审批失败路径', () => {
  it('无人应答：unavailable → deny，工具体不执行、票据 blocked', async () => {
    const h = createPipelineHarness()
    try {
      const execution = await h.run('transfer_create', TRANSFER_800)

      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('approval-unavailable')
      expect(h.core.tickets.status('ticket:c-1' as TicketId)).toBe('blocked')
      expect(auditPayloads(h, 'transfer/created')).toHaveLength(0)
      expect(h.audits.some((record) => record.type === 'transfer/created')).toBe(false)
    } finally {
      await h.dispose()
    }
  })

  it('用户拒绝：rejected → deny，票据 blocked', async () => {
    const h = createPipelineHarness({ approval: 'rejected' })
    try {
      const execution = await h.run('transfer_create', TRANSFER_800)
      expect(execution.result.code).toBe('approval-rejected')
      expect(h.core.tickets.status('ticket:c-1' as TicketId)).toBe('blocked')
      expect(payloads(h, 'approval/decided')[0]?.decision).toBe('rejected')
    } finally {
      await h.dispose()
    }
  })

  it('未绑定身份：pre-execute 直接 deny no-identity（不进入审批）', async () => {
    const h = createPipelineHarness({ userId: null })
    try {
      const execution = await h.run('account_balance')
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('no-identity')
      expect(payloads(h, 'approval/asked')).toHaveLength(0)
      // 判决本身仍要落审计（谁在什么时候被拒、理由码是什么）
      expect(h.audits.map((record) => record.type)).toEqual(['tier/decided'])
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        verdict: 'deny',
        code: 'no-identity',
      })
    } finally {
      await h.dispose()
    }
  })

  it('参数非法 / 余额不足：执行前拒绝（不签发票据）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const badArgs = await h.run('transfer_create', { amount: -1, payee: { name: 'x' } })
      expect(badArgs.result.code).toBe('tool-args-invalid')

      const poor = await h.run('transfer_create', {
        amount: 20_000,
        payee: { name: '王建国', phone: '13900002222' },
      })
      expect(poor.result.code).toBe('insufficient-balance')
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it('安全层先拒（sentry-*）时补声明级 tier/decided：bank 审计链不缺口', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      // 模拟 sentry 在 bank 评估前叠加拒绝：注册在治理平面之后 = waterfall 内层
      h.ctx.events.on('tools/pre-execute', async (input, next) => {
        await next(input)
        return {
          ...input,
          verdict: { kind: 'deny', code: 'sentry-degraded', reason: '会话已降级为只绿模式' },
        }
      })

      const execution = await h.run('transfer_create', TRANSFER_800)
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('sentry-degraded')
      expect(auditPayloads(h, 'tier/decided')).toEqual([
        expect.objectContaining({
          callId: 'c-1',
          name: 'transfer_create',
          level: 'yellow',
          reason: 'declared',
          verdict: 'deny',
          code: 'sentry-degraded',
        }),
      ])
      expect(payloads(h, 'approval/asked')).toHaveLength(0)
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it('T-VER-003 锁定期红级：pre-execute deny verify-locked，票据一张都不签', async () => {
    const verify = new VerifyService({
      provider: { verify: async () => ({ success: false }) },
      maxAttempts: 3,
      lockMs: 30 * 60 * 1000,
      now: () => 1_792_000_000_000,
    })
    const h = createPipelineHarness({ approval: 'allowed-once', verify })
    try {
      const sessionId = asSessionId('s-bank-pipe')
      const challenge = verify.issue(sessionId, 'sms')
      // 三连败把会话锁住
      await verify.submit(sessionId, challenge.id, 'sms')
      await verify.submit(sessionId, challenge.id, 'sms')
      const third = await verify.submit(sessionId, challenge.id, 'sms')
      expect(third.justLocked).toBe(true)

      const execution = await h.run('transfer_create', {
        amount: 6_000,
        payee: { name: '王建国', phone: '13900002222' },
      })
      expect(execution.result.code).toBe('verify-locked')
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })
})
