/**
 * 确定性夹具自测。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, asTicketId, fixedClock, seededRandom } from './index.ts'

describe('品牌 ID 夹具', () => {
  it('运行时就是字符串（零成本不透明类型）', () => {
    expect(asSessionId('s-1')).toBe('s-1')
    expect(asTicketId('t-1')).toBe('t-1')
  })
})

describe('fixedClock', () => {
  it('now 不推进；tick 按步长推进；advance 按毫秒推进', () => {
    const clock = fixedClock({ start: 1_000, step: 5 })

    expect(clock.now()).toBe(1_000)
    expect(clock.now()).toBe(1_000)
    expect(clock.tick()).toBe(1_005)
    clock.advance(95)
    expect(clock.now()).toBe(1_100)
  })

  it('缺省从 0 开始、步长 1ms', () => {
    const clock = fixedClock()
    expect(clock.now()).toBe(0)
    expect(clock.tick()).toBe(1)
  })
})

describe('seededRandom', () => {
  it('同种子逐位一致（回放可复现）', () => {
    const first = seededRandom(42)
    const second = seededRandom(42)

    expect([first(), first(), first()]).toEqual([second(), second(), second()])
  })

  it('不同种子给出不同序列', () => {
    const first = seededRandom(1)
    const other = seededRandom(2)

    expect([first(), first(), first()]).not.toEqual([other(), other(), other()])
  })

  it('输出落在 [0, 1)', () => {
    const random = seededRandom(2026)
    for (let index = 0; index < 100; index += 1) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
