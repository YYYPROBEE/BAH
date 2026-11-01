/**
 * 入站限流。
 *
 * 两级固定窗口：每用户 + 全局。为什么不引令牌桶：
 * 1. 固定窗口只有"计数 + 起点"两个字段，可完整单测；
 * 2. 限流的目的不是"平滑流量"，而是"挡住刷屏与误配置的死循环"——固定窗口足够；
 * 3. 每用户窗口用 LRU 淘汰，避免 1 万个 openid 各占一个窗口把内存吃光。
 */

import {
  RATE_GLOBAL_LIMIT,
  RATE_GLOBAL_WINDOW_MS,
  RATE_USER_LIMIT,
  RATE_USER_WINDOW_MS,
} from '../config.ts'

/** 限流结论。 */
export type RateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly scope: 'user' | 'global'; readonly retryAfterSec: number }

/** 限流器接口。 */
export interface RateLimiter {
  /** 记一次请求并给出结论。 */
  check(userKey: string, nowMs: number): RateVerdict
}

/** 限流器依赖。 */
export interface RateLimiterOptions {
  readonly userLimit?: number
  readonly userWindowMs?: number
  readonly globalLimit?: number
  readonly globalWindowMs?: number
  /** 用户窗口的最大条目数（防内存放大）。 */
  readonly maxUsers?: number
}

/** 一个固定窗口。 */
interface Window {
  startedAt: number
  count: number
}

/**
 * 造一个固定窗口限流器。
 *
 * @param options 见 {@link RateLimiterOptions}
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const userLimit = options.userLimit ?? RATE_USER_LIMIT
  const userWindowMs = options.userWindowMs ?? RATE_USER_WINDOW_MS
  const globalLimit = options.globalLimit ?? RATE_GLOBAL_LIMIT
  const globalWindowMs = options.globalWindowMs ?? RATE_GLOBAL_WINDOW_MS
  const maxUsers = options.maxUsers ?? 20_000

  const users = new Map<string, Window>()
  let global: Window = { startedAt: 0, count: 0 }

  const advance = (window: Window, nowMs: number, windowMs: number): Window => {
    if (nowMs - window.startedAt >= windowMs) return { startedAt: nowMs, count: 0 }
    return window
  }

  return {
    check(userKey: string, nowMs: number): RateVerdict {
      global = advance(global, nowMs, globalWindowMs)
      if (global.count >= globalLimit) {
        return {
          ok: false,
          scope: 'global',
          retryAfterSec: Math.max(1, Math.ceil((global.startedAt + globalWindowMs - nowMs) / 1000)),
        }
      }

      const current = advance(users.get(userKey) ?? { startedAt: nowMs, count: 0 }, nowMs, userWindowMs)
      if (current.count >= userLimit) {
        users.delete(userKey)
        users.set(userKey, current)
        return {
          ok: false,
          scope: 'user',
          retryAfterSec: Math.max(1, Math.ceil((current.startedAt + userWindowMs - nowMs) / 1000)),
        }
      }

      global.count += 1
      const next = { startedAt: current.startedAt, count: current.count + 1 }
      users.delete(userKey)
      users.set(userKey, next)
      while (users.size > maxUsers) {
        const first = users.keys().next()
        if (first.done === true) break
        users.delete(first.value)
      }
      return { ok: true }
    },
  }
}
