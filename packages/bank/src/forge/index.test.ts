/**
 * 造数确定性（施工单 07 §4 / §6 的 T-BANK-001、009、010）。
 */

import { describe, expect, it } from 'vitest'

import { sha256Hex } from '@bah/util'

import { detectRecurring } from '../detect/recurring.ts'
import { normalizeMerchant } from '../detect/merchant.ts'
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

  it('04 单：生日案例的商户收款人是白名单，首笔早于演示 30 天以上', () => {
    const data = buildBankDataset({ seed: 1 })
    for (const [name, id] of [
      ['馨香花艺', 'p-2'],
      ['甜心蛋糕坊', 'p-3'],
    ] as const) {
      const payee = data.payees.find((item) => item.name === name)
      expect(payee).toMatchObject({ id, binding: 'whitelist' })
      // 升红规则没改：靠"登记够久"让演示主线不被 new-payee 打断
      expect(data.now - (payee?.firstSeenAt ?? data.now)).toBeGreaterThan(30 * 24 * 60 * 60 * 1000)
    }
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

describe('场景 5：recurring 档（订阅 / 代扣）', () => {
  it('demo 档字节不变（sha256 守卫）', () => {
    const demo = buildBankDataset({ seed: 7, tier: 'demo' })
    // 2026-10-30 账单场景 T-05：demo 追加近 12 个月的纯算术历史（60 笔），
    // 当前月/上月的 8 笔固定脚本一字未改。哈希随数据更新——它钉的是
    // "同 seed 逐字节确定"，不是"永远不许改数据"。
    // 2026-11-01（02 单 / ADR-0015）：demo 追加一张信用额度卡 c-3（尾号 2468，
    // 授信 5,000 元，已用 0）；既有两张卡的字段一个都没动，哈希随之更新。
    expect(sha256Hex(JSON.stringify(demo))).toBe(
      '78fa1d37c187859cecd1c8f0190b9063bf15ee33543afc50bd666a271dbb11ff',
    )
  })

  it('11 条 series、9 high / 1 medium / 1 low；重复扣款 1 组', () => {
    const data = buildBankDataset({ seed: 7, tier: 'recurring' })
    expect(data.accounts).toHaveLength(2)
    expect(data.subscriptions).toHaveLength(8)
    expect(data.authorizations).toHaveLength(8)
    const output = detectRecurring(data.transactions, {
      now: data.now,
      subscriptions: data.subscriptions,
    })
    expect(output.series).toHaveLength(11)
    const counts = { high: 0, medium: 0, low: 0 }
    for (const item of output.series) counts[item.confidence] += 1
    expect(counts).toEqual({ high: 9, medium: 1, low: 1 })
    expect(output.duplicates).toHaveLength(1)
    const video = output.series.find((item) => item.merchantKey === '视频会员')
    expect(video?.priceHike).toMatchObject({ fromCents: 3000, toCents: 3500 })
    expect(output.series.find((item) => item.merchantKey === '国网电力')?.kind).toBe('bill')
  })

  it('固定脚本：换 seed / 租户盐不影响 recurring 数据（与 demo 同构）', () => {
    const first = buildBankDataset({ seed: 1, tier: 'recurring' })
    const second = buildBankDataset({ seed: 99, tier: 'recurring', tenantSalt: 12345 })
    expect(second.transactions).toEqual(first.transactions)
    expect(second.subscriptions).toEqual(first.subscriptions)
    expect(second.authorizations).toEqual(first.authorizations)
  })

  it('断供失败样本：健身房协议已关，之后仍有一笔扣款', () => {
    const data = buildBankDataset({ seed: 7, tier: 'recurring' })
    const auth = data.authorizations?.find((item) => item.merchantKey === '某某健身')
    expect(auth?.status).toBe('revoked')
    expect(auth?.revokedAt).toBeDefined()
    const later = data.transactions.some(
      (txn) =>
        txn.status === 'success' &&
        txn.direction === 'out' &&
        txn.at > (auth?.revokedAt ?? 0) &&
        normalizeMerchant(txn.counterparty.name) === '某某健身',
    )
    expect(later).toBe(true)
  })
})
