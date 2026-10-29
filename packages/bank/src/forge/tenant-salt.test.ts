/**
 * 数据集租户盐（租户与鉴权 01 · TA-14）。
 *
 * **第一判据是"demo 不变"**：7 个快照与 profiles 的静态画像都依赖 demo 档逐字节一致。
 * 第二判据才是"别的租户不一样"——而且只对**用随机源的两档**成立：
 * `demo` 档是固定脚本（`buildDemo(now)` 不接随机源），所以盐对它没有作用。
 * 这不是漏做，是刻意的：把 demo 数据改成随租户变化会直接改掉演示脚本与槽位姓名一致性。
 */

import { describe, expect, it } from 'vitest'

import { buildBankDataset, tenantSaltOf } from './index.ts'

describe('tenantSaltOf', () => {
  it('TA-14-1 demo 零偏移（硬编码，快照靠它）', () => {
    expect(tenantSaltOf('demo')).toBe(0)
  })

  it('TA-14-2 非 demo 落在 20 位以内（AR-09：避免 32 位折叠撞序列）', () => {
    for (const tenant of ['acme', 'acme-bank', 'other', 'z9']) {
      const salt = tenantSaltOf(tenant)
      expect(salt, tenant).toBeGreaterThan(0)
      expect(salt, tenant).toBeLessThanOrEqual(0x0fffff)
    }
  })

  it('TA-14-3 同租户稳定、不同租户不同（确定性派生的最低要求）', () => {
    expect(tenantSaltOf('acme')).toBe(tenantSaltOf('acme'))
    expect(tenantSaltOf('acme')).not.toBe(tenantSaltOf('acme-bank'))
  })
})

describe('buildBankDataset · tenantSalt', () => {
  it('TA-14-4 demo 档：盐不改变任何数据（固定脚本 + 快照字节不变）', () => {
    const base = buildBankDataset({ seed: 7, tier: 'demo', tenantSalt: 0 })
    const salted = buildBankDataset({ seed: 7, tier: 'demo', tenantSalt: tenantSaltOf('acme') })
    expect(salted.users).toEqual(base.users)
    expect(salted.transactions).toEqual(base.transactions)
    expect(salted.accounts).toEqual(base.accounts)
    // 只有元数据不同（盐本身是 "这份数据属于谁" 的证据）
    expect(salted.tenantSalt).not.toBe(base.tenantSalt)
  })

  it('TA-14-5 stress 档：同 seed 不同盐 → 数据集不同（两个租户不是一份拷贝）', () => {
    const first = buildBankDataset({ seed: 7, tier: 'stress', tenantSalt: tenantSaltOf('acme') })
    const second = buildBankDataset({ seed: 7, tier: 'stress', tenantSalt: tenantSaltOf('acme-bank') })
    // 随机源驱动的是流水（金额/时间/分类/渠道），用户表是固定三人名单
    expect(second.transactions).not.toEqual(first.transactions)
    // 且两个租户的盐不同（盐本身是"这份数据属于谁"的可核对证据）
    expect(second.tenantSalt).not.toBe(first.tenantSalt)
  })

  it('TA-14-6 同 seed 同盐 → 逐字段相同（既有 T-BANK-001 口径带盐后仍成立）', () => {
    const salt = tenantSaltOf('acme')
    expect(buildBankDataset({ seed: 7, tier: 'stress', tenantSalt: salt })).toEqual(
      buildBankDataset({ seed: 7, tier: 'stress', tenantSalt: salt }),
    )
  })

  it('TA-14-7 不传盐 = 0（既有调用方零改动）', () => {
    expect(buildBankDataset({ seed: 7 }).tenantSalt).toBe(0)
    expect(buildBankDataset({ seed: 7 })).toEqual(buildBankDataset({ seed: 7, tenantSalt: 0 }))
  })
})
