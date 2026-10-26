/**
 * Web 渠道的固定窗口限流。
 *
 * 单机演示不是网关：这里只挡住“脚本误刷 / 页面重连风暴”这类本机事故，
 * 不承诺分布式限流，也不替代反向代理的 WAF。
 */

export interface RateLimitOptions {
  readonly windowMs: number
  readonly maxRequests: number
}

export interface RateLimitVerdict {
  readonly ok: boolean
  /** 被拒时建议等待的秒数；放行时为 0。 */
  readonly retryAfterSec: number
}

interface Bucket {
  readonly start: number
  count: number
}

/** 桶表上限：本机演示的 key 是 remoteAddress，正常只有个位数。 */
const MAX_BUCKETS = 1024

/** 造一个按 key 计数的固定窗口限流器（`now` 由调用方注入，便于测试）。 */
export function createRateLimiter(options: RateLimitOptions): {
  check(key: string, now: number): RateLimitVerdict
} {
  const buckets = new Map<string, Bucket>()

  const prune = (now: number): void => {
    for (const [key, bucket] of buckets) {
      if (now - bucket.start >= options.windowMs || now < bucket.start) buckets.delete(key)
    }
  }

  return {
    check(key, now) {
      const bucket = buckets.get(key)
      if (bucket === undefined || now - bucket.start >= options.windowMs || now < bucket.start) {
        buckets.set(key, { start: now, count: 1 })
        if (buckets.size > MAX_BUCKETS) prune(now)
        return { ok: true, retryAfterSec: 0 }
      }
      if (bucket.count >= options.maxRequests) {
        return {
          ok: false,
          retryAfterSec: Math.max(1, Math.ceil((bucket.start + options.windowMs - now) / 1000)),
        }
      }
      bucket.count += 1
      return { ok: true, retryAfterSec: 0 }
    },
  }
}
