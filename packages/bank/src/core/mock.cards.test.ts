/**
 * `listCards`（`account_list` 的卡片来源）与未知卡路径。
 *
 * 为什么单独钉：
 * - `listCards` 是跨账户聚合的只读面，过滤错一个账户就是**跨用户数据泄露**；
 * - 返回值必须是副本，否则前端改一次状态就把账本改了（append-only 的核心前提）；
 * - 未知卡只能 fail-loud（`card-unknown`），不能当成"没有这张卡"静默放过。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import { buildBankDataset, DEMO_NOW } from '../forge/index.ts'
import { MockBankCore } from './mock.ts'
import { bankIds } from './model.ts'

const USER = bankIds.user('u-1')
const ACCOUNT = bankIds.account('a-1')

function setup(): MockBankCore {
  return new MockBankCore({ data: buildBankDataset({ seed: 1 }), now: () => DEMO_NOW })
}

describe('MockBankCore.listCards', () => {
  it('只返回本用户名下账户的卡，按账本原序（含 ADR-0015 的信用额度卡）', async () => {
    const core = setup()
    const cards = await core.listCards(USER)
    expect(cards.map((card) => card.id)).toEqual([
      bankIds.card('c-1'),
      bankIds.card('c-2'),
      bankIds.card('c-3'),
    ])
    expect(cards.every((card) => card.accountId === ACCOUNT)).toBe(true)
    // 信用产品与借记卡并列存在：`kind` 缺省即借记，额度三件套只在信用卡上（ADR-0015）。
    expect(cards.map((card) => card.kind ?? 'debit')).toEqual(['debit', 'debit', 'credit'])
    expect(cards[2]).toMatchObject({ creditLimitCents: 500_000, usedCreditCents: 0 })
    expect(cards[0]?.creditLimitCents).toBeUndefined()
  })

  it('未知用户 ⇒ 空数组（"没有卡"是业务结果，不是错误）', async () => {
    const core = setup()
    await expect(core.listCards(bankIds.user('u-999'))).resolves.toEqual([])
  })

  it('返回副本：改返回值不污染账本', async () => {
    const core = setup()
    const first = await core.listCards(USER)
    const mutable = first[0] as unknown as { status: string }
    mutable.status = 'lost'
    const again = await core.listCards(USER)
    expect(again[0]?.status).toBe('normal')
  })
})

describe('未知卡 fail-loud', () => {
  it('previewTransfer 传入未知卡 ⇒ card-unknown（不静默按无卡处理）', async () => {
    const core = setup()
    const error = await captureRejection(() =>
      core.previewTransfer({
        fromAccountId: ACCOUNT,
        payee: { name: '王建国', phone: '13900002222' },
        amountCents: 10_000,
        channel: 'app',
        viaCardId: bankIds.card('c-missing'),
      }),
    )
    expect(error.code).toBe('card-unknown')
  })

  it('freezeCard 传入未知卡 ⇒ card-unknown', async () => {
    const core = setup()
    const error = await captureRejection(() => core.freezeCard(USER, bankIds.card('c-missing')))
    expect(error.code).toBe('card-unknown')
  })
})
