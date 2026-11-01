/**
 * 治理平面的边界用例：预检拒绝、票据桥接失败、结果记账。
 *
 * 覆盖的是"正常路径之外"的分支：票据过期、已核销后重复应答、核销前失败、
 * 核心故障、理财预检 —— 这些路径的错误方向必须是**拒绝**，且票据状态可解释。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, createTestContext, fixedClock } from '@bah/test-support'
import { SESSION_SERVICE, provideSession } from '@bah/runtime'
import type { SessionId, TicketId } from '@bah/core'
import { BahError } from '@bah/util'

import type { TransferPreview } from '../core/provider.ts'
import { DEMO_NOW, buildBankDataset } from '../forge/index.ts'
import { MockBankCore } from '../core/index.ts'
import { createDeps, createPipelineHarness, type AuditRecord } from './testing.ts'
import { provideBankGovernance } from './governance.ts'

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

/** 取审计载荷。 */
function auditPayloads(
  h: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return h.audits
    .filter((record) => record.type === type)
    .map((record) => record.data as Record<string, unknown>)
}

describe('理财购买的预检（失败必须在签发前拒绝）', () => {
  it('合法购买：ask + 挑战 → 批准 → 核销，票据金额来自参数', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('wealth_purchase', { productId: 'w-1', amount: 100 })
      expect(execution.result.isError).toBe(false)
      expect(payloads(h, 'approval/asked')[0]).toMatchObject({
        name: 'wealth_purchase',
        amount: 100,
        challenge: 'sms',
      })
      expect(auditPayloads(h, 'wealth/purchased')).toHaveLength(1)
    } finally {
      await h.dispose()
    }
  })

  it('未知产品 / 低于起投额 / 参数非法：都 deny 且不签票据', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const unknown = await h.run('wealth_purchase', { productId: 'w-999', amount: 100 })
      expect(unknown.result.code).toBe('product-unknown')

      const below = await h.run('wealth_purchase', { productId: 'w-3', amount: 1 })
      expect(below.result.code).toBe('below-minimum')

      const invalid = await h.run('wealth_purchase', { productId: 'w-1' })
      expect(invalid.result.code).toBe('tool-args-invalid')

      expect(payloads(h, 'approval/asked')).toHaveLength(0)
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })
})

