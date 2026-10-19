/**
 * 内核·断路器用例（施工单 10 §3 组件 6）。
 * 源用例：`tests/kernel.test.js` 的 breaker 段 2 条全量搬迁；另补缺省阈值与注入时钟。
 * 时间一律显式给出或由 `now` 注入，测试不给真实时钟。
 */

import { describe, expect, it } from 'vitest'

import { Breaker } from './breaker.ts'

describe('Breaker·冻结锁存', () => {
  it('窗口达到阈值即冻结（锁存后不再重复触发）', () => {
    const breaker = new Breaker({ denyThreshold: 2, windowSeconds: 600 })
    expect(breaker.recordDeny(1000)).toBe(false)
    expect(breaker.tripped).toBe(false)
    expect(breaker.recordDeny(2000)).toBe(true)
    expect(breaker.tripped).toBe(true)
    expect(breaker.recordDeny(3000)).toBe(false)
    // 冻结后的拒绝不再进窗口计数——恢复由会话边界负责，本组件不做概率性复活
    expect(breaker.denies).toEqual([1000, 2000])
  })

  it('缺省阈值：窗口 600 秒、5 次拒绝', () => {
    const breaker = new Breaker()
    expect(breaker.denyThreshold).toBe(5)
    expect(breaker.windowMs).toBe(600_000)
    expect(breaker.tripped).toBe(false)
    expect(breaker.recordDeny()).toBe(false)
    expect(breaker.denies).toHaveLength(1)
  })

  it('时钟由 now 注入：省略 at 时取注入值', () => {
    const breaker = new Breaker({ denyThreshold: 2, windowSeconds: 5, now: () => 7000 })
    expect(breaker.recordDeny()).toBe(false)
    expect(breaker.denies).toEqual([7000])
    expect(breaker.recordDeny()).toBe(true)
    expect(breaker.denies).toEqual([7000, 7000])
    expect(breaker.countInWindow(13_000)).toBe(0) // 窗口只有 5 秒：两条都已过期
  })
})

describe('Breaker·滑动窗口剪枝', () => {
  it('窗口外拒绝被剪除', () => {
    const breaker = new Breaker({ denyThreshold: 3, windowSeconds: 1 })
    breaker.recordDeny(1000)
    breaker.recordDeny(1100)
    expect(breaker.countInWindow(1200)).toBe(2)
    expect(breaker.countInWindow(2500)).toBe(0)
    expect(breaker.denies).toEqual([])
  })

  it('恰好落在窗口边界（>= cutoff）的记录保留', () => {
    const breaker = new Breaker({ denyThreshold: 5, windowSeconds: 10 })
    breaker.recordDeny(1000)
    expect(breaker.countInWindow(11_000)).toBe(1)
    expect(breaker.countInWindow(11_001)).toBe(0)
  })

  it('未触阈值时逐条累计，触阈值当条返回 true', () => {
    const breaker = new Breaker({ denyThreshold: 3, windowSeconds: 100 })
    expect(breaker.recordDeny(10)).toBe(false)
    expect(breaker.recordDeny(20)).toBe(false)
    expect(breaker.countInWindow(30)).toBe(2)
    expect(breaker.recordDeny(40)).toBe(true)
    expect(breaker.countInWindow(50)).toBe(3)
  })
})
