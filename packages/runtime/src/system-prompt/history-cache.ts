/**
 * 模型历史的增量投影（报告 P-P2）。
 *
 * `buildModelHistory` 是**全量 oracle**；本文件在"无压缩摘要"的会话上按事件增量维护
 * 同一结果，避免每个 step 都对全量日志做 7 次遍历。
 *
 * 两条安全边界：
 * 1. 一旦出现 `compaction/summary`，直接回退全量 `buildModelHistory`——压缩会折叠任意旧 turn，
 *    增量失效；
 * 2. 每次取快照都做与 `deriveMessages` 相同的空洞校验（open call / 无主 result）。
 */

import { BahError } from '@bah/util'

import { assistantMessageOf, planCallIdOf, toolMessageOf } from '../session/derive.ts'
import { KNOWN_SESSION_EVENT_TYPES } from '../session/types.ts'
import type { AnySessionEvent, DerivedMessage } from '../session/types.ts'
import { buildModelHistory } from './reconcile.ts'

type AssistantEvent = Extract<AnySessionEvent, { type: 'assistant/message' }>
type ToolResultEvent = Extract<AnySessionEvent, { type: 'tool/result' }>

/** 一次会话的增量状态。 */
class ModelHistoryProjection {
  private readonly messages: DerivedMessage[] = []
  private readonly runtimeContexts = new Set<DerivedMessage>()
  private readonly openCalls = new Map<string, string>()
  private readonly emittedCalls = new Set<string>()
  private readonly pendingResults: ToolResultEvent[] = []
  /** 系统编排（`plan/*`）产生的 callId：与 `deriveMessages` 同一判据，结果不进 wire。 */
  private readonly planCallIds = new Set<string>()
  private systemMessage: DerivedMessage | undefined
  private lastSeq = 0

  ingest(event: AnySessionEvent): void {
    if (event.seq <= this.lastSeq) return
    this.lastSeq = event.seq
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type)) {
      if (String(event.type) === 'plan/node-started') {
        const callId = planCallIdOf(event.data)
        if (callId !== undefined) this.planCallIds.add(callId)
      }
      if (event.ignorable === true) return
      throw new BahError(
        'session-unknown-event',
        `session: 第 ${event.seq} 条事件类型 ${event.type} 未知且非 ignorable（required-on-read，拒绝静默丢弃）`,
        { seq: event.seq, type: event.type },
      )
    }

    switch (event.type) {
      case 'system/message':
        if (this.systemMessage !== undefined) {
          const index = this.messages.indexOf(this.systemMessage)
          if (index >= 0) this.messages.splice(index, 1)
        }
        this.systemMessage = { role: 'system', content: event.data.content }
        this.messages.unshift(this.systemMessage)
        return

      case 'request/context':
        for (const message of this.runtimeContexts) {
          const index = this.messages.indexOf(message)
          if (index >= 0) this.messages.splice(index, 1)
        }
        this.runtimeContexts.clear()
        return

      case 'user/message': {
        const message: DerivedMessage = { role: 'user', content: event.data.content }
        if (event.data.source === 'runtime-context') this.runtimeContexts.add(message)
        this.messages.push(message)
        return
      }

      case 'tool/call':
        this.openCalls.set(event.data.callId, event.data.name)
        return

      case 'tool/result': {
        this.openCalls.delete(event.data.callId)
        // plan 节点：配对检查照做，但不进 wire（无承载消息，结论由 plan_execute 汇总）
        if (this.planCallIds.has(event.data.callId)) return
        if (this.emittedCalls.has(event.data.callId)) {
          this.emittedCalls.delete(event.data.callId)
          this.messages.push(toolMessageOf(event.data))
        } else {
          // 日志顺序是 result → assistant；承载消息尚未出现，先挂起
          this.pendingResults.push(event)
        }
        return
      }

      case 'assistant/message': {
        const message = assistantMessageOf(event.data)
        this.messages.push(message)
        const calls = event.data.toolCalls
        if (calls === undefined || calls.length === 0) return
        for (const call of calls) this.emittedCalls.add(call.callId)
        this.flushPending(calls.map((call) => call.callId))
        return
      }

      default:
        // 其余平台/领域事件不进模型历史；压缩摘要由调用方在 ingest 前回退全量
        return
    }
  }

  snapshot(events: readonly AnySessionEvent[]): DerivedMessage[] {
    if (this.pendingResults.length > 0) {
      const callIds = this.pendingResults.map((event) => event.data.callId)
      throw new BahError(
        'session-log-hole',
        `session: tool/result（${callIds.join('、')}）找不到承载它的 assistant/message——wire 无法重建`,
        { callIds },
      )
    }
    if (this.openCalls.size > 0) {
      const dangling = [...this.openCalls.entries()]
        .map(([callId, name]) => `${name}#${callId}`)
        .join('、')
      throw new BahError(
        'session-log-hole',
        `session: 日志空洞——以下 tool/call 没有配对的 tool/result：${dangling}`,
        { callIds: [...this.openCalls.keys()] },
      )
    }
    return this.messages
  }

  private flushPending(callIds: readonly string[]): void {
    const wanted = new Set(callIds)
    for (let index = 0; index < this.pendingResults.length; ) {
      const result = this.pendingResults[index]
      if (result === undefined || !wanted.has(result.data.callId)) {
        index += 1
        continue
      }
      this.pendingResults.splice(index, 1)
      this.emittedCalls.delete(result.data.callId)
      this.messages.push(toolMessageOf(result.data))
    }
  }
}

/** 会话 → 增量投影缓存（WeakMap：会话对象回收即释放）。 */
const caches = new WeakMap<object, { seq: number; projection: ModelHistoryProjection }>()

/** 增量版 `buildModelHistory(session.events())`（带压缩的会话自动回退全量）。 */
export function modelHistoryOf(session: {
  eventsView(): readonly AnySessionEvent[]
  lastSeq(): number
}): DerivedMessage[] {
  const events = session.eventsView()
  let entry = caches.get(session)
  if (entry === undefined || entry.seq > session.lastSeq() || events.length < entry.seq) {
    // 首次/回退：只有已存在的压缩摘要才需要全量；否则从空投影开始
    if (events.some((event) => event.type === 'compaction/summary')) {
      caches.delete(session)
      return buildModelHistory(events)
    }
    entry = { seq: 0, projection: new ModelHistoryProjection() }
    caches.set(session, entry)
  }

  // seq 连续且 1 基：从已处理条数直接续读，避免每 step 扫全量日志
  for (let index = entry.seq; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) break
    if (event.type === 'compaction/summary') {
      caches.delete(session)
      return buildModelHistory(events)
    }
    entry.projection.ingest(event)
    entry.seq = event.seq
  }
  return entry.projection.snapshot(events)
}
