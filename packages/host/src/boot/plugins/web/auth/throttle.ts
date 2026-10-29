/**
 * 登录防爆破（租户与鉴权 02 · TA-29）：双桶（userId + IP）+ 指数退避 + 锁定。
 *
 * ## 为什么不用 Redis
 *
 * 单进程形态下"登录失败计数"是**局部的**：一个进程就是一个租户，进程内的桶表就是
 * 这个租户的全部。引入 Redis 只会给演示环境加一个必须常驻的依赖。
 *
 * ## 为什么 userId 桶是主判据、IP 桶只是补充
 *
 * 企业对外出网共用 NAT：只按 IP 计数，一个人的连续错误口令会把整个公司锁死。
 * 反过来只按 userId 计数，攻击者换账号撞库就不受约束——所以两个桶都查、都记。
 *
 * ## 诚实边界
 *
 * **不落盘**：进程重启计数清零。攻击者能靠"把服务重启一次"清零，但重启本身是可用性事件，
 * 代价不对等；写进 `docs/security-design.md` 的已知限制。
 */

/** 节流器。 */
export interface Throttle {
  /** 返回 `null` = 放行；否则返回需要等待的秒数（退避或锁定都算"现在别试"）。 */
  check(key: string, now: number): number | null
  /** 只问"是否已锁定"（退避中返回 null）。登录要区分这两者：退避只是延后，锁定才是 409。 */
  locked(key: string, now: number): number | null
  /** 记一次失败（可能触发锁定）。 */
  fail(key: string, now: number): void
  /** 清零（登录成功后调用）。 */
  reset(key: string): void
  /** 当前桶数（诊断 / 测试用）。 */
  size(): number
}

/** 节流器参数（与 `AuthSettings['login']` 同形）。 */
export interface ThrottleSettings {
  readonly maxFailures: number
  readonly lockMs: number
  readonly backoffBaseMs: number
  readonly backoffMaxMs: number
}

/** 单个桶。 */
interface Bucket {
  failures: number
  /** 退避窗口结束时刻（未达上限时用）。 */
  nextAllowedAt: number
  /** 锁定结束时刻（达到上限后）。 */
  lockedUntil: number
}

/** 桶表上限（与 `web-rate-limit.ts` 同策略：满了先清，仍满则拒绝新键）。 */
const MAX_BUCKETS = 1024

/**
 * 造一个节流器。
 *
 * 语义：`maxFailures = 5` 表示"**允许** 5 次失败"，第 6 次尝试前被挡。
 */
export function createThrottle(settings: ThrottleSettings): Throttle {
  const buckets = new Map<string, Bucket>()

  /** 桶是否已经"没有信息量"（退避与锁定都过期）。 */
  const isStale = (bucket: Bucket, now: number): boolean =>
    bucket.lockedUntil <= now && bucket.nextAllowedAt <= now

  const prune = (now: number): void => {
    for (const [key, bucket] of buckets) {
      if (isStale(bucket, now)) buckets.delete(key)
    }
  }

  const bucketOf = (key: string, now: number): Bucket | undefined => {
    const existing = buckets.get(key)
    if (existing !== undefined) return existing
    if (buckets.size >= MAX_BUCKETS) {
      prune(now)
      // 表仍满：**不放行**。与限流器同策略（拒绝比无界增长安全）：
      // 一个伪造 userId 的洪水不该把真实用户的桶挤掉。
      if (buckets.size >= MAX_BUCKETS) return undefined
    }
    return undefined
  }

  const waitSecondsOf = (until: number, now: number): number =>
    Math.max(1, Math.ceil((until - now) / 1000))

  return {
    check(key, now) {
      const bucket = bucketOf(key, now)
      if (bucket === undefined) {
        // 新键：表满时也拒绝（见上）
        if (buckets.size >= MAX_BUCKETS) {
          prune(now)
          if (buckets.size >= MAX_BUCKETS) return Math.max(1, Math.ceil(settings.lockMs / 1000))
        }
        return null
      }
      if (bucket.lockedUntil > now) return waitSecondsOf(bucket.lockedUntil, now)
      if (bucket.nextAllowedAt > now) return waitSecondsOf(bucket.nextAllowedAt, now)
      return null
    },

    fail(key, now) {
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        if (buckets.size >= MAX_BUCKETS) {
          prune(now)
          // 仍满：不再新建桶，但也**不能**因此忽略这次失败——把退避记在"全局"
          // 没有意义，所以这里选择丢弃计数并在下次 check 里拒绝新键（fail-closed）。
          if (buckets.size >= MAX_BUCKETS) return
        }
        bucket = { failures: 0, nextAllowedAt: 0, lockedUntil: 0 }
        buckets.set(key, bucket)
      }
      bucket.failures += 1
      if (bucket.failures >= settings.maxFailures) {
        bucket.lockedUntil = now + settings.lockMs
        bucket.nextAllowedAt = bucket.lockedUntil
        return
      }
      const backoff = Math.min(
        settings.backoffBaseMs * 2 ** Math.max(0, bucket.failures - 1),
        settings.backoffMaxMs,
      )
      bucket.nextAllowedAt = now + backoff
    },

    locked(key, now) {
      const bucket = buckets.get(key)
      if (bucket === undefined || bucket.lockedUntil <= now) return null
      return waitSecondsOf(bucket.lockedUntil, now)
    },

    reset(key) {
      buckets.delete(key)
    },

    size() {
      return buckets.size
    },
  }
}
