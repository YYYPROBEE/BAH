/**
 * 压缩的落账动作（施工单 05 §5「摘要本身作为会话事件落账」）。
 *
 * 单独成一个文件的原因：`index.ts` 只做 re-export（覆盖率按文件统计，
 * 把逻辑写在入口里会逃过门禁）。
 */

import type { SessionEvent } from '@bah/core'

import type { SessionApi, SessionSink } from '../session/service.ts'
import type { CompactionPlan, CompactionThresholds } from './types.ts'
import { planCompaction } from './summarize.ts'

/**
 * 把计划里的摘要落成 `compaction/summary` 事件。
 *
 * @returns 落账的事件；`plan.needed === false` 时返回 `undefined`（无事可做不是错误）
 */
export function appendCompactionSummary(
  session: SessionSink,
  plan: CompactionPlan,
): SessionEvent<'compaction/summary'> | undefined {
  if (!plan.needed || plan.data === undefined) return undefined
  return session.append('compaction/summary', plan.data)
}

/** 一次压缩运行的结果。 */
export interface CompactionRun {
  readonly plan: CompactionPlan
  /** 已落账的摘要事件（未触发压缩时缺省）。 */
  readonly event?: SessionEvent<'compaction/summary'>
}

/**
 * 判定 + 落账一步到位（主循环在 turn 边界调用即可）。
 *
 * 注意：**不改写历史**——压缩的可见效果由投影层（`collapseEvents`）产生，
 * 日志永远是 append-only 的（施工单 03 §1.1）。
 */
export function runCompaction(session: SessionApi, thresholds: CompactionThresholds): CompactionRun {
  const plan = planCompaction({ events: session.events(), thresholds })
  const event = appendCompactionSummary(session, plan)
  return event === undefined ? { plan } : { plan, event }
}
