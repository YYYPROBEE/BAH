import { describe, expect, it } from 'vitest'

import { createRateLimiter } from './web-rate-limit.ts'

describe('Web 固定窗口限流', () => {
  it('同一 key 超过上限后拒绝，窗口过后恢复', () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 })
    expect(limiter.check('127.0.0.1', 0)).toEqual({ ok: true, retryAfterSec: 0 })
    expect(limiter.check('127.0.0.1', 1)).toEqual({ ok: true, retryAfterSec: 0 })

    const denied = limiter.check('127.0.0.1', 2)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterSec).toBe(1)

    expect(limiter.check('127.0.0.1', 1000)).toEqual({ ok: true, retryAfterSec: 0 })
  })

  it('不同 key 各自计数', () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 })
    expect(limiter.check('a', 0).ok).toBe(true)
    expect(limiter.check('a', 1).ok).toBe(false)
    expect(limiter.check('b', 1).ok).toBe(true)
  })

  it('时钟回拨被视为新窗口，不会永久锁死', () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 })
    expect(limiter.check('a', 100).ok).toBe(true)
    expect(limiter.check('a', 101).ok).toBe(false)
    expect(limiter.check('a', 50).ok).toBe(true)
  })

  it('桶表到硬上限后拒绝新 key，而不是继续增长（D6）', () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 })
    // 窗口内 1024 个不同 key 全部放行，桶表正好打满
    for (let index = 0; index < 1024; index += 1) {
      expect(limiter.check(`k${String(index)}`, 0).ok).toBe(true)
    }
    // 第 1025 个 key：窗口内没有可回收的桶 → 拒绝，且给出一个窗口的等待时间
    const denied = limiter.check('overflow', 0)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterSec).toBe(1)
    // 已有的 key 不受影响（拒绝的是"新面孔"，不是把整站关掉）
    expect(limiter.check('k0', 0).ok).toBe(true)
  })

  it('窗口过期后腾出名额，新 key 恢复放行', () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 })
    for (let index = 0; index < 1024; index += 1) {
      expect(limiter.check(`k${String(index)}`, 0).ok).toBe(true)
    }
    expect(limiter.check('overflow', 0).ok).toBe(false)
    // 过了一个窗口：1024 个旧桶全部过期，prune 之后新 key 正常
    expect(limiter.check('fresh', 2000).ok).toBe(true)
  })
})
