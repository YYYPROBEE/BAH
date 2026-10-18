/**
 * 内存态会话事件存储（施工单 03 §1.3）。
 *
 * **append-only 是不变量，不是约定**：本类不提供 update / delete，也不暴露可变的内部数组。
 * `seq` 由 append 分配（= 前值 + 1），从 1 开始，单调连续——这是审计与回放的锚点。
 */

import { BahError } from '@bah/util'

import type { SessionEvent, SessionEventMap } from '@bah/core'

import type { AnySessionEvent, AppendOptions, SessionEventType } from './types.ts'
import { SESSION_FORMAT_VERSION } from './types.ts'

/** `append` 需要的时钟（默认 `Date.now`，测试注入 `fixedClock`）。 */
export type SessionClock = () => number

/** 构造选项。 */
export interface SessionStoreOptions {
  /** 时间戳来源（epoch ms）。 */
  readonly now?: SessionClock
  /** 逻辑格式版本（默认 `SESSION_FORMAT_VERSION`）。 */
  readonly formatVersion?: number
}

export class SessionStore {
  /** 只追加的事件数组；对外只给只读视图。 */
  private readonly log: AnySessionEvent[] = []

  private readonly now: SessionClock
  private readonly logFormatVersion: number

  constructor(options: SessionStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.logFormatVersion = options.formatVersion ?? SESSION_FORMAT_VERSION
  }

  /** 逻辑格式版本（`provideSession` 落账用）。 */
  get formatVersion(): number {
    return this.logFormatVersion
  }

  /**
   * 追加一条事件：分配 `seq`、盖时间戳、校验连续性。
   *
   * @param type 事件类型（必须是 `SessionEventMap` 的键）
   * @param data 载荷（形状由 `type` 决定）
   * @param options.ignorable `true` 时旧 reader 可跳过
   */
  append<S extends SessionEventType>(
    type: S,
    data: SessionEventMap[S],
    options: AppendOptions = {},
  ): SessionEvent<S> {
    const seq = this.lastSeq() + 1
    const event: SessionEvent<S> = {
      seq,
      at: this.now(),
      formatVersion: this.logFormatVersion,
      type,
      data,
      ...(options.ignorable === undefined ? {} : { ignorable: options.ignorable }),
    }
    this.log.push(event as AnySessionEvent)
    return event
  }

  /** 全量只读视图（快照副本：调用方无法借此改写日志）。 */
  events(): readonly AnySessionEvent[] {
    return this.log.slice()
  }

  /** 最后一条事件的 `seq`（空日志为 0）。 */
  lastSeq(): number {
    const last = this.log[this.log.length - 1]
    return last === undefined ? 0 : last.seq
  }

  /**
   * 从外部事件恢复（JSONL 回放用）。
   *
   * 只接受**连续**的 `seq`：空洞或重复即抛（append-only 日志不允许断代）。
   */
  restore(events: readonly SessionEvent[]): void {
    for (const event of events) {
      const expected = this.lastSeq() + 1
      if (event.seq !== expected) {
        throw new BahError(
          'session-seq-gap',
          `session: 第 ${event.seq} 条事件的 seq 不连续（期望 ${expected}）`,
          { expected, actual: event.seq, type: event.type },
        )
      }
      this.log.push(event as AnySessionEvent)
    }
  }
}
