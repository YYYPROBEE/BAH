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

  it('桶表超过上限时清理过期桶，不无限增长', () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 })
    for (let index = 0; index < 1025; index += 1) {
      expect(limiter.check(`k${String(index)}`, 0).ok).toBe(true)
    }
    // 新窗口触发 prune：过期桶被删，新 key 正常放行
    expect(limiter.check('fresh', 2000).ok).toBe(true)
  })
})
