/**
 * 打扰策略（G6）：三档重要度 + 日上限 + 静默时段 + 去重窗口。
 *
 * 纯函数：不读时钟（`at` 入参）、不读随机、不写日志、不落账。
 * 计数从**事件派生**的发送历史里数（第二个真相源一定漂移，见 I1）。
 *
 * 档位：
 * - `alert`：异常 / 失败补偿（安全信息，静默时段与日上限都不拦，只去重）；
 * - `decision`：需要用户做决定（静默时段不推，避免半夜叫醒）；
 * - `exec`：执行播报（最低档：静默时段不推、日上限拦、且受最小间隔约束——可以攒到下一条一起说）。
 */

import { wallClockAt } from '../authorization/recurrence.ts'

/** 通知预算（由宿主配置）。 */
export interface NotifyBudget {
  /** 每自然日（UTC+8）最多推送条数。 */
  readonly dailyCap: number
  /** 静默时段 `[start, end)`（允许跨零点，如 `[22, 8]`）。 */
  readonly quietHours: readonly [number, number]
  /** 同档两次推送的最小间隔（毫秒）。 */
  readonly minGapMs: number
}

/** 重要度三档。 */
export type NotifyPriority = 'exec' | 'decision' | 'alert'

/** 一条已发送记录（派生自事件；不落账）。 */
export interface NotifyHistoryItem {
  readonly at: number
  readonly priority: NotifyPriority
  /** 去重键（如 `plan:<id>:<occurrence>`）；缺省不参与去重。 */
  readonly key?: string
}

/** 待发的一条候选。 */
export interface NotifyCandidate {
  readonly priority: NotifyPriority
  readonly at: number
  readonly key?: string
}

/** 决策理由（封闭联合；时间轴上原样显示）。 */
export type NotifyReason = 'ok' | 'quiet-hours' | 'daily-cap' | 'low-priority' | 'dedup'

/** 决策。 */
export interface NotifyDecision {
  readonly send: boolean
  readonly channel: 'in-app' | 'im' | 'none'
  readonly reason: NotifyReason
}

/** 缺省预算：一天 6 条、22:00–08:00 静默、同档最小间隔 5 分钟。 */
export const DEFAULT_NOTIFY_BUDGET: NotifyBudget = {
  dailyCap: 6,
  quietHours: [22, 8],
  minGapMs: 5 * 60 * 1000,
}

/** `at` 所在的 UTC+8 自然日键（日上限按它分组）。 */
function dayKeyOf(at: number): string {
  const wall = wallClockAt(at)
  return `${String(wall.year)}-${String(wall.month)}-${String(wall.day)}`
}

/** 小时是否落在静默时段（支持跨零点）。 */
export function inQuietHours(hour: number, quiet: readonly [number, number]): boolean {
  const [start, end] = quiet
  if (start === end) return false
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

/**
 * 判定一条通知该不该发。
 *
 * 判定顺序（不可重排）：去重 → 静默时段 → 日上限 → 最小间隔。
 * `alert` 只在去重这一步被拦（安全信息不因"太晚"或"今天说得够多了"而丢）。
 */
export function deriveNotify(
  history: readonly NotifyHistoryItem[],
  candidate: NotifyCandidate,
  budget: NotifyBudget = DEFAULT_NOTIFY_BUDGET,
): NotifyDecision {
  if (
    candidate.key !== undefined &&
    history.some(
      (item) =>
        item.key === candidate.key && candidate.at >= item.at && candidate.at - item.at < budget.minGapMs,
    )
  ) {
    return { send: false, channel: 'none', reason: 'dedup' }
  }

  const hour = wallClockAt(candidate.at).hour
  if (candidate.priority !== 'alert' && inQuietHours(hour, budget.quietHours)) {
    return { send: false, channel: 'none', reason: 'quiet-hours' }
  }

  const today = dayKeyOf(candidate.at)
  const sentToday = history.filter((item) => dayKeyOf(item.at) === today).length
  if (candidate.priority !== 'alert' && sentToday >= budget.dailyCap) {
    return { send: false, channel: 'none', reason: 'daily-cap' }
  }

  if (candidate.priority === 'exec') {
    const lastExec = [...history]
      .filter((item) => item.priority === 'exec' && item.at <= candidate.at)
      .sort((left, right) => right.at - left.at)[0]
    if (lastExec !== undefined && candidate.at - lastExec.at < budget.minGapMs) {
      return { send: false, channel: 'none', reason: 'low-priority' }
    }
  }

  return { send: true, channel: 'in-app', reason: 'ok' }
}
