/**
 * 风控预检五规则（施工单 07 §4.3 / §6 的 T-BANK-011）。
 */

import { describe, expect, it } from 'vitest'

import type { BankLimits } from '../core/model.ts'
import { DEFAULT_LIMITS } from './index.ts'
import { checkTransferRisks, isNight, type TransferRiskInput } from './risk.ts'

/** 2026-10-18 10:00（东八区）——白天。 */
const DAY = Date.UTC(2026, 9, 18, 2, 0, 0)
/** 2026-10-18 23:00（东八区）——夜间。 */
const NIGHT = Date.UTC(2026, 9, 18, 15, 0, 0)

/** 一份不触发任何规则的基础输入。 */
function input(patch: Partial<TransferRiskInput> = {}): TransferRiskInput {
  return {
    amountCents: 1_000,
    availableCents: 1_000_000,
    dailyUsedCents: 0,
    dailyLimitCents: 500_000,
    payeeBinding: 'whitelist',
    recentOutCount: 0,
    at: DAY,
    limits: DEFAULT_LIMITS,
    ...patch,
  }
}

describe('T-BANK-011 五规则各有触发样例与返回码', () => {
  it('T-BANK-011 余额不足 → block / insufficient-balance', () => {
    const findings = checkTransferRisks(input({ amountCents: 2_000, availableCents: 1_000 }))
    expect(findings.map((item) => item.code)).toEqual(['insufficient-balance'])
    expect(findings[0]?.severity).toBe('block')
    expect(findings[0]?.detail).toMatchObject({ availableCents: 1_000, amountCents: 2_000 })
  })

  it('T-BANK-011 超日限额 → block / daily-limit-exceeded（带当日已用与剩余）', () => {
    const findings = checkTransferRisks(input({ amountCents: 2_000, dailyUsedCents: 499_000 }))
    expect(findings.map((item) => item.code)).toEqual(['daily-limit-exceeded'])
    expect(findings[0]?.detail).toMatchObject({ dailyUsedCents: 499_000, remainingCents: 1_000 })
  })

  it('T-BANK-011 收款人异常 → warn / payee-new', () => {
    const findings = checkTransferRisks(input({ payeeBinding: 'new' }))
    expect(findings.map((item) => item.code)).toEqual(['payee-new'])
    expect(findings[0]?.severity).toBe('warn')
  })

  it('T-BANK-011 夜间大额 → warn / night-large-amount', () => {
    const findings = checkTransferRisks(
      input({ at: NIGHT, amountCents: DEFAULT_LIMITS.nightLargeCents }),
    )
    expect(findings.map((item) => item.code)).toEqual(['night-large-amount'])
    expect(findings[0]?.detail).toMatchObject({ hour: 23 })
  })

  it('T-BANK-011 短时高频 → warn / velocity-high', () => {
    const findings = checkTransferRisks(input({ recentOutCount: DEFAULT_LIMITS.velocityMaxCount }))
    expect(findings.map((item) => item.code)).toEqual(['velocity-high'])
    expect(findings[0]?.severity).toBe('warn')
  })

  it('五条同时触发时按固定顺序返回（审计可对表）', () => {
    const findings = checkTransferRisks(
      input({
        amountCents: DEFAULT_LIMITS.nightLargeCents,
        availableCents: 1_000,
        dailyUsedCents: 499_000,
        payeeBinding: 'new',
        at: NIGHT,
        recentOutCount: 9,
      }),
    )
    expect(findings.map((item) => item.code)).toEqual([
      'insufficient-balance',
      'daily-limit-exceeded',
      'payee-new',
      'night-large-amount',
      'velocity-high',
    ])
  })

  it('没有触发项时返回空数组（allow 的依据）', () => {
    expect(checkTransferRisks(input())).toEqual([])
  })
})

describe('isNight：支持跨零点与非跨零点两种时段', () => {
  const wrap: BankLimits = { ...DEFAULT_LIMITS, nightStartHour: 22, nightEndHour: 6 }
  const plain: BankLimits = { ...DEFAULT_LIMITS, nightStartHour: 1, nightEndHour: 5 }

  it('22→6：23 点与 5 点算夜间，12 点不算', () => {
    expect(isNight(NIGHT, wrap)).toBe(true)
    expect(isNight(Date.UTC(2026, 9, 18, 21, 0, 0), wrap)).toBe(true) // 05:00 +08
    expect(isNight(DAY, wrap)).toBe(false)
  })

  it('1→5：3 点算夜间，6 点不算', () => {
    expect(isNight(Date.UTC(2026, 9, 17, 19, 0, 0), plain)).toBe(true) // 03:00 +08
    expect(isNight(Date.UTC(2026, 9, 17, 22, 0, 0), plain)).toBe(false) // 06:00 +08
  })
})