describe('执行前预检的边界', () => {
  it('身份存在但名下没有账户：account-unknown（预检拒绝，不签票据）', async () => {
    const h = createPipelineHarness({ userId: 'ghost-user' })
    try {
      const execution = await h.run('transfer_create', {
        amount: 100,
        payee: { name: '王建国', phone: '13900002222' },
      })
      expect(execution.result.code).toBe('account-unknown')
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it('核心预检抛错：结构化拒绝（core-down），不把异常漏给模型', async () => {
    class ExplodingCore extends MockBankCore {
      override async previewTransfer(): Promise<TransferPreview> {
        throw new BahError('core-down', '模拟核心故障')
      }
    }
    const core = new ExplodingCore({
      data: buildBankDataset({ seed: 7, tier: 'demo', now: DEMO_NOW }),
      now: () => DEMO_NOW,
    })
    const h = createPipelineHarness({ core })
    try {
      const execution = await h.run('transfer_create', {
        amount: 100,
        payee: { name: '王建国', phone: '13900002222' },
      })
      expect(execution.result.code).toBe('core-down')
      expect(h.core.tickets.size).toBe(0)
    } finally {
      await h.dispose()
    }
  })
})

/** 直接驱动 `approval/request` 的最小上下文（不经过七段管线）。 */
function manualGovernance(record?: (line: string) => void): {
  ctx: ReturnType<typeof createTestContext>['ctx']
  deps: ReturnType<typeof createDeps>['deps']
  clock: ReturnType<typeof fixedClock>
  sessionId: SessionId
  audits: AuditRecord[]
  calls: string[]
  dispose(): Promise<void>
} {
  const test = createTestContext()
  const sessionId = asSessionId('s-manual')
  const clock = fixedClock({ start: DEMO_NOW, step: 10 })
  provideSession(test.ctx, { sessionId, now: clock.now })
  const audits: AuditRecord[] = []
  const { deps } = createDeps({ now: clock.now, audits })
  const calls: string[] = []
  const record0 = record ?? ((line: string) => calls.push(line))
  provideBankGovernance({
    ctx: test.ctx,
    sessionId,
    deps,
    lifecycle: {
      issue: (input) => record0(`issue:${input.ticketId}`),
      approve: (ticketId) => record0(`approve:${ticketId}`),
      redeem: (ticketId) => record0(`redeem:${ticketId}`),
      consume: (ticketId) => record0(`consume:${ticketId}`),
      block: (ticketId, reason) => record0(`block:${ticketId}:${reason}`),
    },
  })
  return { ctx: test.ctx, deps, clock, sessionId, audits, calls, dispose: () => test.dispose() }
}

/** 一条审批请求（金额 1 元）。 */
function approvalInput(
  ticketId: string,
  callId: string,
  expiresAt: number,
): Record<string, unknown> {
  return {
    ticket: { ticketId, fingerprint: 'fp', amount: 1, expiresAt },
    callId,
    name: 'transfer_create',
    summary: { title: '执行 transfer_create', amount: 1, tier: 'yellow' },
    decision: { decision: 'unavailable' },
  }
}

describe('票据桥接的失败方向', () => {
  it('票据签发即过期：unavailable（绝不放行）', async () => {
    const h = manualGovernance()
    try {
      const answered = (await h.ctx.events.waterfall(
        'approval/request',
        approvalInput('ticket:x-expired', 'x-expired', 0) as never,
      )) as unknown as { decision: { decision: string; reason?: string } }
      expect(answered.decision.decision).toBe('unavailable')
      expect(answered.decision.reason).toContain('已过期')
    } finally {
      await h.dispose()
    }
  })

  it('批准时票据已过期：unavailable，票据在 core 里被记事为 blocked', async () => {
    const h = manualGovernance()
    try {
      h.ctx.events.on('approval/request', (payload) => {
        // 下游批准前，票据 TTL 已过（TTL 先于审批超时的等价场景）
        h.clock.advance(10_000)
        return { ...(payload as object), decision: { decision: 'allowed-once' } }
      })
      const expiresAt = h.clock.now() + 5
      const answered = (await h.ctx.events.waterfall(
        'approval/request',
        approvalInput('ticket:x-late', 'x-late', expiresAt) as never,
      )) as unknown as { decision: { decision: string; reason?: string } }
      expect(answered.decision.decision).toBe('unavailable')
      expect(answered.decision.reason).toContain('已过期')
      expect(h.deps.tickets.status('ticket:x-late' as TicketId)).toBe('blocked')
    } finally {
      await h.dispose()
    }
  })

  it('已核销票据上再来一次拒绝：状态机拒绝改写，审批结论照常返回', async () => {
    const h = manualGovernance()
    try {
      const ticketId = 'ticket:x-redeemed' as TicketId
      const binding = {
        sessionId: h.sessionId,
        tool: 'transfer_create',
        fingerprint: 'fp',
        amountCents: 100,
        expiresAt: h.clock.now() + 60_000,
      }
      h.deps.tickets.issue(ticketId, binding, h.clock.now())
      h.deps.tickets.approve(ticketId, h.clock.now())
      h.deps.tickets.redeem({ ticketId, binding }, h.clock.now())

      const answered = (await h.ctx.events.waterfall(
        'approval/request',
        approvalInput(ticketId, 'x-redeemed', binding.expiresAt) as never,
      )) as unknown as { decision: { decision: string } }
      expect(answered.decision.decision).toBe('unavailable')
      expect(h.deps.tickets.status(ticketId)).toBe('redeemed')
    } finally {
      await h.dispose()
    }
  })
})

describe('tools/result 记账', () => {
  it('已批准但未核销 → blocked；未完成审批 → blocked；未知票据 → 忽略', async () => {
    const h = manualGovernance()
    try {
      const approved = 'ticket:t-approved' as TicketId
      const issued = 'ticket:t-issued' as TicketId
      const binding = (id: string) => ({
        sessionId: h.sessionId,
        tool: 'transfer_create',
        fingerprint: id,
        amountCents: 100,
        expiresAt: h.clock.now() + 60_000,
      })
      h.deps.tickets.issue(approved, binding('fp-approved'), h.clock.now())
      h.deps.tickets.approve(approved, h.clock.now())
      h.deps.tickets.issue(issued, binding('fp-issued'), h.clock.now())

      h.ctx.events.emit('tools/result', {
        callId: 't-approved',
        name: 'transfer_create',
        isError: true,
        content: [],
        code: 'tool-failed',
      })
      h.ctx.events.emit('tools/result', {
        callId: 't-issued',
        name: 'transfer_create',
        isError: false,
        content: [],
      })
      // 未知票据：直接忽略（绿色直行没有票据）
      h.ctx.events.emit('tools/result', {
        callId: 't-none',
        name: 'account_balance',
        isError: false,
        content: [],
      })

      // 票据是直接写进 core 的（模拟"批准后进程重启"），账本只在该收尾时收到记账
      expect(h.calls).toEqual([
        `block:${approved}:tool-failed`,
        `block:${issued}:approval-not-completed`,
      ])
      // core 的票据状态由 bank-core 自己拥有：tools/result 只喂账本，不改写状态机
      expect(h.deps.tickets.status(approved)).toBe('approved')
      expect(h.deps.tickets.status(issued)).toBe('issued')
    } finally {
      await h.dispose()
    }
  })
})
