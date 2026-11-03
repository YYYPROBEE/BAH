/**
 * 派生投影：从 append-only 日志重建「当前模型可见历史」。
 *
 * 为什么必须从日志派生：模型历史**只有一份真相**（不在内存里另维护影子历史），
 * 回放、回退、压缩重建都靠这条投影。
 *
 * 三条硬规则：
 * 1. 每个 `tool/call` 必须有配对的 `tool/result`——缺了就是「日志空洞」，
 *    派生时直接抛错（防御性检查；补齐由 的失败补偿负责）；
 * 2. 每条 `tool/result` 必须有承载它的 `assistant/message`（`toolCalls` 里能查到 `callId`），
 *    否则 wire 无法重建——同样按空洞处理，**不静默合成**一条 assistant 消息；
 * 3. 表外事件按 `ignorable` 处理：`ignorable: true` 跳过，否则视为 required-on-read 缺失并抛错，
 *    **绝不静默丢弃**。
 *
 * 日志顺序 ≠ wire 顺序：落账顺序是
 * `tool/call → tool/result → assistant/message`（工具跑完，assistant 消息才收尾落账），
 * 而模型 wire 要求「带 tool_calls 的 assistant 消息 → tool 消息」。
 * 所以本投影分两遍：先索引每条 assistant 消息承载的 `callId`，再在**首条** `tool/result`
 * 到达时先输出它的 assistant 消息。这样日志顺序可以按施单排，wire 顺序由投影保证。
 */

import { BahError } from '@bah/util'

import type { AnySessionEvent, DerivedMessage, DeriveOptions } from './types.ts'
import { KNOWN_SESSION_EVENT_TYPES } from './types.ts'

/** 判别收窄后的 assistant / tool 事件（构造模型消息用）。 */
type AssistantEvent = Extract<AnySessionEvent, { type: 'assistant/message' }>
type ToolResultEvent = Extract<AnySessionEvent, { type: 'tool/result' }>

/** 一条 assistant 消息的投影 + 是否已经输出（多条 tool/result 共享同一条消息）。 */
interface AssistantOwner {
  readonly message: DerivedMessage
  emitted: boolean
}

/**
 * 把日志投影成模型历史。
 *
 * **`request/context` 不进历史**（有意的）：运行时上下文不是"消息"，它由提示词装配按
 * reconcile 规则并入请求。把它当 user 消息塞进历史会污染模型可见序列——
 * 本文件对应的用例里有一条钉住这个语义，别顺手"修"。
 *
 * 同理：`turn/*`、`step/*`、`request/header`、`assistant/attempt`、`approval/*`
 * 都是审计与回放用的事件，不产生模型消息。
 *
 * @param events 全量事件（`seq` 应连续；断代由 `SessionStore.restore` 负责）
 * @param options `known` 可注入「旧 reader 认识的事件集合」，用于验证版本容忍策略
 * @throws `BahError('session-unknown-event')` 遇到 required-on-read 的未知事件
 * @throws `BahError('session-log-hole')` 存在没有 `tool/result` 的 `tool/call`，
 *   或存在找不到承载消息的 `tool/result`
 */
