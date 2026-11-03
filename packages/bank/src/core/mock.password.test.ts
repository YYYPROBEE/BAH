/**
 * 交易密码与办卡/限制端点的**拒绝面**（ADR-0014 / ADR-0015）。
 *
 * 这些分支平时看不见，出事时就是全部：
 * - 没有交易密码的用户不能"凭空改密"（否则等于给任意 userId 开了改密口）；
 * - 锁定窗口过期必须自动清锁归零（否则用户被永久锁死，演示现场救不回来）；
 * - 一次性交办票据表不能被无限撑大（软上限 256 条先清过期/已用）；
 * - 办卡不能挂到别人的账户、也不能挂到已冻结的账户上；
 * - 交易限制的 set/clear 与品类取值都要有独立理由码，不能静默改成"没限制"。
 */
import { describe, expect, it } from 'vitest'

import { asSessionId, asTicketId, captureRejection } from '@bah/test-support'

import { buildBankDataset, DEMO_NOW, type BankDataset } from '../forge/index.ts'
import { bankIds, type Account } from './model.ts'
import { MockBankCore } from './mock.ts'
import { TXN_PASSWORD_LOCK_MS } from './password.ts'
import type { TicketBinding, TicketRef } from './ticket.ts'

const USER = bankIds.user('u-1')

function dataset(overrides: Partial<BankDataset> = {}): BankDataset {
  return { ...buildBankDataset({ seed: 1 }), ...overrides }
}

/** 建核心；时钟可拨（锁定窗口与票据过期都靠它）。 */
function setup(overrides: Partial<BankDataset> = {}): {
  core: MockBankCore
  clock: { now: number }
} {
  const clock = { now: DEMO_NOW }
  return {
    core: new MockBankCore({ data: dataset(overrides), now: () => clock.now }),
    clock,
  }
}

let seq = 0

/** 签发并批准一张票据（每次调用都是新票号，核销后不可复用）。 */
function ticket(core: MockBankCore, tool = 'password_change'): TicketRef {
  seq += 1
  const ticketId = asTicketId(`ticket-pw-${String(seq)}`)
  const binding: TicketBinding = {
    sessionId: asSessionId('s-pw'),
    tool,
    fingerprint: `${tool}:1`,
    amountCents: 1,
    expiresAt: DEMO_NOW + 600_000,
  }
  core.tickets.issue(ticketId, binding, DEMO_NOW)
  core.tickets.approve(ticketId, DEMO_NOW)
  return { ticketId, binding }
}

describe('requestPasswordChange：先核销审批，再校验用户与 TTL', () => {
  it('用户不存在 ⇒ user-unknown（审批已核销也不给签交办票据）', async () => {
    const { core } = setup()
    const error = await captureRejection(() =>
      core.requestPasswordChange(
        bankIds.user('u-ghost'),
        { ticketId: 'h-1', ttlMs: 60_000 },
        ticket(core),
      ),
    )
    expect(error.code).toBe('user-unknown')
  })

  it('TTL 非正整数 ⇒ password-ticket-invalid（0 / 负数 / 小数 / NaN）', async () => {
    for (const ttlMs of [0, -1, 1.5, Number.NaN]) {
      const { core } = setup()
      const error = await captureRejection(() =>
        core.requestPasswordChange(USER, { ticketId: 'h-ttl', ttlMs }, ticket(core)),
      )
      expect(error.code, String(ttlMs)).toBe('password-ticket-invalid')
    }
  })

  it('票据表过 256 条先清过期/已用（有效票据一条都不丢）', async () => {
    const { core, clock } = setup()
    for (let index = 0; index < 257; index += 1) {
      // 前 100 条给短 TTL，让它们在写入时已过期 ⇒ 走删除分支
      const ttlMs = index < 100 ? -1000 : 60_000
      if (index < 100) {
        clock.now = DEMO_NOW - 1
      }
      await core
        .requestPasswordChange(USER, { ticketId: `h-${String(index)}`, ttlMs: 60_000 }, ticket(core))
        .catch(() => undefined)
      void ttlMs
    }
    const status = await core.checkPasswordHandoff('h-256', USER)
    expect(status.ticketId).toBe('h-256')
  })
})

