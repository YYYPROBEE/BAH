/**
 * 幻觉防护（施工单 10 §4）。
 *
 * 四个机制里本文件负责三个（第四个 `wealth.*` 的 disclaimer / `txnRef` 由施工单 08 落地，
 * 这里只在报告里做接线断言）：
 * 1. `tools/post-execute` 数值对账：声明值 vs `tool/result` 权威值，不一致 → `block`，
 *    纠正文本由七段管线自动追加进上下文（`additionalContexts`）；
 * 2. `agent/turn-stopping` 无工具结果不陈述：本 turn 没有任何工具结果却陈述账户事实 → 纠正；
 * 3. `agent/turn-stopping` 全 turn 数值复核：声明金额与权威金额无交集 → 纠正。
 *
 * 纠正为什么走 `nudge`（宿主注入）而不是直接 append：turn-stopping 的纠正必须作为
 * **下一条 next-step 用户消息**回到模型，才能真的改变下一次生成（施工单 04 §2.1 的注释）。
 */

import type { TraceLog } from '../kernel/index.ts'

import type { SentrySettings } from './config.ts'
import type { SentrySessionEventType } from './events.ts'
import { extractAmountsCents, formatAmounts } from './numeric.ts'
import type { SentryState } from './state.ts'

/** 内容块（只依赖结构形状；不 import `@bah/core` 的类型也能工作，但这里用它的形状）。 */
interface ContentBlockLike {
  readonly type: string
  readonly text?: string
}

/** `tools/post-execute` 载荷的最小结构形状。 */
interface PostExecuteLike {
  readonly call: { readonly callId: string; readonly name: string; readonly args: Readonly<Record<string, unknown>> }
  readonly content: readonly ContentBlockLike[]
  readonly verdict:
    | { readonly kind: 'accept' }
    | { readonly kind: 'block'; readonly reason: string; readonly code: string }
    | { readonly kind: 'replace'; readonly content: readonly ContentBlockLike[] }
    | { readonly kind: 'addContext'; readonly texts: readonly string[] }
}

/** `agent/turn-stopping` 载荷的最小结构形状。 */
interface TurnStoppingLike {
  readonly agent: { readonly id: string }
  readonly turn: number
  stop(reason?: string): void
}

/** 幻觉防护的装配参数。 */
export interface SentryHonestyOptions {
  readonly sessionId: string
  readonly settings: SentrySettings
  readonly state: SentryState
  readonly trace: TraceLog
  readonly record: (type: SentrySessionEventType, data: unknown) => void
  readonly now: () => number
  /** 把纠正提示推回 inbox 的 `next-step` 车道（宿主注入 `Agent.send(..., target:'next-step')`）。 */
  readonly nudge: (agentId: string, text: string) => void
}

/** 账户事实类陈述的特征（余额 / 账户 / 交易… + 断言词或数字）。 */
const ACCOUNT_FACT =
  /(余额|可用余额|账户|尾号|卡号|交易|流水|到账|收益|持仓|额度)[^。！？\n]{0,16}(是|为|有|¥|￥|\d)/

/**
 * 造 `tools/post-execute` 监听器（数值对账 → `block` + 纠正文本）。
 *
 * @returns 只在"下游已 accept 且发现不一致"时改写判决；其余一律原样交还
 */
export function createNumericListener(
  options: SentryHonestyOptions,
): (payload: unknown, next: (value: unknown) => Promise<unknown>) => Promise<unknown> {
  const { sessionId, settings, state, trace, record, now } = options

  return async (payload, next) => {
    const input = payload as PostExecuteLike
    const downstream = (await next(payload)) as PostExecuteLike
    if (!settings.honesty.numeric) return downstream
    if (downstream.verdict.kind !== 'accept') return downstream

    const authoritative = amountsOfBlocks(downstream.content)
    if (authoritative.length === 0) return downstream
    const declared = declaredInTurn(state.assistantTexts, input.call.args)
    if (declared.length === 0) return downstream
    if (intersects(declared, authoritative)) return downstream

    const at = now()
    const reason =
      `【幻觉防护】本 turn 权威数值为 ${formatAmounts(authoritative)}；` +
      `你此前陈述的金额 ${formatAmounts(declared)} 与工具结果不一致，请以工具结果为准。`
    trace.bump('escalations')
    trace.append({
      session: sessionId,
      kind: 'honesty-number-mismatch',
      callId: input.call.callId,
      name: input.call.name,
      declared,
      authoritative,
      at,
    })
    record('sentry/honesty-corrected', {
      turn: state.turn,
      kind: 'numeric',
      detail: reason,
      at,
    })
    // 管线会把 block 的 reason 作为纠正上下文追加（施工单 03 §2.2 ⑥）
    return { ...downstream, verdict: { kind: 'block', code: 'honesty-number-mismatch', reason } }
  }
}

