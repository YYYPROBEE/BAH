/**
 * `intent:plane`：意图平面的宿主接线（03 单 §4 步 9）。
 *
 * ## 它接了什么
 *
 * | 方向 | 挂点 | 为什么 |
 * |---|---|---|
 * | 工具 | `runtime:tools` 注册 `intent_resolve` | D5：新能力做成内置工具，落账走既有 `tool/call` + `tool/result` |
 * | 契约 | `runtime:tool-contracts`（两个工具一起注册） | 一个服务只能有一个提供者（重复 provide 抛 `service-conflict`），所以合并成一份 source |
 * | 状态 | `bah:intent-state` | 槽位两层表与追问台账必须跨 turn 存活；`ToolExecContext` 是最小冻结面，不扩它 |
 * | 记忆 | 可选 `bah:memory-store` | 装配了就用真实层；没装配用配置里的确定性夹具（演示/评测） |
 *
 * ## 诚实边界（写进文档）
 *
 * - 真实记忆层（`bah:memory-store`）的 `RetrievedMemory` **没有结构化槽位**，只有
 *   `renderedText`。本单不解析自然语言去"猜"槽位，所以真实记忆只贡献 `routeCode`
 *   （该不该追问）与候选文本，**不填 filled**。结构化槽位回填需要 memory-store 侧
 *   提供字段，属后续单；演示与评测用 `demoMemory` 夹具。
 * - 配置的 `demoMemory` 是**确定性假记忆**，不是生产路径：生产 profile 不写它。
 */

import { defineService } from '@bah/core'
import {
  CROSS_SCENE_MIN_CONFIDENCE,
  NULL_BANK_QUERY,
  SCENE_SET,
  type Scene,
} from '@bah/memory-store'
import {
  INTENT_RESOLVE_SCHEMA,
  INTENT_RESOLVE_TOOL,
  SLOT_NAMES,
  createIntentResolveTool,
  type AskHint,
  type FilledSlot,
  type IntentKind,
  type IntentMemoryItem,
  type IntentMemoryPort,
  type IntentRecallQuery,
  type IntentRecallResult,
  type IntentResolution,
  type IntentSlotState,
  type SlotName,
  type SlotTable,
} from '@bah/runtime'
import { PROMPT_ASK_ARGS, PROMPT_ASK_SCHEMA, PROMPT_ASK_TOOL, type PromptAskLedger } from '@bah/interaction'
import { RUN_SERVICE } from '../boot.ts'
import {
  SESSION_SERVICE,
  TOOLS_SERVICE,
  provideToolContracts,
  type ToolRegistry,
} from '@bah/runtime'

import type { Context, ServiceKey } from '@bah/core'
import type { HostPlugin } from '../../plugin-manager/index.ts'
import { bootError, readBoolean, readString, rejectUnknownKeys } from '../config.ts'
import { MEMORY_SERVICE } from './memory.ts'

const WHERE = 'intent:plane'

/** 追问台账的计数键上限（防配置面被塞进任意字符串）。 */
const SLOT_SET: ReadonlySet<string> = new Set(SLOT_NAMES)

/** 演示/评测用的确定性记忆条目。 */
export interface DemoMemoryEntry {
  readonly unitId: string
  readonly scene: string
  readonly confidence: number
  /**
   * 只在这句话包含该片段时才命中（可选）。
   * WHY 需要它：同一场景的多条夹具（王建国的历史转账 / 两条张伟）不能互相污染——
   * 不带匹配条件的夹具会让「上次那个转账」把两个张伟也算进候选，直接变成歧义。
   */
  readonly match?: string
  readonly fields: readonly { readonly name: SlotName; readonly value: string | number }[]
}

export interface IntentPlaneSettings {
  readonly enabled: boolean
  readonly tenant: string
  readonly userId: string
  /** 未装配 `bah:memory-store` 时使用的确定性夹具；生产留空。 */
  readonly demoMemory: readonly DemoMemoryEntry[]
}

