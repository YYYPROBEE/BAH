import { describe, expect, it } from 'vitest'

import { scanFrs } from '../../src/deciders/FRS.ts'

/** 四类基线残留谓词（金标可扩展；这里只放两条用于验证机制）。 */
const RESIDUES = {
  pendingSubscription: (state: Readonly<Record<string, unknown>>) =>
    typeof state['subs.pending'] === 'number' && (state['subs.pending'] as number) > 0,
  quotaOccupied: (state: Readonly<Record<string, unknown>>) => state['quota.hold'] === 'occupied',
}

describe('FRS 失败残留扫描', () => {
  // T09
  it('T09 失败终局含挂起订阅判失败，并给出残留清单', () => {
    const result = scanFrs({
      before: { 'subs.pending': 0, 'quota.hold': 'none' },
      after: { 'subs.pending': 1, 'quota.hold': 'none' },
      residuePatterns: RESIDUES,
    })

    expect(result.pass).toBe(false)
    expect(result.residues).toEqual(['pendingSubscription'])
    expect(result.stateRestored).toBe(false)
    expect(result.locator).toBe('frs:residue:pendingSubscription')
  })

  // T10
  it('T10 失败终局回滚到 S₀ 判通过', () => {
    const before = { 'subs.pending': 0, 'quota.hold': 'none' }
    const result = scanFrs({
      before,
      after: { ...before },
      residuePatterns: RESIDUES,
    })

    expect(result.pass).toBe(true)
    expect(result.residues).toHaveLength(0)
    expect(result.stateRestored).toBe(true)
  })

  it('多类残留同时命中时全部列出', () => {
    const result = scanFrs({
      before: { 'subs.pending': 0, 'quota.hold': 'none' },
      after: { 'subs.pending': 2, 'quota.hold': 'occupied' },
      residuePatterns: RESIDUES,
    })

    expect(result.residues).toEqual(['pendingSubscription', 'quotaOccupied'])
    expect(result.locator).toBe('frs:residue:pendingSubscription,quotaOccupied')
  })

  it('显式回滚态视为干净（状态不等于 S₀ 也算通过）', () => {
    const result = scanFrs({
      before: { state: 'executing', 'subs.pending': 0 },
      after: { state: 'rolled-back', 'subs.pending': 0 },
      residuePatterns: RESIDUES,
      rollbackValues: ['rolled-back', 'compensated'],
    })

    expect(result.pass).toBe(true)
    expect(result.rollback).toBe(true)
    expect(result.stateRestored).toBe(false)
  })

  it('回滚键可配置（缺省读 state）', () => {
    const result = scanFrs({
      before: { sagaState: 'executing' },
      after: { sagaState: 'compensated' },
      residuePatterns: {},
      rollbackKey: 'sagaState',
      rollbackValues: ['compensated'],
    })
    expect(result.pass).toBe(true)
  })

  it('状态没回滚且无四类残留命中，仍判失败（未知残留）', () => {
    const result = scanFrs({
      before: { 'subs.pending': 0, 'misc.flag': false },
      after: { 'subs.pending': 0, 'misc.flag': true },
      residuePatterns: RESIDUES,
    })

    expect(result.pass).toBe(false)
    expect(result.residues).toHaveLength(0)
    expect(result.locator).toBe('frs:state-not-restored:state')
  })

  it('成功 episode 也照样扫描（独立于任务成败运行）', () => {
    const result = scanFrs({
      before: { 'subs.pending': 0 },
      after: { 'subs.pending': 3 },
      residuePatterns: RESIDUES,
    })
    // 本函数不接收「成功/失败」入参，就是这条独立性的实现保证。
    expect(result.pass).toBe(false)
  })
})
