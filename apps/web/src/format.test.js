/**
 * `formatWaited` 纯函数（B3）。
 *
 * 边界比正常值重要：客户端时钟回拨 / 负等待不能显示成 `-0:01`。
 */

import { describe, expect, it } from 'vitest'

import { formatWaited } from './format.js'

describe('formatWaited', () => {
  it('0 / 59999 / 60000 / 3600000', () => {
    expect(formatWaited(0)).toBe('0:00')
    expect(formatWaited(59_999)).toBe('0:59')
    expect(formatWaited(60_000)).toBe('1:00')
    expect(formatWaited(3_600_000)).toBe('1:00:00')
  })

  it('小时以上带 h:mm:ss，且分钟/秒补零', () => {
    expect(formatWaited(3_661_000)).toBe('1:01:01')
    expect(formatWaited(45_296_000)).toBe('12:34:56')
  })

  it('负数 / NaN / 非数字一律按 0（时钟回拨不显示负数）', () => {
    expect(formatWaited(-1)).toBe('0:00')
    expect(formatWaited(Number.NaN)).toBe('0:00')
    expect(formatWaited('1000')).toBe('0:00')
    expect(formatWaited(undefined)).toBe('0:00')
  })
})