/** 会话级意图状态的服务键（`prompt:ask` 按它复用追问计数）。 */
export interface IntentStateApi extends IntentSlotState, PromptAskLedger {}

export const INTENT_STATE_SERVICE: ServiceKey<IntentStateApi> = defineService<IntentStateApi>(
  'bah:intent-state',
)

/** 一个会话的意图状态。turn 层在 commit 时清空并并入 session 层。 */
interface SessionState {
  turn: Partial<Record<SlotName, FilledSlot>>
  session: Partial<Record<SlotName, FilledSlot>>
  readonly askCount: Map<string, number>
  lastKind: IntentKind | null
  pendingAsk: AskHint | null
}

/**
 * 会话状态的唯一实现。
 *
 * 为什么不用 `Map<SessionId, SlotTable>` 直接存：`SlotTable` 是不可变快照，
 * 而 user-choice 的识别发生在「读表」这一刻，需要一个可写的 pendingAsk。
 */
class SessionIntentState implements IntentStateApi {
  private readonly sessions = new Map<string, SessionState>()

  private stateOf(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionState = { turn: {}, session: {}, askCount: new Map(), lastKind: null, pendingAsk: null }
    this.sessions.set(sessionId, created)
    return created
  }

  slotTable(sessionId: string, utterance: string): SlotTable {
    const state = this.stateOf(sessionId)
    const pending = state.pendingAsk
    if (pending !== null) {
      const text = utterance.trim()
      const chosen = pending.candidates.find((candidate) => String(candidate.value) === text)
      if (chosen !== undefined) {
        // 点选 = 一条普通用户消息（D6）：它的来源是 user-choice，优先级最高
        state.turn[chosen.name] = { ...chosen, source: 'user-choice' }
      }
      // 命中与否旧问题都作废：用户改口时旧问题不该继续追问
      state.pendingAsk = null
    }
    return { turn: { ...state.turn }, session: { ...state.session }, askCount: {} }
  }

  lastTurnKind(sessionId: string): IntentKind | null {
    return this.stateOf(sessionId).lastKind
  }

  commit(sessionId: string, resolution: IntentResolution): void {
    const state = this.stateOf(sessionId)
    for (const slot of resolution.filled) {
      // 记忆复现值未经用户确认，不许并入会话层（跨 turn 污染）
      if (slot.source === 'memory') continue
      // 并入后来源标成 session：下一轮按「继承值」对待（原来源只在本轮的 filled 里可见）
      state.session[slot.name] = { ...slot, source: 'session' }
    }
    state.turn = {}
    state.lastKind = resolution.kind
    state.pendingAsk = resolution.decision === 'ask' ? resolution.askHint : null
  }

  askCount(sessionId: string, slot: string): number {
    return this.stateOf(sessionId).askCount.get(slot) ?? 0
  }

  incrementAsk(sessionId: string, slot: string): void {
    const state = this.stateOf(sessionId)
    state.askCount.set(slot, (state.askCount.get(slot) ?? 0) + 1)
  }

  // PromptAskLedger 的同义方法：追问台账与槽位计数是同一份数据，不做两份记账
  count(sessionId: string, slot: string): number {
    return this.askCount(sessionId, slot)
  }

  increment(sessionId: string, slot: string): void {
    this.incrementAsk(sessionId, slot)
  }

  reset(): void {
    this.sessions.clear()
  }
}

