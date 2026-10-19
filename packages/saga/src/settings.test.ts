/**
 * T-SA07-007：配置校验（未知键 / 不可关闭的重试 / SLA 次序）载入即抛。
 */

import { describe, expect, it } from 'vitest'

import { parseSagaSettings } from './settings.ts'

describe('parseSagaSettings', () => {
  it('空配置补齐 SA-00 §10 默认值', () => {
    const settings = parseSagaSettings({})
    expect(settings).toMatchObject({
      dbPath: 'saga.sqlite',
      maxParallelBranches: 4,
      maxAttempts: 3,
      probeTimeoutMs: 5000,
      probeLagFactor: 2,
      compBackoff: { baseMs: 30_000, maxMs: 3_600_000, jitter: 0.3 },
      softSlaMs: 86_400_000,
      hardSlaMs: 259_200_000,
      forceCloseMs: 604_800_000,
      reconBatchSize: 200,
      dlqAlertDepth: 10,
      dlqPhoneDepth: 50,
      keyVersion: 1,
    })
    expect(settings.features).toEqual({ b1: true, b2: true, b3: true, b4: true })
  })

  it('未知键载入即抛', () => {
    expect(() => parseSagaSettings({ nope: 1 })).toThrow(/bah-saga: invalid-config/)
  })

  it('maxAttempts 不可配置为 0', () => {
    expect(() => parseSagaSettings({ maxAttempts: 0 })).toThrow(/maxAttempts/)
  })

  it('SLA 必须严格递增', () => {
    expect(() => parseSagaSettings({ softSlaMs: 200, hardSlaMs: 100 })).toThrow(/softSlaMs/)
    expect(() => parseSagaSettings({ hardSlaMs: 300, forceCloseMs: 200 })).toThrow(/hardSlaMs/)
    expect(() => parseSagaSettings({ dlqAlertDepth: 50, dlqPhoneDepth: 10 })).toThrow(/dlqAlertDepth/)
  })

  it('compBackoff 逐字段覆盖且 baseMs ≤ maxMs', () => {
    const settings = parseSagaSettings({ compBackoff: { baseMs: 1000 } })
    expect(settings.compBackoff).toEqual({ baseMs: 1000, maxMs: 3_600_000, jitter: 0.3 })
    expect(() => parseSagaSettings({ compBackoff: { baseMs: 10, maxMs: 5 } })).toThrow(/baseMs/)
  })

  it('features 逐开关校验并拒绝未知键', () => {
    expect(parseSagaSettings({ features: { b2: false } }).features).toEqual({
      b1: true,
      b2: false,
      b3: true,
      b4: true,
    })
    expect(() => parseSagaSettings({ features: { b5: true } })).toThrow(/features/)
    expect(() => parseSagaSettings({ features: { b1: 1 } })).toThrow(/features.b1/)
  })
})
