/**
 * 运行时上下文的 reconcile 语义。
 *
 * ```text
 * 1. 每次 attempt 装配时刷新渲染                      → beginAttempt() 现算
 * 2. 渲染结果以 user 角色落历史（user/message）        → beginAttempt() 落 `runtime-context`
 * 3. 后续装配核对回收：被移除的从模型历史撤回           → reconcileContextEvents()
 * 4. agent.inject(text) 走同一路径                    → RuntimeContextQueue
 * ```
 *
 * **为什么 `runtime.context` 不拼进 system 头**：
 * system 头是"模型的稳定设定"，一旦掺入随每轮变化的账户余额/最近交易，就变成
 * 每轮都要重发的伪静态文本；把它作为 user 消息落历史，既模型可见、又天然可撤回，
 * 还能在审计里看到"当时给它看了什么"。
 */

import type { AnySessionEvent, DerivedMessage } from '../session/types.ts'
import { deriveMessages } from '../session/derive.ts'
import type { SessionSink } from '../session/service.ts'
import { collapseEvents, summaryMessage } from '../compaction/summarize.ts'
import type { ComposedPrompt } from './types.ts'

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 外部注入队列（agent.inject 的落点）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 待认领的运行时上下文文本。
 *
 * `inject()` 只登记，不落账：落账发生在**下一次被认领的请求**装配时
 * ，这样"用户刚说的话"与"系统注入的说明"
 * 在日志里是同一类事件、同样可审计。
 */
export class RuntimeContextQueue {
  private readonly pending: string[] = []

  /** 登记一段文本（空串忽略：不制造空事件）。 */
  inject(text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    this.pending.push(trimmed)
  }

  /** 取走全部待用文本（FIFO）并清空。 */
  drain(): readonly string[] {
    return this.pending.splice(0, this.pending.length)
  }