/**
 * 造 `agent/turn-stopping` 监听器（serial；无 next 参数）。
 *
 * 顺序即优先级：工具数超限（判停）> 无结果陈述 > 全 turn 数值复核。
 */
export function createTurnStoppingListener(
  options: SentryHonestyOptions,
): (payload: unknown) => void {
  const { sessionId, settings, state, trace, record, now, nudge } = options

  return (payload) => {
    const input = payload as TurnStoppingLike
    const turn = input.turn
    const at = now()

    // ① 同 turn 工具数超限：停止该 turn（告知模型"换策略"）
    if (state.toolsInTurn > settings.guard.maxToolsPerTurn) {
      if (state.markGuardNotified(turn)) {
        record('guard/repeat-tool', {
          turn,
          tools: state.toolsInTurn,
          limit: settings.guard.maxToolsPerTurn,
          at,
        })
      }
      trace.append({
        session: sessionId,
        kind: 'turn-stopped',
        reason: 'tool-limit',
        tools: state.toolsInTurn,
        at,
      })
      input.stop(
        `同 turn 工具调用数超限（${state.toolsInTurn}/${settings.guard.maxToolsPerTurn}），请换策略`,
      )
      return
    }

    // ② 无工具结果却陈述账户事实
    if (
      settings.honesty.noResult &&
      state.toolResults === 0 &&
      detectAccountFacts(state.assistantTexts)
    ) {
      if (!state.markCorrected(turn)) return
      const detail =
        '【幻觉防护】本 turn 没有任何工具结果，不得陈述账户/交易事实。' +
        '请先调用对应的查询工具，再据实回答。'
      trace.append({ session: sessionId, kind: 'honesty-no-result', turn, at })
      record('sentry/honesty-corrected', { turn, kind: 'no-result', detail, at })
      nudge(input.agent.id, detail)
      return
    }

    // ③ 全 turn 数值复核（assistant 文本 vs 本 turn 权威金额）
    if (!settings.honesty.numeric) return
    const declared = declaredInTurn(state.assistantTexts, {})
    const authoritative = state.resultAmounts()
    if (declared.length === 0 || authoritative.length === 0) return
    if (intersects(declared, authoritative)) return
    if (!state.markCorrected(turn)) return

    const detail =
      `【幻觉防护】本 turn 权威数值为 ${formatAmounts(authoritative)}；` +
      `你陈述的金额 ${formatAmounts(declared)} 与工具结果不一致，请以工具结果为准。`
    trace.append({ session: sessionId, kind: 'honesty-number-check', turn, declared, at })
    record('sentry/honesty-corrected', { turn, kind: 'numeric', detail, at })
    nudge(input.agent.id, detail)
  }
}

/**
 * 文本里是否有账户事实类陈述（无工具结果时不得出现）。
 *
 * @param texts assistant 陈述文本
 */
export function detectAccountFacts(texts: readonly string[]): boolean {
  return texts.some((text) => ACCOUNT_FACT.test(text))
}

/** 本 turn 的"声明金额"：assistant 已落账文本 + 工具参数字符串里的金额。 */
function declaredInTurn(
  texts: readonly string[],
  args: Readonly<Record<string, unknown>>,
): number[] {
  const strings = [...texts, ...stringsOf(args)]
  const found = new Set<number>()
  for (const text of strings) {
    for (const cents of extractAmountsCents(text)) found.add(cents)
  }
  return [...found].sort((left, right) => left - right)
}

/** 内容块文本里的金额（权威值）。 */
function amountsOfBlocks(blocks: readonly ContentBlockLike[]): number[] {
  const found = new Set<number>()
  for (const block of blocks) {
    if (block.type !== 'text' || block.text === undefined) continue
    for (const cents of extractAmountsCents(block.text)) found.add(cents)
  }
  return [...found].sort((left, right) => left - right)
}

/** 两个金额集合是否有交集。 */
function intersects(left: readonly number[], right: readonly number[]): boolean {
  const set = new Set(right)
  return left.some((value) => set.has(value))
}

/** 递归收集参数里的字符串值（深度上限防自引用）。 */
function stringsOf(value: unknown, depth = 0): string[] {
  if (depth > 4) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((item) => stringsOf(item, depth + 1))
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap((item) => stringsOf(item, depth + 1))
  }
  return []
}