export function deriveMessages(
  events: readonly AnySessionEvent[],
  options: DeriveOptions = {},
): DerivedMessage[] {
  const known = options.known ?? KNOWN_SESSION_EVENT_TYPES
  const messages: DerivedMessage[] = []
  /** 未闭合的调用：callId → 名字（用于空洞报错） */
  const openCalls = new Map<string, string>()
  /** callId → 承载它的 assistant 消息（日志顺序可能晚于 tool/result） */
  const owners = new Map<string, AssistantOwner>()
  /**
   * `plan/*` 节点执行产生的 callId（**系统编排，不是模型发起**）。
   *
   * 为什么需要这张表：`plan_execute` 在会话内驱动节点时，每个节点仍走完整 `ToolPipeline`，
   * 于是日志里出现 `tool/call` + `tool/result`，但**没有也不该有**承载它们的
   * `assistant/message`——模型从未发起这些调用，节点结论是由 `plan_execute` 那一条
   * 工具结果汇总回模型的。
   *
   * 两种错误处置都要避免：
   * - 按空洞抛错：任何用过 plan 的会话在**下一轮请求**时崩（`session-log-hole`），
   *   而日志本身是完整的；
   * - 塞进 wire：模型会看到自己"发起过"一个它没发起的调用，还会看到节点级中间结果，
   *   与 `plan_execute` 的汇总重复。
   *
   * 所以规则 2 只对**模型发起**的调用成立；plan 节点仍受规则 1（call/result 必须配对）约束。
   */
  const planCallIds = new Set<string>()

  // 第一遍：未知事件判定 + 索引带 toolCalls 的 assistant 消息
  for (const event of events) {
    if (!known.has(event.type)) {
      // `plan/*` 是 runtime 自己的域事件、不在 `AnySessionEvent` 联合里（见 plan/events.ts
      // 的说明：模块增强不能新增导出），只能按结构读 callId。
      if (String(event.type) === 'plan/node-started') {
        const callId = planCallIdOf(event.data)
        if (callId !== undefined) planCallIds.add(callId)
      }
      if (event.ignorable === true) continue
      throw new BahError(
        'session-unknown-event',
        `session: 第 ${event.seq} 条事件类型 ${event.type} 未知且非 ignorable（required-on-read，拒绝静默丢弃）`,
        { seq: event.seq, type: event.type },
      )
    }
    if (event.type !== 'assistant/message') continue
    const calls = event.data.toolCalls
    if (calls === undefined || calls.length === 0) continue
    const owner: AssistantOwner = { message: assistantMessageOf(event.data), emitted: false }
    for (const call of calls) owners.set(call.callId, owner)
  }

  // 第二遍：投影（tool/result 处先把承载它的 assistant 消息顶到前面）
  for (const event of events) {
    // 旧 reader 不认识的 ignorable 事件：第一遍已放行，这里同样跳过
    if (!known.has(event.type)) continue

    if (event.type === 'assistant/message') {
      const calls = event.data.toolCalls
      if (calls === undefined || calls.length === 0) {
        messages.push(assistantMessageOf(event.data))
        continue
      }
      const owner = owners.get(calls[0]!.callId)
      // 已经在首条 tool/result 处输出过 → 这里不重复
      if (owner !== undefined && owner.emitted) continue
      messages.push(assistantMessageOf(event.data))
      if (owner !== undefined) owner.emitted = true
      continue
    }

    if (event.type === 'tool/result') {
      // plan 节点：配对检查照做（`openCalls` 必须清），但结果**不进 wire**
      // ——它没有承载消息，且结论已由 `plan_execute` 的汇总结果回给模型。
      if (planCallIds.has(event.data.callId)) {
        openCalls.delete(event.data.callId)
        continue
      }
      const owner = owners.get(event.data.callId)
      if (owner === undefined) {
        throw new BahError(
          'session-log-hole',
          `session: tool/result（${event.data.callId}）找不到承载它的 assistant/message——wire 无法重建`,
          { callId: event.data.callId },
        )
      }
      if (!owner.emitted) {
        messages.push(owner.message)
        owner.emitted = true
      }
      openCalls.delete(event.data.callId)
      messages.push(toolMessageOf(event.data))
      continue
    }

    messages.push(...project(event, openCalls))
  }

  if (openCalls.size > 0) {
    const dangling = [...openCalls.entries()].map(([callId, name]) => `${name}#${callId}`).join('、')
    throw new BahError(
      'session-log-hole',
      `session: 日志空洞——以下 tool/call 没有配对的 tool/result：${dangling}`,
      { callIds: [...openCalls.keys()] },
    )
  }

  return messages
}

/**
 * 从 `plan/node-started` 的载荷里取 `callId`（该事件不在 `AnySessionEvent` 联合里，按结构读）。
 *
 * 导出给 `system-prompt/history-cache.ts` 的增量投影共用：两个投影必须用**同一套判据**
 * 认定"哪些 tool/result 属于系统编排"，否则全量 oracle 与增量缓存会给出不同的 wire。
 */
export function planCallIdOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  if (!('callId' in data)) return undefined
  return typeof data.callId === 'string' ? data.callId : undefined
}

/** `assistant/message` → 模型消息（工具调用一并带上，wire 侧靠它配对）。 */
export function assistantMessageOf(data: AssistantEvent['data']): DerivedMessage {
  return {
    role: 'assistant',
    content: data.content,
    ...(data.toolCalls === undefined ? {} : { toolCalls: data.toolCalls }),
  }
}

/** `tool/result` → 模型消息（唯一面向模型的结果）。 */
export function toolMessageOf(data: ToolResultEvent['data']): DerivedMessage {
  return {
    role: 'tool',
    callId: data.callId,
    name: data.name,
    isError: data.isError,
    content: data.content,
  }
}

/** 可按单条事件直接投影的类型（assistant / tool 由调用方按 wire 顺序处理）。 */
type ProjectableEvent = Exclude<
  AnySessionEvent,
  { type: 'assistant/message' } | { type: 'tool/result' }
>

/** 单条事件 → 0..1 条模型可见消息（对判别标签做穷尽 switch， 第 6 条）。 */
function project(event: ProjectableEvent, openCalls: Map<string, string>): DerivedMessage[] {
  switch (event.type) {
    case 'system/message':
      return [{ role: 'system', content: event.data.content }]

    case 'user/message':
      return [{ role: 'user', content: event.data.content }]

    case 'tool/call':
      openCalls.set(event.data.callId, event.data.name)
      return []

    // 以下事件留在日志里供审计/回放，但**不进模型历史**
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
    case 'request/header':
    case 'request/context':
    case 'assistant/attempt':
    case 'approval/asked':
    case 'approval/decided':
    // 成本汇总与压缩摘要：由审计导出与 `system-prompt/reconcile`（折叠投影）消费，
    // 不是模型消息——摘要进历史的方式见 `buildModelHistory`（以一条 user 消息呈现）。
    case 'usage/summary':
    case 'compaction/summary':
    // W05：核验门的判决计数是审计事实，不是模型消息；投影必须显式忽略它
    // （平台表新增键后忘补 case 会抛 `session-unprojected-event`，这里由新增用例钉住）。
    case 'safety/assertion':
      return []

    default: {
      // 表内新增了键却忘了补 case：必须 loud，不能静默把消息丢掉
      const unprojected = event as { type: string }
      throw new BahError(
        'session-unprojected-event',
        `session: 事件类型 ${unprojected.type} 未接投影（SESSION_EVENT_TYPES 新增键后必须补 case）`,
        { type: unprojected.type },
      )
    }
  }
}
