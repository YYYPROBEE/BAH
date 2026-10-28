/**
 * 造数确定性（施工单 07 §4 / §6 的 T-BANK-001、009、010）。
 */

import { describe, expect, it } from 'vitest'

import { buildBankDataset, DEFAULT_LIMITS, DEMO_NOW } from './index.ts'

describe('T-BANK-001 seeded 复现', () => {
  it('T-BANK-001 同 seed 两次造数全等；换 seed 流水不同', () => {
    const first = buildBankDataset({ seed: 7, tier: 'stress' })
    const second = buildBankDataset({ seed: 7, tier: 'stress' })
    expect(first).toEqual(second)

    const other = buildBankDataset({ seed: 8, tier: 'stress' })
    expect(other.transactions).not.toEqual(first.transactions)

    // demo 档没有随机量，也必须逐字确定
    expect(buildBankDataset({ seed: 1 })).toEqual(buildBankDataset({ seed: 1 }))
  })

  it('stress 档规模：3 用户 / 6 账户 / 300 笔流水', () => {
    const data = buildBankDataset({ seed: 3, tier: 'stress' })
    expect(data.users).toHaveLength(3)
    expect(data.accounts).toHaveLength(6)
    expect(data.transactions).toHaveLength(300)
    expect(data.cards).toHaveLength(3)
    expect(data.payees).toHaveLength(6)
    expect(data.subscriptions).toHaveLength(3)
  })

  it('缺省档位 = demo，缺省基准时刻 = DEMO_NOW', () => {
    const data = buildBankDataset({ seed: 1 })
    expect(data.tier).toBe('demo')
    expect(data.now).toBe(DEMO_NOW)
  })
})

describe('T-BANK-009 demo 档主体与白名单收款人', () => {
  it('T-BANK-009 主体是张三，白名单收款人是王建国，首笔时间早于演示时刻', () => {
    const data = buildBankDataset({ seed: 1 })
    const payee = data.payees.find((item) => item.name === '王建国')
    expect(payee).toMatchObject({ binding: 'whitelist' })
    expect(payee?.firstSeenAt).toBeLessThan(data.now)

    const user = data.users.find((item) => item.id === payee?.userId)
    expect(user?.name).toBe('张三')
  })
})

describe('T-BANK-010 adversarial 档', () => {
  it('T-BANK-010 含"几乎触发日限额的金额"与"新收款人"样例', () => {
    const data = buildBankDataset({ seed: 1, tier: 'adversarial' })
    const limit = data.limits.dailyTransferLimitCents

    const nearThreshold = data.transactions
      .filter((item) => item.direction === 'out')
      .find((item) => item.amountCents >= limit * 0.95)
    expect(nearThreshold).toBeDefined()
    expect(limit - (nearThreshold?.amountCents ?? 0)).toBeLessThanOrEqual(limit * 0.02)

    expect(data.payees.some((item) => item.binding === 'new')).toBe(true)

    // 深夜大额与重复扣费订阅也在素材里
    const night = data.transactions.find((item) => item.amountCents === 100_000)
    expect(night).toBeDefined()
    const subscriptions = data.transactions.filter((item) => item.category === 'subscription')
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[0]?.amountCents).toBe(subscriptions[1]?.amountCents)
  })

  it('三档的阈值都是同一个默认配置（部署时可整体替换）', () => {
    for (const tier of ['demo', 'stress', 'adversarial'] as const) {
      expect(buildBankDataset({ seed: 1, tier }).limits).toEqual(DEFAULT_LIMITS)
    }
  })
})