/** 真实记忆层的适配：只贡献 routeCode 与候选文本（不解析 renderedText 猜槽位）。 */
function realMemoryPort(ctx: Context, settings: IntentPlaneSettings): IntentMemoryPort {
  return {
    async retrieve(query: IntentRecallQuery): Promise<IntentRecallResult> {
      const handle = ctx.get(MEMORY_SERVICE)
      const session = ctx.get(SESSION_SERVICE)
      const result = await handle.layer.retrieveMemory(NULL_BANK_QUERY, {
        tenant: settings.tenant,
        user_id: settings.userId,
        session_id: String(session.sessionId),
        scene: toScene(query.scene),
        maxK: query.maxK,
        ...(query.crossSceneRef === undefined
          ? {}
          : {
              crossSceneRef: {
                target: toTargetScene(query.crossSceneRef.target),
                confidence: query.crossSceneRef.confidence,
              },
            }),
      })
      /* v8 ignore start —— 真实记忆层在本单只跑空库（装配了记忆插件的端到端面在 04 单）：
         映射形状由 IntentMemoryItem 的类型签名保证；这里保留逐字段映射而不是 `as` 断言，
         等记忆层真的有了结构化字段时，编译期会逼着补齐 */
      const memories: IntentMemoryItem[] = result.memories.map((memory) => ({
        unitId: memory.unitId,
        sceneTag: memory.sourceScene,
        confidence: memory.confidence,
        renderedText: memory.renderedText,
        // 结构化槽位：真实记忆没有这个面（见文件头「诚实边界」），不编造
        fields: [],
      }))
      /* v8 ignore stop */
      const ref = query.crossSceneRef
      return {
        memories,
        routeCode: result.routeCode,
        ...(ref === undefined ? {} : { crossSceneRef: { ...ref, accepted: result.routeCode === 'ROUTE_OK' } }),
      }
    },
  }
}

function toScene(scene: string): Scene | 'unknown' {
  return SCENE_SET.has(scene) ? (scene as Scene) : 'unknown'
}

function toTargetScene(scene: string): Scene {
  // 跨场景目标不能是 unknown（记不清就按转账兜底，由 confidence 闸门决定借不借）
  return SCENE_SET.has(scene) ? (scene as Scene) : 'transfer'
}

/** 确定性假记忆：演示与评测的唯一来源；按 scene 过滤，跨场景按注入阈值判借还。 */
export function demoMemoryPort(
  entries: readonly DemoMemoryEntry[],
  minConfidence: number,
): IntentMemoryPort {
  return {
    async retrieve(query: IntentRecallQuery): Promise<IntentRecallResult> {
      if (query.scene === 'unknown') return { memories: [], routeCode: 'EMPTY_UNKNOWN_SCENE' }
      const memories: IntentMemoryItem[] = entries
        .filter((entry) => entry.scene === query.scene)
        .filter((entry) => entry.match === undefined || query.utterance.includes(entry.match))
        .map((entry) => ({
          unitId: entry.unitId,
          sceneTag: entry.scene,
          confidence: entry.confidence,
          renderedText: entry.fields.map((field) => `${field.name}=${String(field.value)}`).join('，'),
          fields: entry.fields,
        }))
      const ref = query.crossSceneRef
      if (ref === undefined) return { memories, routeCode: 'ROUTE_OK' }
      const accepted = ref.confidence >= minConfidence
      return {
        memories: accepted ? memories : [],
        routeCode: accepted ? 'ROUTE_OK' : 'CROSS_SCENE_REFUSED',
        crossSceneRef: { ...ref, accepted },
      }
    },
  }
}

/** 记忆端口选择：装配了真实层就用它，否则用夹具。 */
function memoryPortOf(ctx: Context, settings: IntentPlaneSettings): IntentMemoryPort {
  try {
    ctx.get(MEMORY_SERVICE)
    return realMemoryPort(ctx, settings)
  } catch {
    return demoMemoryPort(settings.demoMemory, CROSS_SCENE_MIN_CONFIDENCE)
  }
}

/** 今天（YYYY-MM-DD）：取注入钟，不读系统时钟。 */
function todayOf(ctx: Context): string {
  const ms = ctx.get(RUN_SERVICE).now()
  return new Date(ms).toISOString().slice(0, 10)
}

