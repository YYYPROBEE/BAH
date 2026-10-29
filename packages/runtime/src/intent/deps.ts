/**
 * `intent_resolve` 的依赖面（03 单 §3.8）。
 *
 * WHY deps 注入而不是从 `ToolExecContext` 取：`ToolExecContext` 是最小冻结面
 * （sessionId/callId/signal/ticketId?），不得为意图平面扩它。记忆检索、注入钟、
 * 会话槽位表全部走构造注入，纯函数面与 IO 面由此物理分离。
 */

import type { IntentKind, IntentResolution, SlotName, SlotTable } from './types.ts'
import type { IntentMemoryPort } from './recall.ts'

/** 注入钟：`today()` 必须来自 runner/宿主，不得在模块内读系统时钟。 */
export interface IntentClock {
  today(): string
}

/** 会话级意图状态（槽位两层表 + 追问上下文）。由宿主插件维护，跨 turn 存活。 */
export interface IntentSlotState {
  /**
   * 取本轮的槽位表。
   *
   * `utterance` 用于把「上一轮选择题的 label」认成 `source='user-choice'`：
   * 命中候选 ⇒ 写入 turn 层；未命中 ⇒ 旧问题作废（pendingAsk 置空）。
   */
  slotTable(sessionId: string, utterance: string): SlotTable
  lastTurnKind(sessionId: string): IntentKind | null
  /** 本轮判定收尾：非 memory 来源并入 session 层，记录 pendingAsk 与 lastTurnKind。 */
  commit(sessionId: string, resolution: IntentResolution): void
  /** 同槽位累计追问次数（prompt_ask 的防死循环台账共用此计数）。 */
  askCount(sessionId: string, slot: SlotName): number
  incrementAsk(sessionId: string, slot: SlotName): void
}

export interface IntentToolDeps {
  readonly memory: IntentMemoryPort
  readonly clock: IntentClock
  readonly state: IntentSlotState
  /**
   * 跨场景闸门阈值。由宿主从 `@bah/memory-store` 的 `CROSS_SCENE_MIN_CONFIDENCE` 注入：
   * runtime 不依赖能力层，但全仓仍只有一个真值来源。
   */
  readonly minCrossSceneConfidence: number
}
