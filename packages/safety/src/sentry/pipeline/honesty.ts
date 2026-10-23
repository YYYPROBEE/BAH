/**
 * 幻觉防护（施工单 10 §4）。
 *
 * 四个机制里本文件负责三个（第四个 `wealth.*` 的 disclaimer / `txnRef` 由施工单 08 落地，
 * 这里只在报告里做接线断言）：
 * 1. `tools/post-execute` 数值对账：声明值 vs `tool/result` 权威值，不一致 → `block`，
 *    纠正文本由七段管线自动追加进上下文（`additionalContexts`）；
 * 2. `agent/turn-stopping` 无工具结果不陈述：本 turn 没有任何工具结果却陈述账户事实 → 纠正；
 * 3. `agent/turn-stopping` 全 turn 数值复核：声明金额与权威金额无交集 → 纠正；
 * 4. `agent/turn-stopping` **行动断言对账（S-1）**：声称"已完成 / 已转账 / 已核销 /
 *    办理成功 / 已到账"，但本 turn 的工具结局不支持 → 纠正；纠正过一次仍不改口 → 判停。
 *
 * 纠正为什么走 `nudge`（宿主注入）而不是直接 append：turn-stopping 的纠正必须作为
 * **下一条 next-step 用户消息**回到模型，才能真的改变下一次生成（施工单 04 §2.1 的注释）。
 * `nudge` 会让主循环在本 turn 内再跑一个 step——这就是"block 掉正常收尾"的实现方式。
 */

import { assertNever } from '@bah/util'

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

/** 成功行动断言的类别（S-1 只认这几类"办成了"的说法，不猜意图）。 */
export type ActionClaim = 'transfer' | 'redeem' | 'complete'

/** 行动断言的特征（按分句匹配；否定语境在 `NON_SUCCESS` 里排除）。 */
const ACTION_CLAIM_RULES: readonly { readonly kind: ActionClaim; readonly pattern: RegExp }[] = [
  // "到账"单独出现不算：\"预计 2 小时内到账\"是承诺，不是既成事实
  { kind: 'transfer', pattern: /(?:已|已经)(?:转账|转出|支付|汇款|到账)|(?:转账|转出|支付|汇款)成功/ },
  { kind: 'redeem', pattern: /(?:已|已经)?核销|核销成功/ },
  { kind: 'complete', pattern: /(?:已|已经)(?:完成|办妥|处理|受理)|(?:办理|操作|交易)成功/ },
]

/**
 * 否定 / 未完成语境。
 *
 * 同一分句里出现这些词，就不把成功词当断言——"转账未成功"不是"转账成功"。
 * 宁可漏报（少纠正一次）也不误报：误报会让模型把正确回答改错。
 */
const NON_SUCCESS = /(未|没有|没|尚未|还没|无法|失败|拒绝|取消|不成功|待|需|须)/

/** 写操作工具（"已核销 / 已办理"必须有它们之一成功过）。 */
const WRITE_TOOLS = ['transfer_create', 'wealth_purchase'] as const

/**
 * 从 assistant 文本里识别"成功行动断言"。
 *
 * @param texts 本 turn 的 assistant 文本（按落账顺序）
 * @returns 去重后的断言类别（空数组 = 没有断言）
 */
export function detectActionClaims(texts: readonly string[]): ActionClaim[] {
  const found = new Set<ActionClaim>()
  for (const text of texts) {
    for (const clause of text.split(/[。！？!?；;\n]/u)) {
      if (NON_SUCCESS.test(clause)) continue
      for (const rule of ACTION_CLAIM_RULES) {
        if (rule.pattern.test(clause)) found.add(rule.kind)
      }
    }
  }
  return [...found]
}

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

    // ② 行动断言对账（S-1）：只认"办成了"的说法，与工具结局逐类核对
    const claims = detectActionClaims(state.assistantTexts)
    if (claims.length > 0) {
      const unsupported = claims.filter((claim) => {
        if (claim === 'transfer') return !state.hasSuccessfulTool('transfer_create')
        if (claim === 'redeem') return !WRITE_TOOLS.some((tool) => state.hasSuccessfulTool(tool))
        return state.successfulToolCount() === 0
      })
      if (unsupported.length > 0) {
        const labels = unsupported.map(actionLabel)
        const detail =
          `【行动断言】本 turn 的工具结局不支持你声称的「${labels.join('、')}」：` +
          `${unsupported.map(unsupportedReason).join('；')}。` +
          '请据实说明未执行或失败的原因，不得声称已完成。'
        trace.append({
          session: sessionId,
          kind: 'honesty-action-claim',
          turn,
          claims: unsupported,
          succeeded: state.successfulToolCount(),
          failed: state.failedToolNames(),
          at,
        })
        // 第一次纠正：nudge 会让主循环再跑一个 step，正常收尾被"卡住"。
        // 第二次仍不改口：继续 nudge 只会把同一条假话留在日志里，直接判停。
        if (!state.markActionCorrected(turn)) {
          trace.append({ session: sessionId, kind: 'turn-stopped', turn, reason: 'action-claim', at })
          input.stop(
            `行动断言与工具结局不一致（${labels.join('、')}），已纠正过一次仍不改口，本轮停止。`,
          )
          return
        }
        record('sentry/honesty-corrected', { turn, kind: 'action-claim', detail, at })
        nudge(input.agent.id, detail)
        return
      }
    }

    // ③ 无工具结果却陈述账户事实
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

    // ④ 全 turn 数值复核（assistant 文本 vs 本 turn 权威金额）
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

/** 断言类别的中文标签（进模型可见的纠正文案）。 */
function actionLabel(claim: ActionClaim): string {
  switch (claim) {
    case 'transfer':
      return '转账成功'
    case 'redeem':
      return '核销完成'
    case 'complete':
      return '办理完成'
    default:
      // 构造不可达：封闭联合已穷尽（纪律 6 要求收尾）
      /* v8 ignore next */
      return assertNever(claim, 'action-claim')
  }
}

/** "为什么这条断言不成立"的短句（只讲工具结局，不讲内部实现）。 */
function unsupportedReason(claim: ActionClaim): string {
  switch (claim) {
    case 'transfer':
      return '没有成功的转账结果'
    case 'redeem':
      return '没有成功的写操作可供核销'
    case 'complete':
      return '没有任何成功的工具结果'
    default:
      // 构造不可达：封闭联合已穷尽（纪律 6 要求收尾）。
      // 且 `unsupportedReason` 总在 `actionLabel` 之后对同一数组求值，
      // 非法标签会先在上面那个 switch 抛掉——这里连注入路径都不是首个抛点。
      /* v8 ignore next */
      return assertNever(claim, 'action-claim')
  }
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
