/**
 * Session-follow 客户端状态机（施工单 13 §3.1）。
 *
 * 只做三件事，且都能在 node 里断言（不依赖 EventSource）：
 * 1. **不重**：`seq <= maxSeq` 的帧直接丢弃（重连补发 / 服务端重复推送都靠它兜底）；
 * 2. **不丢**：`seq > maxSeq + 1` 视为缺口 → 请求全量重同步（宁可重放，不要静默漏一条）；
 * 3. **不胀**：缓冲帧数超过上限 → 重同步（长会话 + 慢消费的兜底）。
 *
 * 传输层（EventSource / WebSocket / 桌面壳 IPC）不在这里：本类只吃 `WebFrame`，
 * 这样"桌面端注入 boots 后独立运行"（施工单 13 §0 第 5 条）不需要改一行 follow 逻辑。
 */

import type { SnapshotFrame, WebFrame } from './frames.ts'
import { frameSeq } from './frames.ts'

/** follow 配置。 */
export interface FollowOptions {
  /** 缓冲帧上限（默认 512）：超过即重同步。 */
  readonly bufferLimit?: number
}

/** 一帧的处置结论。 */
export type FollowDecision =
  | { readonly kind: 'apply'; readonly frames: readonly WebFrame[] }
  | { readonly kind: 'drop'; readonly reason: 'replayed' | 'resyncing' }
  | { readonly kind: 'resync'; readonly reason: 'overflow' | 'gap'; readonly since: 0 }

/** 默认缓冲上限。 */
export const DEFAULT_FOLLOW_BUFFER_LIMIT = 512

/** 会话跟随状态机。 */
export class SessionFollow {
  private readonly bufferLimit: number
  private max = 0
  private buffered = 0
  private resyncing = false

  constructor(options: FollowOptions = {}) {
    this.bufferLimit = options.bufferLimit ?? DEFAULT_FOLLOW_BUFFER_LIMIT
  }

  /** 重连时应带的 `since`（= 本端已应用的最大 `seq`）。 */
  since(): number {
    return this.max
  }

  /** 是否正在等待重同步。 */
  isResyncing(): boolean {
    return this.resyncing
  }

  /** 清空（换会话 / 主动重连）。 */
  reset(): void {
    this.max = 0
    this.buffered = 0
    this.resyncing = false
  }

  /**
   * 吃一帧。
   *
   * @returns 处置结论；`apply` 的 `frames` 是要交给视图的帧
   */
  accept(frame: WebFrame): FollowDecision {
    if (frame.kind === 'snapshot') return this.acceptSnapshot(frame)
    if (this.resyncing) return { kind: 'drop', reason: 'resyncing' }

    const seq = frameSeq(frame)
    if (seq === undefined) {
      // `delta` 是 ephemeral：不推进 seq，但也不能在等待重同步时污染界面
      return { kind: 'apply', frames: [frame] }
    }
    if (seq <= this.max) return { kind: 'drop', reason: 'replayed' }

    if (seq > this.max + 1) {
      this.resyncing = true
      this.buffered = 0
      return { kind: 'resync', reason: 'gap', since: 0 }
    }

    this.max = seq
    this.buffered += 1
    if (this.buffered > this.bufferLimit) {
      this.resyncing = true
      this.buffered = 0
      return { kind: 'resync', reason: 'overflow', since: 0 }
    }
    return { kind: 'apply', frames: [frame] }
  }

  /** 快照：整体替换语义，直接把游标推到服务端的 `maxSeq`。 */
  private acceptSnapshot(frame: SnapshotFrame): FollowDecision {
    this.max = frame.maxSeq
    this.buffered = 0
    this.resyncing = false
    return { kind: 'apply', frames: [frame] }
  }
}
