/**
 * 审计平面（施工单 10 §1 映射表第 4 行）：`session/event`（emit）。
 *
 * 职责只有"观察 + 记账"：turn 边界、审批事件、工具调用/结果、判决与拒绝、票据生命周期
 * 全量落 TraceLog。**不产生任何判决**（铁律二），也不修改事件。
 *
 * 附带两项确定性判定（施工单 10 §5 的第 3、4 条触发）：
 * - 同 turn 工具调用数（`tool/call` 计数，供控制平面与 turn-stopping 共用）；
 * - 连续非法参数超阈 → 只绿模式（`policy/downgraded`）。
 */

import type { TraceLog } from '../kernel/index.ts'

import type { SentryBreaker } from './breaker.ts'
import type { SentrySettings } from './config.ts'
import type { SentrySessionEventType } from './events.ts'
import { extractAmountsCents } from './numeric.ts'
import type { SentryState } from './state.ts'

/** `session/event` 载荷的最小结构形状。 */
interface SessionEventLike {
  readonly session: string
  readonly event: {
    readonly type: string
    readonly seq: number
    readonly data: unknown
  }
}

/** 审计平面的装配参数。 */
export interface SentryAuditOptions {
  readonly sessionId: string
  readonly settings: SentrySettings
  readonly state: SentryState
  readonly trace: TraceLog
  readonly breaker: SentryBreaker
  readonly record: (type: SentrySessionEventType, data: unknown) => void
  readonly now: () => number
}

/** 计入"拒绝数"的理由码前缀 / 精确码（工具失败不算拒绝）。 */
const DENIAL_CODES = ['sentry-', 'approval-', 'no-identity', 'verify-locked'] as const

/** 非法参数的理由码（bank 与 LLM 修复层共用）。 */
const INVALID_ARGS_CODE = 'tool-args-invalid'

/**
 * 造 `session/event` 监听器。
 *
 * @returns 同步监听器：只观察/记账，不返回任何判决
 */
export function createAuditListener(options: SentryAuditOptions): (payload: unknown) => void {
  const { sessionId, settings, state, trace, breaker, record, now } = options

  return (payload) => {
    const envelope = payload as SessionEventLike
    const event = envelope.event
    const at = now()

    if (event.type === 'turn/start') {
      const turn = numberField(event.data, 'turn')
      state.beginTurn(turn)
      trace.append({ session: sessionId, kind: 'turn-start', turn, seq: event.seq, at })
      return
    }
    if (event.type === 'turn/end') {
      const turn = numberField(event.data, 'turn')
      trace.append({
        session: sessionId,
        kind: 'turn-end',
        turn,
        reason: turnReasonOf(event.data),
        seq: event.seq,
        at,
      })
      return
    }

    switch (event.type) {
      case 'tool/call': {
        state.noteToolCall()
        trace.append({
          session: sessionId,
          kind: 'tool-call',
          callId: stringField(event.data, 'callId'),
          name: stringField(event.data, 'name'),
          at,
        })
        return
      }
      case 'tool/result': {
        noteResult(state, event.data)
        trace.append({
          session: sessionId,
          kind: 'tool-result',
          callId: stringField(event.data, 'callId'),
          name: stringField(event.data, 'name'),
          isError: booleanField(event.data, 'isError'),
          ...(stringField(event.data, 'code') === undefined
            ? {}
            : { code: stringField(event.data, 'code') }),
          at,
        })
        noteOutcome({ settings, state, trace, breaker, record, sessionId, data: event.data, at })
        return
      }
      case 'assistant/message': {
        const text = textOfBlocks(event.data)
        state.noteAssistant(text)
        trace.append({ session: sessionId, kind: 'assistant', length: text.length, at })
        return
      }
      case 'approval/asked': {
        trace.append({
          session: sessionId,
          kind: 'approval-asked',
          callId: stringField(event.data, 'callId'),
          name: stringField(event.data, 'name'),
          at,
        })
        return
      }
      case 'approval/decided': {
        trace.append({
          session: sessionId,
          kind: 'approval-decided',
          decision: stringField(event.data, 'decision'),
          reason: stringField(event.data, 'reason'),
          at,
        })
        return
      }
      case 'verify/locked': {
        trace.append({ session: sessionId, kind: 'verify-locked', at })
        return
      }
      case 'policy/downgraded': {
        trace.append({ session: sessionId, kind: 'policy-downgraded', at })
        return
      }
      case 'guard/repeat-tool': {
        trace.append({ session: sessionId, kind: 'guard-repeat-tool', at })
        return
      }
      default: {
        if (event.type === 'tier/decided') {
          noteTierDecision({ settings, state, trace, breaker, record, sessionId, data: event.data, at })
          return
        }
        if (event.type.startsWith('ticket/')) {
          trace.append({ session: sessionId, kind: event.type, ticketId: stringField(event.data, 'ticketId'), at })
          return
        }
        if (event.type.startsWith('read/')) {
          state.noteRead()
          trace.append({ session: sessionId, kind: 'read', event: event.type, at })
          return
        }
        // 其余事件（含 sentry/* 自身）只记序号异常时的诊断价值，不重复落账
      }
    }
  }
}

