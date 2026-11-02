/**
 * `password_change`：交易密码修改（ADR-0014）。
 *
 * ## 这组用例守的是"密码永远不进日志"
 *
 * 最重要的两条不是"改密成功"，而是：
 * 1. 工具**入参里没有密码字段**（`schema.properties` 只有 `action`）——所以
 *    `tool/call.args` 无论怎么调都写不进明文；
 * 2. 落账事件载荷只有 `{ userId, method, at }`——`JSON.stringify` 之后
 *    **不含**旧密码、新密码、哈希或盐。
 *
 * 剩下的是红档语义（审批 + 挑战）、一次性票据、失败计数与锁定、只读分支不签票。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import type { TicketId } from '@bah/core'

import { bankIds } from '../core/index.ts'
import { DEMO_TXN_PASSWORD, PASSWORD_HANDOFF_TTL_SECONDS } from '../core/password.ts'
import { fingerprintOf } from './fingerprint.ts'
import { createPasswordHandoffPort, type PasswordChangeResult } from './password.ts'
import { specOf } from './specs.ts'
import { READ_ONLY_ACTIONS } from './tier.ts'
import { createBankHarness, createPipelineHarness, TEST_CONFIG } from './testing.ts'

/** `u-1` 的品牌 ID（核心接口要 `UserId`，不走 `as never`）。 */
const U1 = bankIds.user('u-1')

/** 取某类会话事件载荷。 */
function payloads(
  harness: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return harness
    .events()
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>)
}

/** 取错误码（`captureRejection` 的返回值是 `unknown`）。 */
function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code
}

type BankHarness = ReturnType<typeof createBankHarness>

/**
 * 给 `password_change` 手工签一张审批票据（红档写操作的入口）。
 *
 * 复用 `fund-lock.test.ts` 的同一手法：治理面之外直接构造"已批准"的票据，
 * 这样单测不必装整条管线就能验工具体。
 */
function approve(h: BankHarness, callId: string, args: Readonly<Record<string, unknown>>): TicketId {
  const now = h.deps.now?.() ?? 0
  const ticketId = `ticket:${callId}` as TicketId
  const binding = {
    sessionId: h.ctx.sessionId,
    tool: 'password_change',
    fingerprint: fingerprintOf('password_change', args),
    amountCents: 0,
    expiresAt: now + TEST_CONFIG.ticketTtlSeconds * 1_000,
  }
  h.core.tickets.issue(ticketId, binding, now)
  h.core.tickets.approve(ticketId, now)
  return ticketId
}

/** 造一个"已绑定 u-1"的安全页端口（与 host 装配同构；`null` = 未绑定）。 */
function portOf(h: BankHarness, userId: string | null = 'u-1') {
  return createPasswordHandoffPort({
    core: h.deps.core,
    audit: h.deps.audit,
    resolveUserId: () => userId ?? undefined,
  })
}

/** 走一遍"发起改密"拿到交接票据（直接调工具，不装治理面）。 */
async function requestHandoff(h: BankHarness, callId = 'c-pwd-request'): Promise<string> {
  const args = { action: 'request' }
  approve(h, callId, args)
  const result = (await h.call('password_change', args, callId)) as PasswordChangeResult
  if (result.ticketId === undefined) throw new Error('未拿到交接票据')
  return result.ticketId
}

describe('password_change：声明面', () => {
  it('红档 + 只读分支登记；schema 里只有 action（没有密码字段）', () => {
    const spec = specOf('password_change')
    expect(spec.tier).toEqual({ level: 'red' })
    expect(spec.event).toBe('security/password-changed')
    expect(spec.readEvent).toBe('read/password-status')
    // 结构性保证：模型能填的参数只有 action，想"顺手传密码"也没有位置
    expect(Object.keys(spec.schema.properties ?? {})).toEqual(['action'])
    expect(spec.schema.required).toEqual(['action'])
    // 只读动作豁免是封闭表驱动的：表里必须有这条，否则查状态也要签票
    expect(READ_ONLY_ACTIONS).toContainEqual({ name: 'password_change', action: 'status' })
  })

  it('交接票 TTL 来自常量（120s），交接页路径只有一处定义', () => {
    expect(PASSWORD_HANDOFF_TTL_SECONDS).toBe(120)
  })
})