  /** 还有几条待用（调试/断言用）。 */
  get size(): number {
    return this.pending.length
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. attempt 装配：刷新渲染 + 落账
 * ──────────────────────────────────────────────────────────────────────────── */

/** `beginAttempt` 的入参。 */
export interface AttemptContextInput {
  /** 落账面（`runtime:session` 服务即满足）。 */
  readonly session: SessionSink
  readonly turn: number
  readonly step: number
  /** 本次装配结果（`PromptRegistry.compose` 的产出）。 */
  readonly composed: ComposedPrompt
  /** 外部注入队列（`agent.inject` 的登记处）。 */
  readonly queue?: RuntimeContextQueue
}

/** `beginAttempt` 的产出（模型可见的运行时上下文文本）。 */
export interface AttemptContextResult {
  /** system 头文本（已落 `system/message`）。 */
  readonly systemText: string
  /** 本次携带的运行时上下文文本（FIFO：先渲染结果，后注入文本）。 */
  readonly contextTexts: readonly string[]
}

/**
 * 一次 attempt 的上下文装配与落账。
 *
 * 落账三件事，顺序固定：
 * 1. `system/message`（装配结果；每次 attempt 一条，投影只认最新一条）；
 * 2. `request/context`（**每次都落**，`texts` 为空表示"本次没有运行时上下文"——
 *    这是 reconcile 判定"哪些上下文已过期"的边界，缺了它旧上下文就撤不掉）；
 * 3. `user/message`（`source: 'runtime-context'`，仅当确有文本时）。
 */
export function beginAttempt(input: AttemptContextInput): AttemptContextResult {
  const injected = input.queue === undefined ? [] : input.queue.drain()
  const rendered = input.composed.context
  const contextTexts: string[] = rendered === undefined ? [] : [rendered, ...injected]

  input.session.append('system/message', { content: input.composed.header })
  input.session.append('request/context', {
    turn: input.turn,
    step: input.step,
    texts: contextTexts,
  })
  if (contextTexts.length > 0) {
    input.session.append('user/message', {
      content: contextTexts.join('\n\n'),
      source: 'runtime-context',
    })
  }

  return { systemText: input.composed.header, contextTexts }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. reconcile：撤回过期上下文与旧系统头
 * ──────────────────────────────────────────────────────────────────────────── */

/** reconcile 结果。 */
export interface ReconcileResult {
  /** 撤回后仍有效的投影事件。 */
  readonly kept: readonly AnySessionEvent[]
  /** 被撤回的事件 `seq`（审计可解释"为什么这段话不在模型上下文里了"）。 */
  readonly withdrawnSeqs: readonly number[]
}

/**
 * 从投影里撤回两类过期内容：
 *
 * 1. **过期的运行时上下文**：`source: 'runtime-context'` 且落在最近一次
 *    `request/context` 之前的 `user/message`（即上一轮及更早的渲染结果）；
 * 2. **旧的系统头**：只保留最后一条 `system/message`——装配结果以最新为准，
 *    把历史装配也塞给模型会让 system 段重复膨胀。
 *
 * 只撤这两类：工具纠正文本（`source: 'context'`）必须留在历史里，否则
 * "被 block 后的纠正"下一轮就丢了（这正是 `runtime-context` 单独分源的原因）。
 */
export function reconcileContextEvents(events: readonly AnySessionEvent[]): ReconcileResult {
  let boundary = 0
  let latestSystem = 0

  for (const event of events) {
    if (event.type === 'request/context') boundary = event.seq
    if (event.type === 'system/message') latestSystem = event.seq
  }

  const kept: AnySessionEvent[] = []
  const withdrawnSeqs: number[] = []

  for (const event of events) {
    if (event.type === 'user/message' && event.data.source === 'runtime-context' && event.seq < boundary) {
      withdrawnSeqs.push(event.seq)
      continue
    }
    if (event.type === 'system/message' && event.seq !== latestSystem) {
      withdrawnSeqs.push(event.seq)
      continue
    }
    kept.push(event)
  }

  return { kept, withdrawnSeqs }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. 模型历史的唯一装配入口
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 从会话日志装配"当前模型可见历史"（**唯一**入口，主循环不许自己拼）。
 *
 * 顺序：折叠（压缩）→ reconcile（撤回过期上下文）→ `deriveMessages`（投影）
 * → 摘要消息插到 system 之后。
 *
 * 摘要为什么插在 system 之后：system 头是身份与安全底线，必须第一个出现；
 * 摘要是"更早对话的替代物"，紧跟其后、位于其余原文之前，模型的阅读顺序才连贯。
 */
export function buildModelHistory(events: readonly AnySessionEvent[]): DerivedMessage[] {
  const collapsed = collapseEvents(events)
  const reconciled = reconcileContextEvents(collapsed.kept)
  const ordered = hoistSystem(deriveMessages(reconciled.kept))
  if (collapsed.summaries.length === 0) return ordered

  const insertAt = ordered[0]?.role === 'system' ? 1 : 0
  return [
    ...ordered.slice(0, insertAt),
    ...collapsed.summaries.map(summaryMessage),
    ...ordered.slice(insertAt),
  ]
}

/**
 * 把 system 头提到最前。
 *
 * 为什么需要：每次 attempt 都会落一条 `system/message`，而旧的那条会被 reconcile 撤回；
 * 一旦中间夹着工具纠正文本（`source: 'context'`），撤回旧 system 后它就会排到新 system 之前。
 * 模型的约定是"system 永远第一条"，所以这里做一次稳定重排（其余消息相对顺序不变）。
 */
function hoistSystem(messages: readonly DerivedMessage[]): DerivedMessage[] {
  const systems = messages.filter((message) => message.role === 'system')
  const rest = messages.filter((message) => message.role !== 'system')
  // 只保留最后一条 system（reconcile 已保证最多一条，这里再兜一次语义）
  return [...systems.slice(-1), ...rest]
}
