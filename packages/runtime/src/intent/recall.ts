/**
 * 记忆检索的接线面与跨场景闸门。
 *
 * ## 为什么这里不 import `@bah/memory-store`
 *
 * `@bah/runtime` 是底座（core/llm/util），`@bah/memory-store` 是能力层（依赖 persistence）。
 * 底座反向依赖能力层会把分层翻过来，包图门禁之外更实际的问题是：runtime 的每个使用者
 * 都会被拖进 sqlite。所以这里只声明**结构化端口**（`IntentMemoryPort`），由宿主适配；
 * 0.6 这个常量也由宿主从 `@bah/memory-store` 的 `CROSS_SCENE_MIN_CONFIDENCE` 注入，
 * 全仓仍然只有一个真值来源（host 插件是唯一适配点）。
 *
 * ## routeCode 是「该不该追问」的判据
 *
 * - `ROUTE_OK`（本场景直查或跨场景借入成功）⇒ 不追问，进槽位；借入值 ⇒ requiresPreview
 * - `EMPTY_UNKNOWN_SCENE`（无历史/场景不明）⇒ 追问（指代落不了地）
 * - `CROSS_SCENE_REFUSED`（confidence<0.6 拒借）⇒ 追问 + R-XS-1 建议反问
 */

import { assertNever } from '@bah/util'

import { CROSS_SCENE_WEIGHTS, TARGET_SCENE_HINTS } from './lexicon.ts'

import type { FilledSlot, SlotName } from './types.ts'

/** 路由码：与 `@bah/memory-store` 的 `RouteCode` 同值集（结构化兼容，不 import）。 */
export type IntentRouteCode = 'ROUTE_OK' | 'EMPTY_UNKNOWN_SCENE' | 'CROSS_SCENE_REFUSED'

/** 检索查询：与 `RetrieveQuery` 的**用到的字段**结构兼容。 */
export interface IntentRecallQuery {
  readonly scene: string
  readonly maxK: number
  /** 本轮原话。演示夹具按它选择条目（真实记忆层不看它）。 */
  readonly utterance: string
  readonly crossSceneRef?: { readonly target: string; readonly confidence: number }
}

/** 一条记忆：只带意图平面消费的字段（`fields` 是已归一的槽位值）。 */
export interface IntentMemoryItem {
  readonly unitId: string
  readonly sceneTag: string
  readonly confidence: number
  readonly renderedText: string
  readonly fields: readonly { readonly name: SlotName; readonly value: string | number }[]
}

/** 检索结果：`crossSceneRef` 由适配层回填（真实层从 `logLine.queryPlan` 派生）。 */
export interface IntentRecallResult {
  readonly memories: readonly IntentMemoryItem[]
  readonly routeCode: IntentRouteCode
  readonly crossSceneRef?: { readonly target: string; readonly confidence: number; readonly accepted: boolean }
}

/** 记忆端口：宿主注入。`retrieve` 是意图平面**唯一**的 IO。 */
export interface IntentMemoryPort {
  retrieve(query: IntentRecallQuery): Promise<IntentRecallResult>
}

export interface CrossSceneGate {
  readonly target: string
  readonly confidence: number
  readonly allowed: boolean
  readonly rejectReason: 'low-confidence' | null
}

/** recall 快照：`resolveIntent` 的唯一历史输入。纯数据，可序列化进 evidence 复核。 */
export interface RecallSnapshot {
  readonly routeCode: IntentRouteCode
  readonly memories: readonly IntentMemoryItem[]
  readonly crossScene: CrossSceneGate | null
}

/** 默认召回上限：与 memory-store 的 `DEFAULT_MAX_K` 同量级（适配层可覆盖）。 */
export const DEFAULT_MAX_K = 8

/**
 * 跨场景置信度的确定性整数评分（0–100）。
 *
 * 只来自静态权重表的命中之和：**禁止**从用户话语里解析数字充当 confidence
 * （「confidence 0.99」必须仍按词表评分）。
 */
export function crossSceneConfidence(utterance: string): number {
  let score = 0
  for (const [word, weight] of Object.entries(CROSS_SCENE_WEIGHTS)) {
    if (utterance.includes(word)) score += weight
  }
  return Math.min(score, 100)
}

/** 跨场景目标场景的推断（演示级；真实装配应由场景选择器传入）。 */
export function inferTargetScene(utterance: string): string {
  for (const [scene, pattern] of TARGET_SCENE_HINTS) {
    if (pattern.test(utterance)) return scene
  }
  // 指代落不到具体域时按转账兜底：它是演示里唯一的资金主链，且拒借档会先反问
  return 'transfer'
}

/**
 * 由原话构造检索参数。
 *
 * 只在 `scene === 'cross_scene'` 时构造 `crossSceneRef`：跨场景引用天然是「用户自己说
 * 他在指别处」，别的场景硬塞一个跨域借用等于替用户做主。
 */
export function planRecall(utterance: string, scene: string, maxK: number = DEFAULT_MAX_K): IntentRecallQuery {
  if (scene !== 'cross_scene') return { scene, maxK, utterance }
  return {
    scene,
    maxK,
    utterance,
    crossSceneRef: { target: inferTargetScene(utterance), confidence: crossSceneConfidence(utterance) / 100 },
  }
}

/**
 * 跨场景闸门：`confidence >= minConfidence` 放行。
 *
 * 边界是 `>=`：0.60 恰好放行（与 memory-store `planRoute` 同判），0.59 拒借。
 * `minConfidence` 由宿主注入（唯一真值在 `@bah/memory-store`）。
 */
export function gateCrossScene(
  ref: { readonly target: string; readonly confidence: number } | undefined,
  minConfidence: number,
): CrossSceneGate | null {
  if (ref === undefined) return null
  const allowed = ref.confidence >= minConfidence
  return {
    target: ref.target,
    confidence: ref.confidence,
    allowed,
    rejectReason: allowed ? null : 'low-confidence',
  }
}

/** 把端口结果转成快照。跨场景闸门在此一次性算好，纯函数不再碰阈值。 */
export function toSnapshot(result: IntentRecallResult, minConfidence: number): RecallSnapshot {
  return {
    routeCode: result.routeCode,
    memories: result.memories,
    crossScene: gateCrossScene(result.crossSceneRef, minConfidence),
  }
}

/** routeCode → 是否必须追问。switch 以 assertNever 收尾：memory-store 加值时编译期逼出本文件。 */
export function routeNeedsAsk(snapshot: RecallSnapshot): boolean {
  switch (snapshot.routeCode) {
    case 'ROUTE_OK':
      return false
    case 'EMPTY_UNKNOWN_SCENE':
    case 'CROSS_SCENE_REFUSED':
      return true
    /* v8 ignore start —— IntentRouteCode 是封闭三值联合：default 不可达 */
    default:
      return assertNever(snapshot.routeCode)
    /* v8 ignore stop */
  }
}

/** 记忆条目 → 槽位（source='memory'，confidence 取条目自身值）。资金类槽位会被 requiresPreview 捕获。 */
export function memorySlots(snapshot: RecallSnapshot): readonly FilledSlot[] {
  const slots: FilledSlot[] = []
  for (const memory of snapshot.memories) {
    for (const field of memory.fields) {
      slots.push({ name: field.name, value: field.value, source: 'memory', confidence: memory.confidence })
    }
  }
  return slots
}
