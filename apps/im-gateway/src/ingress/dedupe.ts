/**
 * 平台无关的入站去重（施工单 02 §2.10）。
 *
 * WHY 必须去重：微信在 5 秒内没收到响应会**重试 3 次**，同一个 `MsgId` 会重复到达。
 * 不去重就是"用户发一句、模型跑三轮、回复三遍"，且其中两轮的上下文已经错位。
 *
 * 键的口径：`platform + accountKey + msgId`。没有 msgId 的平台用
 * `sha256(userId|createTime|content)` 代替——不含字符分隔歧义（NUL 分隔），
 * 也不把 userId 原文写进任何可读位置（键只在进程内的 Map 里）。
 *
 * 边界（如实登记）：进程内 LRU，网关重启丢窗口；微信只重试 3 次，重启丢窗口可接受。
 */

import { createHash } from 'node:crypto'

import type { ImInbound } from '@bah/channels'

import { DEDUPE_CAPACITY, DEDUPE_TTL_MS } from '../config.ts'

/**
 * 算一条入站消息的去重键。
 *
 * 事件消息没有 `messageId`，因此落到哈希分支：`userId|createTime|text`
 * 三者相同即视为同一事件（微信的事件重试也保持这三项）。
 */
export function inboundDedupeKey(inbound: ImInbound): string {
  const base = `${inbound.platform}\u0000${inbound.accountKey}`
  const messageId = inbound.messageId
  if (messageId !== undefined && messageId.length > 0) return `${base}\u0000m:${messageId}`
  const digest = createHash('sha256')
    .update(`${inbound.userId}|${String(inbound.at)}|${inbound.text}`)
    .digest('hex')
    .slice(0, 32)
  return `${base}\u0000h:${digest}`
}

/** 去重器接口。 */
export interface Dedupe {
  /** 登记并返回"是否已见过"；`true` 表示这是重复（调用方应回 success 且不跑 turn）。 */
  seen(key: string): boolean
  /** 当前条目数（测试/`/healthz` 用）。 */
  size(): number
}

/** 去重器依赖。 */
export interface DedupeOptions {
  readonly capacity?: number
  readonly ttlMs?: number
  readonly nowMs: () => number
}

/**
 * 造一个 LRU + TTL 去重器。
 *
 * @param options 见 {@link DedupeOptions}
 */
export function createDedupe(options: DedupeOptions): Dedupe {
  const capacity = options.capacity ?? DEDUPE_CAPACITY
  const ttlMs = options.ttlMs ?? DEDUPE_TTL_MS
  /** Map 的迭代顺序即"最近使用序"：命中时删后重插，等于移到队尾。 */
  const entries = new Map<string, number>()

  const expired = (at: number): boolean => options.nowMs() - at > ttlMs

  const evict = (): void => {
    while (entries.size > capacity) {
      const first = entries.keys().next()
      if (first.done === true) return
      entries.delete(first.value)
    }
  }

  return {
    seen(key: string): boolean {
      const at = entries.get(key)
      if (at !== undefined) {
        if (!expired(at)) {
          entries.delete(key)
          entries.set(key, at)
          return true
        }
        entries.delete(key)
      }
      entries.set(key, options.nowMs())
      evict()
      return false
    },

    size(): number {
      return entries.size
    },
  }
}
