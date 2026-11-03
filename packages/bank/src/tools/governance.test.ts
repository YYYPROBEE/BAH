/**
 * 治理平面 × 七段管线。
 *
 * 断言口径：只看看得见的东西——会话事件序列、票据状态、审计事件、工具结果。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, createTestContext, fixedClock } from '@bah/test-support'
import type { TicketId } from '@bah/core'

import { createDeps, createPipelineHarness, primaryAccountId, TEST_CONFIG, type AuditRecord } from './testing.ts'
import { provideBankGovernance, type TicketLifecycle } from './governance.ts'
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
      // 票据 ID 已是随机 UUID：从 approval/asked 里取，不再按 callId 拼
      expect(h.core.tickets.status(asked[0]?.['ticketId'] as TicketId)).toBe('redeemed')
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
      expect(h.core.tickets.status(asked[0]?.['ticketId'] as TicketId)).toBe('redeemed')
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
      const asked = payloads(h, 'approval/asked')
      expect(h.core.tickets.status(asked[0]?.['ticketId'] as TicketId)).toBe('blocked')
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
      const asked = payloads(h, 'approval/asked')
      expect(h.core.tickets.status(asked[0]?.['ticketId'] as TicketId)).toBe('blocked')
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

describe('票据记账旁路：账本异常不改写主流程', () => {
  it('status 抛错 → 落 ticket/ledger-failed(result)，监听器不冒泡', async () => {
    const test = createTestContext()
    const audits: AuditRecord[] = []
    const { deps } = createDeps({ now: () => 1_000, audits })
    const badDeps = {
      ...deps,
      tickets: {
        ...deps.tickets,
        status: () => {
          throw new Error('ledger down')
        },
      },
    } as unknown as typeof deps
    try {
      provideBankGovernance({ ctx: test.ctx, sessionId: asSessionId('s-bank'), deps: badDeps })
      expect(() =>
        test.ctx.events.emit('tools/result', {
          callId: 'c-x',
          name: 'x',
          isError: false,
          content: [],
          durationMs: 0,
        }),
      ).not.toThrow()
      expect(
        audits.some(
          (record) =>
            record.type === 'ticket/ledger-failed' &&
            (record.data as { op?: string }).op === 'result',
        ),
      ).toBe(true)
    } finally {
      await test.dispose()
    }
  })

  it('lifecycle 抛错且审计出口也失联：仍然不冒泡（资金路径优先）', async () => {
    const test = createTestContext()
    const audits: AuditRecord[] = []
    const { deps, core } = createDeps({ now: () => 1_000, audits })
    const ticketId = 'ticket:c-x' as TicketId
    const binding = {
      sessionId: asSessionId('s-bank'),
      tool: 'transfer_create',
      fingerprint: 'fp',
      amountCents: 100,
      expiresAt: 999_999,
    }
    core.tickets.issue(ticketId, binding, 1)
    core.tickets.approve(ticketId, 1)
    core.tickets.redeem({ ticketId, binding }, 1)

    const lifecycle: TicketLifecycle = {
      issue: () => undefined,
      approve: () => undefined,
      redeem: () => {
        throw new Error('ledger down')
      },
      consume: () => undefined,
      block: () => {
        throw new Error('ledger down')
      },
    }
    const badDeps = {
      ...deps,
      audit: {
        append: () => {
          throw new Error('audit down')
        },
      },
    } as unknown as typeof deps

    try {
      provideBankGovernance({
        ctx: test.ctx,
        sessionId: asSessionId('s-bank'),
        deps: badDeps,
        lifecycle,
      })
      // 已核销 + isError：先 redeem 再 block，两步都抛；审计也抛，仍不得冒泡
      expect(() =>
        test.ctx.events.emit('tools/result', {
          callId: 'c-x',
          name: 'x',
          isError: true,
          code: 'boom',
          content: [],
          durationMs: 0,
        }),
      ).not.toThrow()
    } finally {
      await test.dispose()
    }
  })
})

describe('W12 执行 lease（治理平面 → bank-core 核销点）', () => {
  it('TC-W12-01 lease 过期后核销 → ticket-expired，余额一分不动、无 transfer/created', async () => {
    const clock = fixedClock({ start: 5_000_000, step: 10 })
    const h = createPipelineHarness({
      approval: 'allowed-once',
      lease: { enforce: true, ttlMs: 1_000 },
      clock,
    })
    try {
      const accountId = await primaryAccountId(h.core)
      const before = await h.core.balance(accountId)

      // 审批已在 ⑤ 之前完成；这里模拟"排队排过了 lease 窗口"再落地执行
      h.ctx.events.on('tools/execute', async (run, next) => {
        clock.advance(2_000)
        return next(run)
      })

      const execution = await h.run('transfer_create', TRANSFER_800)

      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('ticket-expired')
      expect(await h.core.balance(accountId)).toMatchObject({
        balanceCents: before.balanceCents,
        availableCents: before.availableCents,
      })
      expect(auditPayloads(h, 'transfer/created')).toHaveLength(0)

      const asked = payloads(h, 'approval/asked')[0]!
      expect(h.core.tickets.status(asked['ticketId'] as TicketId)).toBe('blocked')
    } finally {
      await h.dispose()
    }
  })

  it('lease 窗口被写进 bank-core 五绑定：expiresAt 收紧到 ≤ 签发时刻 + lease TTL', async () => {
    const clock = fixedClock({ start: 5_000_000, step: 10 })
    const h = createPipelineHarness({
      approval: 'allowed-once',
      lease: { enforce: true, ttlMs: 1_000 },
      clock,
    })
    try {
      await h.run('transfer_create', TRANSFER_800)
      const asked = payloads(h, 'approval/asked')[0]!
      const record = h.core.tickets.get(asked['ticketId'] as TicketId)!
      expect(record.binding.expiresAt - record.issuedAt).toBe(1_000)
      // 票据本身 TTL 是 120s（TEST_CONFIG）：lease 确实更紧，而不是把 TTL 抄了一遍
      expect(record.binding.expiresAt).toBeLessThan(clock.now() + TEST_CONFIG.ticketTtlSeconds * 1_000)
    } finally {
      await h.dispose()
    }
  })

  it('enforce:false 回滚：五绑定回落到票据 TTL（lease 不参与）', async () => {
    const clock = fixedClock({ start: 5_000_000, step: 10 })
    const h = createPipelineHarness({
      approval: 'allowed-once',
      lease: { enforce: false, ttlMs: 1_000 },
      clock,
    })
    try {
      await h.run('transfer_create', TRANSFER_800)
      const asked = payloads(h, 'approval/asked')[0]!
      const record = h.core.tickets.get(asked['ticketId'] as TicketId)!
      expect(record.binding.expiresAt - record.issuedAt).toBeGreaterThan(60_000)
    } finally {
      await h.dispose()
    }
  })
})

describe('03 TA-47 · 工具层租户闸（wrong-tenant 早于 no-identity）', () => {
  it('TA-47-1 绑定租户与进程租户不一致 → deny wrong-tenant，工具体不执行', async () => {
    const h = createPipelineHarness({
      tenantId: 'demo',
      identity: {
        resolve: () => 'u-1',
        resolveIdentity: () => ({ userId: 'u-1', tenantId: 'other' }),
      },
    })
    try {
      const execution = await h.run('account_balance')
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('wrong-tenant')
      // 审计要看得见"有人在试跨租户"
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        verdict: 'deny',
        code: 'wrong-tenant',
      })
      expect(payloads(h, 'approval/asked')).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('TA-47-2 旧绑定没有 tenantId → 不误拒（正常执行）', async () => {
    const h = createPipelineHarness({
      tenantId: 'demo',
      identity: {
        resolve: () => 'u-1',
        // 旧载荷：只有用户，没有租户（01 之前的 identity/bound）
        resolveIdentity: () => ({ userId: 'u-1' }),
      },
    })
    try {
      const execution = await h.run('account_balance')
      expect(execution.result.isError).toBe(false)
    } finally {
      await h.dispose()
    }
  })

  it('TA-47-3 wrong-tenant 早于 no-identity（同时成立时先报租户）', async () => {
    // 构造"看起来没身份、但租户对不上"的接缝：旧实现会先报 no-identity，
    // 把"有人在试跨租户"藏进"没登录"里
    const h = createPipelineHarness({
      tenantId: 'demo',
      identity: {
        resolve: () => '',
        resolveIdentity: () => ({ userId: '', tenantId: 'other' }),
      },
    })
    try {
      const execution = await h.run('account_balance')
      expect(execution.result.code).toBe('wrong-tenant')
    } finally {
      await h.dispose()
    }
  })
})

describe('动作豁免（READ_ONLY_ACTIONS）：只读分支不签票，写分支照旧 ask', () => {
  it('risk_assess(action=questions) 按 green 放行，审计记 level=green / reason=declared', async () => {
    const h = createPipelineHarness({ approval: 'rejected' })
    try {
      const execution = await h.run('risk_assess', { action: 'questions' })
      expect(execution.result.isError).toBe(false)
      // 没有签票、没有审批：用户点"开始测评"不该看到一张"执行 risk_assess"的确认卡
      expect(payloads(h, 'approval/asked')).toHaveLength(0)
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        name: 'risk_assess',
        level: 'green',
        verdict: 'allow',
        reason: 'declared',
      })
    } finally {
      await h.dispose()
    }
  })

  it('负控：risk_assess(action=submit) 仍然必须 ask（豁免只认 questions 字面量）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const issued = await h.run('risk_assess', { action: 'questions' })
      const questionnaire = issued.value as {
        questionnaireId: string
        questions: readonly { index: number }[]
      }
      const execution = await h.run('risk_assess', {
        action: 'submit',
        questionnaireId: questionnaire.questionnaireId,
        answers: questionnaire.questions.map((question) => ({
          index: question.index,
          key: 'middle',
        })),
      })
      expect(execution.result.isError).toBe(false)
      expect(payloads(h, 'approval/asked')).toHaveLength(1)
      // 生效级别仍是声明的黄档（豁免没有把它顺手降成绿）
      expect(auditPayloads(h, 'tier/decided').at(-1)).toMatchObject({
        name: 'risk_assess',
        level: 'yellow',
        verdict: 'ask',
      })
    } finally {
      await h.dispose()
    }
  })

  it('aa_create(action=status) 按 green 放行（B-04），审计记 declared', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const created = (
        await h.run('aa_create', {
          totalYuan: 20,
          participants: [{ name: '张三' }, { name: '李四' }],
        })
      ).value as { groupId: string }
      // create 是写分支：一张票
      expect(payloads(h, 'approval/asked')).toHaveLength(1)

      const status = await h.run('aa_create', { action: 'status', groupId: created.groupId })
      expect(status.result.isError).toBe(false)
      // status 不签票
      expect(payloads(h, 'approval/asked')).toHaveLength(1)
      expect(auditPayloads(h, 'tier/decided').at(-1)).toMatchObject({
        name: 'aa_create',
        level: 'green',
        verdict: 'allow',
        reason: 'declared',
      })
    } finally {
      await h.dispose()
    }
  })

  it('负控：aa_create(action=create) 仍然必须 ask（豁免只认 status 字面量）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('aa_create', {
        totalYuan: 20,
        participants: [{ name: '张三' }, { name: '李四' }],
      })
      expect(execution.result.isError).toBe(false)
      expect(payloads(h, 'approval/asked')).toHaveLength(1)
      expect(auditPayloads(h, 'tier/decided').at(-1)).toMatchObject({
        name: 'aa_create',
        level: 'yellow',
        verdict: 'ask',
      })
    } finally {
      await h.dispose()
    }
  })

  it('未绑定身份时连只读动作也 deny（豁免在身份闸之后）', async () => {
    const h = createPipelineHarness({ userId: null })
    try {
      const execution = await h.run('risk_assess', { action: 'questions' })
      expect(execution.result.code).toBe('no-identity')
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        name: 'risk_assess',
        verdict: 'deny',
        code: 'no-identity',
      })
    } finally {
      await h.dispose()
    }
  })
})