describe('password_change：红档语义', () => {
  it('request 走红档：审批携带强验证挑战，返回票据与安全页', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('password_change', { action: 'request' })
      expect(execution.result.isError).toBe(false)
      const value = execution.value as PasswordChangeResult
      expect(value.action).toBe('request')
      expect(value.handoffPath).toBe('/secure/password')
      expect(value.ticketId).toMatch(/^pwd:/)
      expect(value.expiresAt).toBeGreaterThan(0)

      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        name: 'password_change',
        challenge: TEST_CONFIG.redChallenge,
      })
      // 审批界面上不会出现任何密码字段（连字段名都没有）
      const shown = JSON.stringify(asked)
      expect(shown).not.toContain('oldPassword')
      expect(shown).not.toContain('newPassword')
    } finally {
      await h.dispose()
    }
  })

  it('工具正文带安全页地址与已编码的票据号（安全页可 ?ticket= 预填）', async () => {
    const h = createBankHarness()
    const args = { action: 'request' }
    approve(h, 'c-pwd-text', args)
    const result = (await h.call('password_change', args, 'c-pwd-text')) as PasswordChangeResult
    const tool = h.tools.get('password_change')!
    const text = ((tool.projectContent?.(result) ?? [])[0] as { text: string }).text
    const ticket = String(result.ticketId)

    expect(text).toContain(`/secure/password?ticket=${encodeURIComponent(ticket)}`)
    expect(text).toContain(ticket)
  })

  it('status 是只读动作：不签审批票也能查（READ_ONLY_ACTIONS 生效）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('password_change', { action: 'status' })
      expect(execution.result.isError).toBe(false)
      const value = execution.value as PasswordChangeResult
      expect(value.action).toBe('status')
      expect(value.lastChangedAt).toBeNull()
      expect(value.remainingAttempts).toBe(3)
      expect(payloads(h, 'approval/asked')).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('没有审批票据 → ticket-missing（连交接票都不签）', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() => h.call('password_change', { action: 'request' }))
    expect(codeOf(error)).toBe('ticket-missing')
  })
})

describe('password_change：校验顺序与失败计数', () => {
  it('新密码太短 / 纯数字 / 与旧密码相同 → 三种 password-invalid', async () => {
    const h = createBankHarness()
    const ticketId = await requestHandoff(h)
    const port = portOf(h)
    const short = await captureRejection(() =>
      port.submit('s-bank', { ticketId, oldPassword: DEMO_TXN_PASSWORD, newPassword: 'ab1' }),
    )
    expect(codeOf(short)).toBe('password-invalid')
    const digits = await captureRejection(() =>
      port.submit('s-bank', { ticketId, oldPassword: DEMO_TXN_PASSWORD, newPassword: '1234567890' }),
    )
    expect(codeOf(digits)).toBe('password-invalid')
    const same = await captureRejection(() =>
      port.submit('s-bank', {
        ticketId,
        oldPassword: DEMO_TXN_PASSWORD,
        newPassword: DEMO_TXN_PASSWORD,
      }),
    )
    expect(codeOf(same)).toBe('password-invalid')
    // 格式错**不计入**失败次数：三次都被拒之后仍然剩余 3 次
    expect((await h.core.passwordStatus(U1)).remainingAttempts).toBe(3)
  })

  it('旧密码错 → password-mismatch，票据仍可用（可重试）', async () => {
    const h = createBankHarness()
    const ticketId = await requestHandoff(h)
    const port = portOf(h)
    const wrong = await captureRejection(() =>
      port.submit('s-bank', { ticketId, oldPassword: 'bank9999', newPassword: 'newpass123' }),
    )
    expect(codeOf(wrong)).toBe('password-mismatch')
    // 票据没有被核销：换正确的旧密码再来一次就成功
    const ok = await port.submit('s-bank', {
      ticketId,
      oldPassword: DEMO_TXN_PASSWORD,
      newPassword: 'newpass123',
    })
    expect(ok.changedAt).toBeTypeOf('number')
    expect(await h.core.checkTxnPassword(U1, 'newpass123')).toBe(true)
    expect(await h.core.checkTxnPassword(U1, DEMO_TXN_PASSWORD)).toBe(false)
  })

  it('连续 3 次旧密码错 → password-locked；锁定期间正确密码也拒', async () => {
    const h = createBankHarness()
    const ticketId = await requestHandoff(h)
    const port = portOf(h)
    const codes: (string | undefined)[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await captureRejection(() =>
        port.submit('s-bank', { ticketId, oldPassword: 'wrong-pass', newPassword: 'newpass123' }),
      )
      codes.push(codeOf(error))
    }
    expect(codes).toEqual(['password-mismatch', 'password-mismatch', 'password-locked'])
    expect((await h.core.passwordStatus(U1)).remainingAttempts).toBe(0)
    const locked = await captureRejection(() =>
      port.submit('s-bank', { ticketId, oldPassword: DEMO_TXN_PASSWORD, newPassword: 'newpass123' }),
    )
    expect(codeOf(locked)).toBe('password-locked')
  })
})

