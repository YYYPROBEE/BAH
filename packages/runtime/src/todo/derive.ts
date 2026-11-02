/**
 * `deriveTodos`：纯派生器。不落账、不读时钟、无 I/O。
 *
 * ⚠ 同源同序红线：节点状态**一律**取自 `replayPlan()` 的还原结果。本文件不写第二份
 * 事件 reducer——复用即同源，抄写必漂移。继承的既有细节：
 *  - blocked 只能从 `plan/node-blocked` 还原（`node-result` 里没有它）；
 *  - incident 在载荷里是 `failed`，靠 `code` 还原；
 *  - states 跨窗口累积、后写覆盖先写。
 *
 * 事件流还原不出来的两个态，派生规则（normative）：
 *  1. `pending`：order 里存在但 replay 没有记录的节点（从未启动）；
 *  2. `cancelled`：本窗口以 `plan/aborted` 收尾时，无终态记录的节点——引擎的
 *     `cancelRemaining()` 不落 per-node 事件，派生器必须镜像这条语义，否则中断后的
 *     清单会把"已取消"显示成"排队中"。
 */

import { replayPlan } from '../plan/engine.ts'
import { type TodoEntry } from './types.ts'

import type { PlanEventRecord } from '../plan/events.ts'
import type { PlanNodeState } from '../plan/types.ts'

/**
 * @param order   拓扑序节点清单（`plan_propose` 出参 `order`，`kahnSort` 产物）
 * @param history 会话事件流（含 8 个 plan 冻结键；`replayPlan` 自己会过滤非 plan 域与异 planId）
 * @param planId  目标计划
 * @param aborted 本窗口是否以 `plan/aborted` 收尾（cancelled 判定用）
 */
export function deriveTodos(
  order: readonly string[],
  history: readonly PlanEventRecord[],
  planId: string,
  aborted: boolean,
): TodoEntry[] {
  const replay = replayPlan(history, planId)
  const fallback: PlanNodeState = aborted && replay.closed ? 'cancelled' : 'pending'
  return order.map((nodeId, index) => {
    const state = replay.states.get(nodeId) ?? fallback
    return {
      nodeId,
      source: 'plan',
      text: nodeId,
      state,
      ordinal: index,
    } satisfies TodoEntry
  })
}

/** 一轮 `plan/*` 事件是否以 `plan/aborted` 收尾（`plan/completed` 紧跟其后也一样算）。 */
export function windowAborted(history: readonly PlanEventRecord[], planId: string): boolean {
  let aborted = false
  for (const event of history) {
    const data = event.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
    const record = data as Record<string, unknown>
    if (record['planId'] !== planId) continue
    if (event.type === 'plan/created' || event.type === 'plan/resumed') aborted = false
    else if (event.type === 'plan/aborted') aborted = true
  }
  return aborted
}

/**
 * 模型侧条目与 plan 条目的同屏合并（§3.3.3，normative）：
 * plan 在前（按 ordinal），model 在后（按写入序 + 1000 偏移）；
 * `text` 规范化（trim、空白折叠、全角转半角）后重复时**保留 plan 条目**。
 * 纯函数，不落账。
 */
export function mergeTodoEntries(
  planEntries: readonly TodoEntry[],
  modelItems: readonly { readonly text: string; readonly done: boolean }[],
): TodoEntry[] {
  const seen = new Set(planEntries.map((entry) => normalizeText(entry.text)))
  const merged = [...planEntries]
  modelItems.forEach((item, index) => {
    const key = normalizeText(item.text)
    if (seen.has(key)) return
    seen.add(key)
    merged.push({
      nodeId: '',
      source: 'model',
      text: item.text,
      // 模型侧条目没有 9 态；用 succeeded/pending 表达"勾没勾"是投影层的既有词汇
      state: item.done ? 'succeeded' : 'pending',
      ordinal: 1000 + index,
    })
  })
  return merged
}

/** 规范化：trim、连续空白折叠、全角 ASCII 转半角。 */
export function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
}