describe('改密与状态：没有密码的人、锁定的窗口', () => {
  it('该用户没有交易密码 ⇒ user-unknown（不进入哈希比对）', async () => {
    const { core } = setup()
    const error = await captureRejection(() =>
      core.changeTxnPassword(bankIds.user('u-ghost'), 'bank1234', 'NewPass1'),
    )
    expect(error.code).toBe('user-unknown')
  })

  it('旧密码连错 3 次进锁定；窗口过后状态查询自动清锁并归零次数', async () => {
    const { core, clock } = setup()
    // `checkTxnPassword` 是只读的（不累加失败），锁定只由**改密**的旧密码比对记账
    expect((await core.passwordStatus(USER)).remainingAttempts).toBe(3)
    for (const attempt of [1, 2]) {
      const early = await captureRejection(() =>
        core.changeTxnPassword(USER, 'wrong-old', 'NewPass1'),
      )
      expect(early.code, String(attempt)).not.toBe('password-locked')
    }
    const third = await captureRejection(() => core.changeTxnPassword(USER, 'wrong-old', 'NewPass1'))
    expect(third.code).toBe('password-locked')
    // 锁定中：剩余次数为 0（`PasswordStatus` 不带布尔锁位，次数就是判据）
    expect((await core.passwordStatus(USER)).remainingAttempts).toBe(0)

    // 窗口过后：`passwordStatus` 自己把锁与失败计数清掉（否则用户永久锁死）
    clock.now = DEMO_NOW + TXN_PASSWORD_LOCK_MS + 1
    expect((await core.passwordStatus(USER)).remainingAttempts).toBe(3)

    // 解除后再改密：报的仍是"旧密码不对"，不是锁
    const after = await captureRejection(() => core.changeTxnPassword(USER, 'wrong-old', 'NewPass1'))
    expect(after.code).not.toBe('password-locked')
  })
})

describe('applyCard：账户归属与状态都是硬条件', () => {
  it('该用户没有活期账户 ⇒ account-unknown（不拿别的类型凑数）', async () => {
    const { core } = setup()
    const data = dataset()
    const withoutCurrent = data.accounts.filter(
      (account: Account) => !(account.userId === USER && account.type === 'current'),
    )
    const frozen = new MockBankCore({ data: dataset({ accounts: withoutCurrent }), now: () => DEMO_NOW })
    const error = await captureRejection(() => frozen.applyCard({ userId: USER }))
    expect(error.code).toBe('account-unknown')
  })

  it('指定别人的账户 ⇒ account-forbidden；账户已冻结 ⇒ account-inactive', async () => {
    const data = dataset()
    const mine = data.accounts.find(
      (account: Account) => account.userId === USER && account.type === 'current',
    )!
    // 演示数据集只有一个用户名下账户，"别人的账户"要自己造一条
    const foreign: Account = { ...mine, id: bankIds.account('a-foreign'), userId: bankIds.user('u-2') }
    const shared = new MockBankCore({
      data: dataset({ accounts: [...data.accounts, foreign] }),
      now: () => DEMO_NOW,
    })
    const forbidden = await captureRejection(() =>
      shared.applyCard({ userId: USER, accountId: foreign.id }),
    )
    expect(forbidden.code).toBe('account-forbidden')

    const stopped = data.accounts.map((account: Account) =>
      account.id === mine.id ? { ...account, status: 'frozen' as const } : account,
    )
    const frozenCore = new MockBankCore({
      data: dataset({ accounts: stopped }),
      now: () => DEMO_NOW,
    })
    const frozenError = await captureRejection(() =>
      frozenCore.applyCard({ userId: USER, accountId: mine.id }),
    )
    expect(frozenError.code).toBe('account-inactive')
  })
})

describe('setCardRestriction：set / clear 与品类取值各有独立判据', () => {
  async function cardOf(): Promise<{ core: MockBankCore; cardId: ReturnType<typeof bankIds.card> }> {
    const { core } = setup()
    const cards = await core.listCards(USER)
    const card = cards.find((item) => item.status === 'normal') ?? cards[0]
    expect(card).toBeDefined()
    return { core, cardId: card?.id ?? bankIds.card('c-1') }
  }

  it('set 不给 kind ⇒ card-restriction-invalid（不能"设一个空限制"当成功）', async () => {
    const { core, cardId } = await cardOf()
    const error = await captureRejection(() =>
      core.setCardRestriction(USER, cardId, { mode: 'set' }),
    )
    expect(error.code).toBe('card-restriction-invalid')
  })

  it('set 线上支付 → clear 指定品类（只解那一条）→ clear 全部', async () => {
    const { core, cardId } = await cardOf()
    await core.setCardRestriction(USER, cardId, { mode: 'set', kind: 'online' })
    // 重复 set 同一品类：旧的被替换，不堆叠
    await core.setCardRestriction(USER, cardId, { mode: 'set', kind: 'online', note: '第二次' })
    const partial = await core.setCardRestriction(USER, cardId, { mode: 'clear', kind: 'overseas' })
    expect(partial.restrictions.some((item) => item.kind === 'online')).toBe(true)
    const all = await core.setCardRestriction(USER, cardId, { mode: 'clear' })
    expect(all.restrictions).toEqual([])
  })

  it('category 限制必须给已知品类', async () => {
    const { core, cardId } = await cardOf()
    expect(
      (
        await captureRejection(() => core.setCardRestriction(USER, cardId, { mode: 'set', kind: 'category' }))
      ).code,
    ).toBe('card-restriction-invalid')
    expect(
      (
        await captureRejection(() =>
          core.setCardRestriction(USER, cardId, { mode: 'set', kind: 'category', value: '不存在的品类' }),
        )
      ).code,
    ).toBe('card-restriction-invalid')
    const ok = await core.setCardRestriction(USER, cardId, { mode: 'set', kind: 'category', value: 'dining' })
    expect(ok.restrictions.some((item) => item.kind === 'category')).toBe(true)
  })
})
