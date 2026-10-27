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

/** 桶表满时给新 key 的拒绝等待秒数（= 一个窗口；窗口结束后桶可被回收）。 */
function bucketTableFullRetryAfter(options: RateLimitOptions): number {
  return Math.max(1, Math.ceil(options.windowMs / 1000))
}

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
      const expired =
        bucket !== undefined && (now - bucket.start >= options.windowMs || now < bucket.start)
      if (bucket === undefined || expired) {
        // 只有**新 key** 会让表变大；表满时先回收过期桶，仍然满就拒绝这个新 key。
        // 不这么做的话"先 prune 再 set"只是把增长推迟一轮：窗口内涌入 1 万个伪造来源时，
        // prune 一个都删不掉，表照样无界增长（内存打满）。
        if (bucket === undefined && buckets.size >= MAX_BUCKETS) {
          prune(now)
          if (buckets.size >= MAX_BUCKETS) {
            return { ok: false, retryAfterSec: bucketTableFullRetryAfter(options) }
          }
        }
        buckets.set(key, { start: now, count: 1 })
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