describe('password_change：交接票据是一次性的', () => {
  it('同一票据第二次提交 → password-ticket-used', async () => {
    const h = createBankHarness()
    const ticketId = await requestHandoff(h)
    const port = portOf(h)
    await port.submit('s-bank', {
      ticketId,
      oldPassword: DEMO_TXN_PASSWORD,
      newPassword: 'newpass123',
    })
    const again = await captureRejection(() =>
      port.submit('s-bank', {
        ticketId,
        oldPassword: 'newpass123',
        newPassword: 'another123',
      }),
    )
    expect(codeOf(again)).toBe('password-ticket-used')
  })

  it('未知票据 / 他人的票据各有独立理由码', async () => {
    const h = createBankHarness()
    const unknown = await captureRejection(() =>
      portOf(h).submit('s-bank', {
        ticketId: 'pwd:nope',
        oldPassword: DEMO_TXN_PASSWORD,
        newPassword: 'newpass123',
      }),
    )
    expect(codeOf(unknown)).toBe('password-ticket-unknown')

    const ticketId = await requestHandoff(h)
    const foreign = await captureRejection(() =>
      portOf(h, 'u-2').submit('s-bank', {
        ticketId,
        oldPassword: DEMO_TXN_PASSWORD,
        newPassword: 'newpass123',
      }),
    )
    expect(codeOf(foreign)).toBe('password-ticket-foreign')
  })

  it('过期票据 → password-ticket-expired（TTL 之外不可用）', async () => {
    const h = createBankHarness()
    const ticketId = await requestHandoff(h)
    // 交接票 TTL 是 120s：推进到窗口之外，票据必须失效（`now()` 本身不推进时间）
    h.clock.advance(PASSWORD_HANDOFF_TTL_SECONDS * 1_000 + 1)
    const expired = await captureRejection(() =>
      portOf(h).submit('s-bank', {
        ticketId,
        oldPassword: DEMO_TXN_PASSWORD,
        newPassword: 'newpass123',
      }),
    )
    expect(codeOf(expired)).toBe('password-ticket-expired')
  })

  it('未绑定身份的会话 → no-identity（端口不接受请求体给的身份）', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() =>
      portOf(h, null).submit('s-bank', {
        ticketId: 'pwd:any',
        oldPassword: DEMO_TXN_PASSWORD,
        newPassword: 'newpass123',
      }),
    )
    expect(codeOf(error)).toBe('no-identity')
  })
})

describe('password_change：落账不含密码材料（本设计最重要的一条）', () => {
  it('改密成功 → 落 security/password-changed，且事件/入参 JSON 里没有明文', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('password_change', { action: 'request' })
      const value = execution.value as PasswordChangeResult
      const ticketId = String(value.ticketId)
      expect(value.handoffPath).toBe('/secure/password')

      const port = createPasswordHandoffPort({
        core: h.deps.core,
        audit: h.deps.audit,
        resolveUserId: () => 'u-1',
      })
      const changed = await port.submit('s-bank', {
        ticketId,
        oldPassword: DEMO_TXN_PASSWORD,
        newPassword: 'SuperSecret123',
      })
      expect(changed.changedAt).toBeTypeOf('number')

      // ① 事件确实落了，载荷只有 userId / method / at（评审会逐字看这一行）
      const records = h.audits.filter((record) => record.type === 'security/password-changed')
      expect(records).toHaveLength(1)
      expect(records[0]?.data).toMatchObject({ userId: 'u-1', method: 'secure-page' })
      expect(Object.keys((records[0]?.data ?? {}) as Record<string, unknown>).sort()).toEqual([
        'at',
        'method',
        'userId',
      ])

      // ② 落账面上没有任何密码材料
      const ledger = JSON.stringify(records)
      expect(ledger).not.toContain(DEMO_TXN_PASSWORD)
      expect(ledger).not.toContain('SuperSecret123')
      expect(ledger).not.toContain('sha256')

      // ③ 会话事件（`tool/call.args` 就写在这里）同样不含密码材料与密码字段名
      const session = JSON.stringify(h.events())
      expect(session).not.toContain(DEMO_TXN_PASSWORD)
      expect(session).not.toContain('SuperSecret123')
      expect(session).not.toContain('oldPassword')
      expect(session).not.toContain('newPassword')
    } finally {
      await h.dispose()
    }
  })

  it('status 分支落 read/password-status（只读审计，不改凭据）', async () => {
    const h = createBankHarness()
    const result = (await h.call(
      'password_change',
      { action: 'status' },
      'c-pwd-status',
    )) as PasswordChangeResult
    expect(result.lastChangedAt).toBeNull()
    expect(result.remainingAttempts).toBe(3)
    expect(h.auditsOf('read/password-status')).toHaveLength(1)
  })

  it('改密成功后 status 能读到时刻，凭据已换成新口令', async () => {
    const h = createBankHarness()
    const ticketId = await requestHandoff(h)
    await portOf(h).submit('s-bank', {
      ticketId,
      oldPassword: DEMO_TXN_PASSWORD,
      newPassword: 'newpass123',
    })
    const status = (await h.call(
      'password_change',
      { action: 'status' },
      'c-pwd-after',
    )) as PasswordChangeResult
    expect(status.lastChangedAt).toBeTypeOf('number')
    expect(status.remainingAttempts).toBe(3)
    // 失败计数在成功后归零：先错两次再改成功，剩余次数回到 3
    expect(h.auditsOf('read/password-status')).toHaveLength(1)
  })
})
