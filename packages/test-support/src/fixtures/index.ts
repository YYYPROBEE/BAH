/**
 * 确定性夹具（施工单 12 §7：回放依赖时间/随机 → 全链路注入确定性时钟与 seeded 随机）。
 *
 * 纪律：用例**不得**用 `Date.now()` / `Math.random()` 直接造数据——
 * 一旦上快照回放（施工单 12 §3），不可复现的时间与随机会让回放全等断言失效。
 */

import type { SessionId, TicketId } from '@bah/core'

/**
 * 构造会话 ID 夹具。
 *
 * 跨边界不透明类型只允许在这种「夹具入口」由字面量生成（施工单 00 §10）；
 * 业务代码拿到 `SessionId` 后只能透传，不许再拼字符串。
 */
export function asSessionId(raw: string): SessionId {
  return raw as SessionId
}

/** 构造票据 ID 夹具（理由同 `asSessionId`）。 */
export function asTicketId(raw: string): TicketId {
  return raw as TicketId
}

/** 可控时钟（替代 `Date.now()`）。 */
export interface Clock {
  /** 当前时刻（epoch ms），调用不改变时刻。 */
  now(): number
  /** 前进一个步长并返回新时刻。 */
  tick(): number
  /** 前进指定毫秒。 */
  advance(ms: number): void
}

/**
 * 建一个确定性时钟。
 *
 * @param options.start 起始时刻（默认 0）
 * @param options.step `tick()` 的步长（默认 1ms）
 */
export function fixedClock(options: { start?: number; step?: number } = {}): Clock {
  const step = options.step ?? 1
  let current = options.start ?? 0
  return {
    now: () => current,
    tick: () => {
      current += step
      return current
    },
    advance: (ms) => {
      current += ms
    },
  }
}

/**
 * seeded PRNG（mulberry32）：同种子逐位一致，跨平台稳定。
 *
 * @param seed 32 位种子（可用会话号、场景号等固定值）
 * @returns 返回 `[0, 1)` 的生成器
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
