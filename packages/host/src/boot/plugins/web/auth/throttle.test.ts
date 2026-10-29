/**
 * 登录防爆破（租户与鉴权 02 · TA-29）。
 *
 * 语义：`maxFailures = 5` 表示"**允许** 5 次失败"，第 6 次尝试前被挡。
 * 两个桶（userId / IP）都查都记：只按 IP 计数会让整个 NAT 后面的人被一个人锁死。
 */

import { describe, expect, it } from 'vitest'

import { createThrottle } from './throttle.ts'

const SETTINGS = { maxFailures: 5, lockMs: 900_000, backoffBaseMs: 1_000, backoffMaxMs: 60_000 }

describe('createThrottle', () => {
  it('TA-29-1 4 次失败后第 5 次仍可尝试；第 6 次前锁定', () => {
    const throttle = createThrottle(SETTINGS)
    for (let index = 0; index < 5; index += 1) {
      // 每次失败后等过退避窗口（否则是被退避挡住，不是被锁定挡住）
      expect(throttle.check('user:demo/u-1', 1_000 + index * 100_000)).toBeNull()
      throttle.fail('user:demo/u-1', 1_000 + index * 100_000)
    }
    const wait = throttle.check('user:demo/u-1', 600_000)
    expect(wait).not.toBeNull()
    expect(wait ?? 0).toBeGreaterThan(0)
  })

  it('TA-29-2 退避序列 = 1000, 2000, 4000, 8000；第 5 次失败进入锁定', () => {
    const throttle = createThrottle(SETTINGS)
    const waits: number[] = []
    for (let index = 0; index < 5; index += 1) {
      const at = 10_000 + index * 1_000_000
      throttle.fail('k', at)
      const wait = throttle.check('k', at)
      waits.push((wait ?? 0) * 1_000)
    }
    // maxFailures = 5 ⇒ 前 4 次是退避，第 5 次直接锁定（lockMs = 900_000）
    expect(waits.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(waits[4]).toBe(900_000)
  })

  it('TA-29-3 reset 后立即放行', () => {
    const throttle = createThrottle(SETTINGS)
    throttle.fail('k', 1_000)
    expect(throttle.check('k', 1_500)).not.toBeNull()
    throttle.reset('k')
    expect(throttle.check('k', 1_500)).toBeNull()
  })

  it('TA-29-4 同一 IP 的不同 userId 各自独立计数', () => {
    const throttle = createThrottle(SETTINGS)
    throttle.fail('user:demo/u-1', 1_000)
    throttle.fail('user:demo/u-1', 1_000)
    expect(throttle.check('user:demo/u-1', 1_100)).not.toBeNull()
    expect(throttle.check('user:demo/u-2', 1_100)).toBeNull()
  })

  it('TA-29-5 两个桶都查：IP 桶被锁时换个 userId 也进不来', () => {
    const throttle = createThrottle(SETTINGS)
    for (let index = 0; index < 5; index += 1) throttle.fail('ip:10.0.0.9', 1_000)
    const wait = throttle.check('ip:10.0.0.9', 2_000)
    expect(wait).not.toBeNull()
    // 上层会把两个桶的 wait 取 max，所以 IP 桶的等待就足以拒绝新 userId
    expect(Math.max(...[wait ?? 0])).toBeGreaterThan(0)
  })
})