/** `tool/result` 的计数与记账（含金额投影）。 */
function noteResult(state: SentryState, data: unknown): void {
  state.noteToolResult()
  const text = textOfBlocks(data)
  for (const cents of extractAmountsCents(text)) state.noteResultAmount(cents)
}

/** `tier/decided`：拒绝计数 + 非法参数计数（与 `tool/result` 按 callId 去重）。 */
function noteTierDecision(input: {
  settings: SentrySettings
  state: SentryState
  trace: TraceLog
  breaker: SentryBreaker
  record: (type: SentrySessionEventType, data: unknown) => void
  sessionId: string
  data: unknown
  at: number
}): void {
  const { settings, state, trace, breaker, record, sessionId, data, at } = input
  const callId = stringField(data, 'callId')
  const verdict = stringField(data, 'verdict')
  const code = stringField(data, 'code')
  trace.append({
    session: sessionId,
    kind: 'tier-decided',
    callId,
    level: stringField(data, 'level'),
    reason: stringField(data, 'reason'),
    verdict,
    ...(code === undefined ? {} : { code }),
    at,
  })
  if (verdict === 'deny' && callId !== undefined) breaker.recordDeny(callId, at)
  if (code === INVALID_ARGS_CODE && callId !== undefined) noteInvalidArgs(input)
}

/** `tool/result` 的拒绝计数 / 非法参数 / 成功清零。 */
function noteOutcome(input: {
  settings: SentrySettings
  state: SentryState
  trace: TraceLog
  breaker: SentryBreaker
  record: (type: SentrySessionEventType, data: unknown) => void
  sessionId: string
  data: unknown
  at: number
}): void {
  const { state, breaker, data, at } = input
  const callId = stringField(data, 'callId')
  const isError = booleanField(data, 'isError') === true
  const code = stringField(data, 'code')

  if (!isError) {
    // 一次干净的成功结果说明模型已经回到正轨：连续计数清零
    state.invalidArgsStreak = 0
    return
  }
  if (callId === undefined) return
  if (code === INVALID_ARGS_CODE) noteInvalidArgs(input)
  if (code !== undefined && isDenialCode(code)) breaker.recordDeny(callId, at)
}

/** 非法参数计数 → 超阈降级（只绿模式，落 `policy/downgraded`）。 */
function noteInvalidArgs(input: {
  settings: SentrySettings
  state: SentryState
  trace: TraceLog
  record: (type: SentrySessionEventType, data: unknown) => void
  sessionId: string
  data: unknown
  at: number
}): void {
  const { settings, state, trace, record, sessionId, data, at } = input
  const callId = stringField(data, 'callId')
  if (callId === undefined) return
  if (!state.markInvalidArgs(callId)) return
  state.invalidArgsStreak += 1
  if (state.degraded) return
  if (state.invalidArgsStreak < settings.degrade.invalidArgsThreshold) return

  state.degraded = true
  trace.bump('escalations')
  trace.append({
    session: sessionId,
    kind: 'policy-downgraded',
    invalidArgs: state.invalidArgsStreak,
    threshold: settings.degrade.invalidArgsThreshold,
    at,
  })
  record('policy/downgraded', {
    sessionId,
    invalidArgs: state.invalidArgsStreak,
    threshold: settings.degrade.invalidArgsThreshold,
    at,
  })
}

/** 理由码是否算"拒绝"（工具执行失败不算）。 */
function isDenialCode(code: string): boolean {
  return DENIAL_CODES.some((prefix) => code.startsWith(prefix))
}

/** 从内容块里拼出文本（只认 text 块）。 */
function textOfBlocks(data: unknown): string {
  const record = asRecord(data)
  const content = record?.['content']
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as Readonly<Record<string, unknown>>
    if (item['type'] === 'text' && typeof item['text'] === 'string') parts.push(item['text'])
  }
  return parts.join('\n')
}

/** 读数字字段（缺失/类型错 → 0）。 */
function numberField(data: unknown, key: string): number {
  const value = asRecord(data)?.[key]
  return typeof value === 'number' ? value : 0
}

/** 读字符串字段（缺失/类型错 → `undefined`）。 */
function stringField(data: unknown, key: string): string | undefined {
  const value = asRecord(data)?.[key]
  return typeof value === 'string' ? value : undefined
}

/** `turn/end.reason` 是判别对象（`{kind, reason?}`）：取 kind 作为审计摘要。 */
function turnReasonOf(data: unknown): string | undefined {
  const reason = asRecord(asRecord(data)?.['reason'])
  return reason === undefined ? undefined : stringField(reason, 'kind')
}

/** 读布尔字段（缺失/类型错 → `undefined`）。 */
function booleanField(data: unknown, key: string): boolean | undefined {
  const value = asRecord(data)?.[key]
  return typeof value === 'boolean' ? value : undefined
}

/** 安全地按对象读取。 */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}
