/**
 * 主动提醒 → 行内提示帧（ADR-0016）。
 *
 * ## 为什么主动提醒必须有"帧"这一层
 *
 * 主动推送没有 `tool/call` 作承载点——`tool/result` 只覆盖"用户先开口"的那条路。
 * 要让"用户没问也看得见"这件事在**回放**里同样成立，唯一的承载点就是事件本身：
 * `proactive/reminder` 落进 `session.jsonl` → 投影成 `notice` → 刷新后仍在。
 *
 * 这与 `read/risk-questions` 是同一类"必要的例外"（领域事件也产帧），不是新机制。
 *
 * ## 三条纪律
 *
 * 1. **只画真的送出去的那一条**：`channel='none'` 是被预算压掉的（静默时段 / 日上限 /
 *    去重），它只进审计，不该出现在对话里——否则用户会看到一条"没送达的提醒"。
 * 2. **不新增帧 kind**：复用既有 `notice`（前端已有渲染与稳定键 `notice:<seq>`）。
 * 3. **级别只到 `info`**：主动提醒不抢审批的 `warning`/`danger`；等级升档要有新的契约，
 *    而不是在投影层按文案猜。
 *
 * 纯函数：不读时钟、不读随机、不抛错（载荷可能来自旧版本的日志）。
 */

import type { NoticeFrame } from './frames.ts'

/** 允许出现在对话里的投递渠道（`none` 不算投递）。 */
const DELIVERED = new Set(['in-app', 'im'])

/**
 * 一条 `proactive/reminder` 载荷 → 提示帧。
 *
 * @param data 事件 `data`（形状不可信：旧日志 / 坏样本）
 * @param seq 会话事件的序号（同时是前端的稳定键 `notice:<seq>`）
 * @param at 事件时刻（注入钟）
 * @returns 形状不合格、或该条被预算压掉时返回 `undefined`（**不显示**，不是错误）
 */
export function proactiveNoticeOf(data: unknown, seq: number, at: number): NoticeFrame | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Readonly<Record<string, unknown>>
  const channel = record['channel']
  if (typeof channel !== 'string' || !DELIVERED.has(channel)) return undefined
  const title = record['title']
  if (typeof title !== 'string' || title.length === 0) return undefined
  return { kind: 'notice', seq, at, level: 'info', title }
}
