/**
 * sentry 的**进程内会话状态**（四接缝共享的一份观察账本）。
 *
 * 这里不放任何判决逻辑：判决只在 `control.ts`（铁律二）。本文件只回答
 * "这个 turn 发生了什么"——工具数、读结果、assistant 文本、拒绝去重、降级标志。
 *
 * 状态全部由注入时钟/事件驱动，天然可确定性回放；不读写文件、不建定时器。
 */

import { assertNever } from '@bah/util'

import type { RiskLevel } from '../kernel/index.ts'

/** 一次会话的 sentry 观察状态（单 host 进程单会话，仍按会话键持有以备多渠道）。 */
export class SentryState {
  /** 当前 turn 号（`turn/start` 更新）。 */
  turn = 0
  /** 当前 step 号（`agent/pre-step` 更新）。 */
  step = 0
  /** 本 turn 的工具调用数（`tool/call` 计数，turn 边界清零）。 */
  toolsInTurn = 0
  /** 本 turn 的 `tool/result` 数（含失败）。 */
  toolResults = 0
  /** 本 turn 命中的 `read/*` 领域事件数。 */
  readResults = 0
  /** 本 turn 的 assistant 文本（按落账顺序）。 */
  assistantTexts: string[] = []
  /** 本 turn 成功过的工具名（按名称去重；行动断言守卫用它核对"是否真的办成了"）。 */
  private readonly succeededTools = new Set<string>()
  /** 本 turn 失败过的工具名（按名称去重）。 */
  private readonly failedTools = new Set<string>()
  /** 会话累计风险分（入口检测的分数累加，封顶 1）。 */
  riskScore = 0
  /** 会话最高风险等级。 */
  riskLevel: RiskLevel = 'low'
  /** 是否已降级为"只绿模式"（连续非法参数超阈）。 */
  degraded = false
  /** 连续非法参数计数（成功结果清零）。 */
  invalidArgsStreak = 0

  /** 已计入拒绝次数的 callId（`tier/decided` 与 `tool/result` 会对同一次调用各报一次）。 */
  private readonly denyCounted = new Set<string>()
  /** 已计过非法参数的 callId（pre-execute 判决与结果事件去重）。 */
  private readonly invalidArgsCounted = new Set<string>()
  /** 已发过 `guard/repeat-tool` 的 turn（同一 turn 只报一次）。 */
  private readonly guardNotified = new Set<number>()
  /** 已追加过纠正提示的 turn（防止纠正触发的新 step 再次纠正，形成死循环）。 */
  private readonly correctedTurns = new Set<number>()
  /** 已因"行动断言不符"纠正过的 turn（与数值纠正分开：两类纠正的严重度不同）。 */
  private readonly actionCorrectedTurns = new Set<number>()
  /** 本 turn 权威数值（分；来自 `tool/result` 的投影内容）。 */
  private readonly turnResultAmounts = new Set<number>()

  /** turn 边界：清空本 turn 的计数与文本。 */
  beginTurn(turn: number): void {
    this.turn = turn
    this.toolsInTurn = 0
    this.toolResults = 0
    this.readResults = 0
    this.assistantTexts = []
    this.turnResultAmounts.clear()
    this.succeededTools.clear()
    this.failedTools.clear()
  }

  /** 一次工具调用（`tool/call` 落账后调用）。 */
  noteToolCall(): void {
    this.toolsInTurn += 1
  }

  /** 一次工具结果（`tool/result` 落账后调用）。 */
  noteToolResult(): void {
    this.toolResults += 1
  }

  /** 一次 `read/*` 领域结果。 */
  noteRead(): void {
    this.readResults += 1
  }

  /** 一段 assistant 文本（空串忽略）。 */
  noteAssistant(text: string): void {
    if (text.length > 0) this.assistantTexts.push(text)
  }

  /** 一次工具结局（成功 / 失败都按工具名记账；失败不覆盖成功）。 */
  noteToolOutcome(name: string, isError: boolean): void {
    if (isError) this.failedTools.add(name)
    else this.succeededTools.add(name)
  }

  /** 本 turn 是否有某个工具成功过。 */
  hasSuccessfulTool(name: string): boolean {
    return this.succeededTools.has(name)
  }

  /** 本 turn 的成功工具数（按名称去重）。 */
  successfulToolCount(): number {
    return this.succeededTools.size
  }

  /** 本 turn 失败过的工具名（升序副本；只用于审计与纠正文案）。 */
  failedToolNames(): string[] {
    return [...this.failedTools].sort()
  }

  /**
   * 登记一次"行动断言不符"的纠正；同一 turn 只纠正一次。
   *
   * @returns 本次是否为该 turn 的首次纠正（false = 模型已被告知过，仍不改口就该判停）
   */
  markActionCorrected(turn: number): boolean {
    if (this.actionCorrectedTurns.has(turn)) return false
    this.actionCorrectedTurns.add(turn)
    return true
  }

  /** 本 turn 的一个权威数值（分；去重）。 */
  noteResultAmount(cents: number): void {
    this.turnResultAmounts.add(cents)
  }

  /** 本 turn 的全部权威数值（升序副本）。 */
  resultAmounts(): number[] {
    return [...this.turnResultAmounts].sort((left, right) => left - right)
  }

  /**
   * 登记一次拒绝；同一次调用只计一次。
   *
   * @returns 本次是否为该调用的首次计数
   */
  markDeny(callId: string): boolean {
    if (this.denyCounted.has(callId)) return false
    this.denyCounted.add(callId)
    return true
  }

  /**
   * 登记一次非法参数；同一次调用只计一次。
   *
   * @returns 本次是否为该调用的首次计数
   */
  markInvalidArgs(callId: string): boolean {
    if (this.invalidArgsCounted.has(callId)) return false
    this.invalidArgsCounted.add(callId)
    return true
  }

  /** 该 turn 是否已发过工具数超限事件。 */
  markGuardNotified(turn: number): boolean {
    if (this.guardNotified.has(turn)) return false
    this.guardNotified.add(turn)
    return true
  }

  /** 该 turn 是否已追加过纠正提示。 */
  markCorrected(turn: number): boolean {
    if (this.correctedTurns.has(turn)) return false
    this.correctedTurns.add(turn)
    return true
  }

  /** 提高会话风险分（累加封顶 1）并更新最高等级。 */
  raiseRisk(score: number, level: RiskLevel): void {
    this.riskScore = Math.min(1, this.riskScore + score)
    if (rank(level) > rank(this.riskLevel)) this.riskLevel = level
  }
}

/** 风险等级排序（取更高的一档）。 */
function rank(level: RiskLevel): number {
  switch (level) {
    case 'low':
      return 0
    case 'warn':
      return 1
    case 'high':
      return 2
    default:
      return assertNever(level, 'sentry-risk-level')
  }
}
