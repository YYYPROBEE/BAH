/**
 * `interaction:approval` 插件（施工单 09 §2 / §6 的宿主接线）。
 *
 * 端到端断言只看看得见的东西：会话事件序列、工具结果、票据状态。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { asSessionId, captureThrown } from '@bah/test-support'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import type { AnySessionEvent } from '@bah/runtime'

import { boot, type BootOptions } from '../boot.ts'
import { createCatalog } from './index.ts'
import { DEFAULT_APPROVAL, approvalPlugin, type ApprovalSettings } from './approval.ts'
import type { PluginRow } from '../profile-plugins.ts'

/** 王建国转账的工具调用脚本。 */
function transferStep(amount: number): readonly PluginRow[] {
  return [
    {
      id: 'core:model',
      config: {
        provider: 'mock',
        model: 'mock-chat',
        script: [
          {
            tool: {
              id: 'call-1',
              name: 'transfer_create',
              args: { amount, payee: { name: '王建国', phone: '13900002222' } },
            },
          },
          { text: '处理完成。' },
        ],
      },
    },
  ]
}

/** 造一组行（bank 与 approval 的配置可替换）。 */
function rows(options: {
  readonly amount?: number
  readonly bank?: Readonly<Record<string, unknown>>
  readonly approval?: Readonly<Record<string, unknown>>
}): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    ...transferStep(options.amount ?? 800),
    { id: 'core:agent', config: { channel: 'headless', loop: { model: 'mock:mock-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
    { id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo', ...options.bank } },
    { id: 'interaction:approval', config: options.approval ?? {} },
  ]
}

/** 启动并跑一个 turn。 */
async function run(
  options: Parameters<typeof rows>[0],
): Promise<{
  events: readonly AnySessionEvent[]
  dispose: () => Promise<void>
}> {
  const dir = mkdtempSync(join(tmpdir(), 'bah-approval-'))
  const bootOptions: BootOptions = {
    profile: { name: 'fx', bundles: ['fx'], hmr: false },
    bundles: [{ name: 'fx', rows: rows(options) }],
    layers: [],
    catalog: createCatalog(),
    run: { sessionId: asSessionId('s-approval-e2e'), now: () => 1_792_000_000_000, jsonlDir: dir },
  }
  const app = await boot(bootOptions)
  const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
  agent.send('给王建国转账')
  await agent.run()
  const session = app.ctx.get(SESSION_SERVICE)
  return {
    events: session.events(),
    dispose: async () => {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 取某类会话事件载荷。 */
function payloads(events: readonly AnySessionEvent[], type: string): Record<string, unknown>[] {
  return events.filter((event) => event.type === type).map((event) => event.data as Record<string, unknown>)
}

describe('interaction:approval 配置（fail-loud）', () => {
  it('默认值：没有应答者（默认拒绝）；其余字段有默认', () => {
    expect(approvalPlugin.validate({})).toEqual(DEFAULT_APPROVAL)
    // W04：没写结论 = reject（不能靠"忘了配置"变成自动放行）
    expect(DEFAULT_APPROVAL.autoDecision).toBe('reject')
    expect(approvalPlugin.validate({ responder: 'headless' }).autoDecision).toBe('reject')
  })

  it('显式覆盖：responder / 结论 / 是否验挑战 / 延迟', () => {
    expect(
      approvalPlugin.validate({
        responder: 'headless',
        autoDecision: 'reject',
        autoVerify: false,
        autoDelayMs: 5,
      }) as ApprovalSettings,
    ).toEqual({ responder: 'headless', autoDecision: 'reject', autoVerify: false, autoDelayMs: 5 })
  })

  it('未知键 / 非法枚举 / 非布尔 / 非法延迟全部拒绝', () => {
    const cases: readonly [string, Readonly<Record<string, unknown>>, string][] = [
      ['顶层未知键', { nope: 1 }, 'unknown-config-key'],
      ['应答者非法', { responder: 'web' }, 'invalid-config'],
      ['结论非法', { autoDecision: 'maybe' }, 'invalid-config'],
      ['autoVerify 非布尔', { autoVerify: 'yes' }, 'invalid-config'],
      ['autoDelayMs 非正整数', { autoDelayMs: 0 }, 'invalid-config'],
    ]
    for (const [name, config, code] of cases) {
      const error = captureThrown(() => approvalPlugin.validate(config))
      expect(`${name}: ${error.code}`).toBe(`${name}: ${code}`)
    }
  })
})

describe('审批服务端到端', () => {
  it('没有应答者：unavailable → deny，票据 blocked，工具体不执行', async () => {
    const app = await run({})
    try {
      const result = payloads(app.events, 'tool/result')[0] as { isError: boolean; code?: string }
      expect(result.isError).toBe(true)
      expect(result.code).toBe('approval-unavailable')
      expect(payloads(app.events, 'approval/decided')[0]).toMatchObject({ decision: 'unavailable' })
      expect(payloads(app.events, 'ticket/blocked')).toHaveLength(1)
      expect(payloads(app.events, 'transfer/created')).toHaveLength(0)
      expect(payloads(app.events, 'approval/duplicate')).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })

  it('TC-W04-04 autoDecision 缺省 = reject：headless 没写结论也会被拒', async () => {
    const app = await run({ approval: { responder: 'headless' } })
    try {
      const result = payloads(app.events, 'tool/result')[0] as { isError: boolean; code?: string }
      expect(result.isError).toBe(true)
      expect(result.code).toBe('approval-rejected')
      expect(payloads(app.events, 'approval/decided')[0]).toMatchObject({
        decision: 'rejected',
        reason: 'headless-reject',
      })
      expect(payloads(app.events, 'transfer/created')).toHaveLength(0)
      expect(payloads(app.events, 'ticket/blocked')).toHaveLength(1)
    } finally {
      await app.dispose()
    }
  })

  it('headless 自动批准：ticket issued → approved → redeemed → consumed', async () => {
    const app = await run({ approval: { responder: 'headless', autoDecision: 'allow' } })
    try {
      const result = payloads(app.events, 'tool/result')[0] as { isError: boolean }
      expect(result.isError).toBe(false)
      expect(payloads(app.events, 'approval/decided')[0]).toMatchObject({ decision: 'allowed-once' })
      const types = app.events.map((event) => event.type)
      for (const type of [
        'ticket/issued',
        'ticket/approved',
        'ticket/redeemed',
        'ticket/consumed',
      ]) {
        expect(types).toContain(type)
      }
      expect(payloads(app.events, 'transfer/created')).toHaveLength(1)
      // 票据事件必须 ignorable（平台 reader 可跳过；否则下一次请求装配会炸）
      const ticketEvent = app.events.find((event) => String(event.type) === 'ticket/issued')
      expect(ticketEvent?.ignorable).toBe(true)
    } finally {
      await app.dispose()
    }
  })

  it('headless 驳回：approval-rejected，票据 blocked，转账未发生', async () => {
    const app = await run({
      approval: { responder: 'headless', autoDecision: 'reject' },
    })
    try {
      const result = payloads(app.events, 'tool/result')[0] as { isError: boolean; code?: string }
      expect(result.code).toBe('approval-rejected')
      expect(payloads(app.events, 'approval/decided')[0]).toMatchObject({
        decision: 'rejected',
        reason: 'headless-reject',
      })
      expect(payloads(app.events, 'ticket/blocked')).toHaveLength(1)
      expect(payloads(app.events, 'transfer/created')).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })

  it('headless 取消：approval-cancelled（第四个枚举值的真实产地）', async () => {
    const app = await run({
      approval: { responder: 'headless', autoDecision: 'cancel' },
    })
    try {
      const result = payloads(app.events, 'tool/result')[0] as { code?: string }
      expect(result.code).toBe('approval-cancelled')
      expect(payloads(app.events, 'approval/decided')[0]).toMatchObject({ decision: 'cancelled' })
    } finally {
      await app.dispose()
    }
  })
})

describe('红级挑战链（施工单 09 §6）', () => {
  it('超日限额 → 签发挑战 → 强验证通过 → 才允许批准 → 核销', async () => {
    const app = await run({
      amount: 6_000,
      approval: { responder: 'headless', autoDecision: 'allow' },
    })
    try {
      const asked = payloads(app.events, 'approval/asked')[0]
      expect(asked?.['challenge']).toBe('sms')
      expect(payloads(app.events, 'approval/challenge-issued')).toHaveLength(1)
      expect(payloads(app.events, 'verify/sms')).toHaveLength(1)
      expect(payloads(app.events, 'approval/decided')[0]).toMatchObject({ decision: 'allowed-once' })
      expect(payloads(app.events, 'transfer/created')).toHaveLength(1)
      expect(payloads(app.events, 'ticket/consumed')).toHaveLength(1)
    } finally {
      await app.dispose()
    }
  })

  it('不验挑战就批准：approval/challenge-failed + rejected（批准不可达）', async () => {
    const app = await run({
      amount: 6_000,
      approval: { responder: 'headless', autoDecision: 'allow', autoVerify: false },
    })
    try {
      const result = payloads(app.events, 'tool/result')[0] as { code?: string }
      expect(result.code).toBe('approval-rejected')
      expect(payloads(app.events, 'approval/challenge-failed')).toHaveLength(1)
      expect(payloads(app.events, 'approval/decided')[0]).toMatchObject({
        decision: 'rejected',
        reason: 'challenge-required',
      })
      expect(payloads(app.events, 'transfer/created')).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })

  it('强验证失败并被锁：拒绝 + verify/locked 落账', async () => {
    const app = await run({
      amount: 6_000,
      bank: { verify: { successAfter: 999, maxAttempts: 1, lockMinutes: 30 } },
      approval: { responder: 'headless', autoDecision: 'allow' },
    })
    try {
      const result = payloads(app.events, 'tool/result')[0] as { code?: string }
      expect(result.code).toBe('approval-rejected')
      expect(payloads(app.events, 'verify/locked')).toHaveLength(1)
      expect(payloads(app.events, 'approval/decided')[0]).toMatchObject({ decision: 'rejected' })
      expect(payloads(app.events, 'transfer/created')).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })
})

describe('票据账本接线', () => {
  it('批准后核销：账本按序落 issued → approved → redeemed → consumed', async () => {
    const app = await run({ approval: { responder: 'headless', autoDecision: 'allow' } })
    try {
      const ticketTypes = app.events
        .map((event) => event.type)
        .filter((type) => type.startsWith('ticket/'))
      expect(ticketTypes).toEqual([
        'ticket/issued',
        'ticket/approved',
        'ticket/redeemed',
        'ticket/consumed',
      ])
      const issued = payloads(app.events, 'ticket/issued')[0]
      expect(issued).toMatchObject({
        // UUID 票据：只钉 callId 与金额，ID 本身断言形状
        callId: 'call-1',
        name: 'transfer_create',
        amountCents: 80_000,
      })
      expect(String(issued?.['ticketId'])).toMatch(/^ticket:[0-9a-f-]{36}$/)
      expect(issued?.['expiresAt']).toBe(1_792_000_120_000)
    } finally {
      await app.dispose()
    }
  })
})