export const intentPlanePlugin: HostPlugin<IntentPlaneSettings> = {
  id: WHERE,

  plugin: {
    name: WHERE,
    apply(ctx, settings) {
      if (!settings.enabled) return

      const registry = (): ToolRegistry => ctx.get(TOOLS_SERVICE)
      const state = new SessionIntentState()
      ctx.effect(() => {
        state.reset()
      })
      ctx.effect(ctx.provide(INTENT_STATE_SERVICE, state))

      const deps = {
        memory: memoryPortOf(ctx, settings),
        clock: { today: () => todayOf(ctx) },
        state,
        minCrossSceneConfidence: CROSS_SCENE_MIN_CONFIDENCE,
      }

      const tool = createIntentResolveTool(deps)
      ctx.effect(registry().register(tool))

      // 两个工具的契约一起注册：契约服务只能有一个提供者
      ctx.effect(
        provideToolContracts(ctx, {
          get(name: string) {
            if (name === INTENT_RESOLVE_TOOL) {
              return { argsSchema: tool.schema, resultSchema: INTENT_RESOLVE_SCHEMA, validateAt: 'pre-execute' }
            }
            if (name === PROMPT_ASK_TOOL) {
              return { argsSchema: PROMPT_ASK_ARGS, resultSchema: PROMPT_ASK_SCHEMA, validateAt: 'pre-execute' }
            }
            return undefined
          },
        }),
      )
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['enabled', 'tenant', 'userId', 'demoMemory'], WHERE)
    return {
      enabled: readBoolean(config, 'enabled', WHERE, true),
      tenant: readString(config, 'tenant', WHERE) ?? 'demo',
      userId: readString(config, 'userId', WHERE) ?? 'u-1',
      demoMemory: parseDemoMemory(config['demoMemory'], WHERE),
    }
  },
}

/** 解析演示记忆夹具：任何形状错误都 fail-loud（宁可不装，也不装一份读不懂的记忆）。 */
export function parseDemoMemory(raw: unknown, where: string): readonly DemoMemoryEntry[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw bootError('invalid-config', `${where}.demoMemory 必须是数组`)
  const entries: DemoMemoryEntry[] = []
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw bootError('invalid-config', `${where}.demoMemory[${String(index)}] 必须是对象`)
    }
    const record = item as Record<string, unknown>
    const scene = record['scene']
    if (typeof scene !== 'string' || !SCENE_SET.has(scene)) {
      throw bootError('invalid-config', `${where}.demoMemory[${String(index)}].scene 必须是已知场景`)
    }
    const confidence = record['confidence'] ?? 0.8
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      throw bootError('invalid-config', `${where}.demoMemory[${String(index)}].confidence 必须 ∈ [0,1]`)
    }
    const rawFields = record['fields']
    if (typeof rawFields !== 'object' || rawFields === null || Array.isArray(rawFields)) {
      throw bootError('invalid-config', `${where}.demoMemory[${String(index)}].fields 必须是对象`)
    }
    const fields: { name: SlotName; value: string | number }[] = []
    for (const [name, value] of Object.entries(rawFields as Record<string, unknown>)) {
      if (!SLOT_SET.has(name)) {
        throw bootError('invalid-config', `${where}.demoMemory[${String(index)}].fields 含未知槽位 ${name}`)
      }
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw bootError('invalid-config', `${where}.demoMemory[${String(index)}].fields.${name} 必须是字符串或数字`)
      }
      fields.push({ name: name as SlotName, value })
    }
    const unitId = typeof record['unitId'] === 'string' ? record['unitId'] : `demo-${String(index)}`
    const match = record['match']
    if (match !== undefined && (typeof match !== 'string' || match.length === 0)) {
      throw bootError('invalid-config', `${where}.demoMemory[${String(index)}].match 必须是非空字符串`)
    }
    entries.push({ unitId, scene, confidence, match, fields })
  }
  return entries
}
