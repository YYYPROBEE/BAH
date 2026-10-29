/**
 * 人工接管（C5）的指标派生（W16 的 200 行预算把它从 `metrics.ts` 拆出来）。
 *
 * 两层真相源，各有各的职责：
 * - **历史**（进入 / 交回 / 坐席发言 / 超时告警）从会话事件现算；
 * - **现在**（`active`）从状态机读——事件只说明"曾经发生过"。
 */

/** 计数所需的最小事件形状（结构类型：不 import 事件表，避免种类增强顺序影响）。 */
export interface HandoffMetricEvent {
  readonly type: string
  readonly at: number
}

/** 状态机侧的两个事实（`HandoffHandle` 的子集）。 */
export interface HandoffMetricsSource {
  readonly active: boolean
  readonly slaMs: number
}

/** 输出段（`/api/metrics.handoff`）。 */
export interface HandoffMetrics {
  readonly active: boolean
  readonly entered: number
  readonly resumed: number
  readonly operatorMessages: number
  readonly timeoutWarned: number
  readonly lastWaitedMs: number | null
  readonly slaMs: number | null
}

export interface HandoffMetricsAccumulator {
  /** 消费一条事件；返回 `true` 表示这条是接管事件（调用方 `continue`）。 */
  ingest(event: HandoffMetricEvent): boolean
  snapshot(): HandoffMetrics
}

/** 造一个累积器（遍历事件时逐条喂，最后取一次快照）。 */
export function createHandoffMetrics(source: HandoffMetricsSource): HandoffMetricsAccumulator {
  let entered = 0
  let resumed = 0
  let operatorMessages = 0
  let timeoutWarned = 0
  let lastWaitedMs: number | null = null
  let enterAt: number | undefined

  return {
    ingest(event) {
      // 走 `String(type)`：`handoff/*` 是 appendDomain 的领域事件，不受事件表冻结键约束
      const kind = String(event.type)
      if (kind === 'handoff/requested') {
        entered += 1
        enterAt = event.at
        return true
      }
      if (kind === 'handoff/resumed') {
        resumed += 1
        // 只认成对的 enter→resume：没有配对的 enter 不算时长（不猜）
        if (enterAt !== undefined) {
          lastWaitedMs = Math.max(0, event.at - enterAt)
          enterAt = undefined
        }
        return true
      }
      if (kind === 'handoff/operator-message') {
        operatorMessages += 1
        return true
      }
      if (kind === 'handoff/timeout-warned') {
        timeoutWarned += 1
        return true
      }
      return false
    },

    snapshot() {
      return {
        active: source.active,
        entered,
        resumed,
        operatorMessages,
        timeoutWarned,
        lastWaitedMs,
        // null = 未配 SLA（0 表示只记录不告警），与 `halt: null` 同一种"没装就没有"口径
        slaMs: source.slaMs > 0 ? source.slaMs : null,
      }
    },
  }
}
