/**
 * 三态路由：`verified` / `needs-evidence` / `reject`（W05 §1）。
 *
 * 判定只看两样东西：**本 turn 的工具出参**（含权威库命中条目）与**句子语境**。
 * 不调 LLM、不做语义相似度——防护层必须可自证、可重放。
 *
 * | 状态 | 触发条件 | 出口 |
 * |---|---|---|
 * | `verified` | 规范值在证据里；资金动作声明还要求证据带"成功"标记 | 原文发出 |
 * | `needs-evidence` | 找不到证据，但不是"资金动作已完成"的依据 | 整条回复加 `【未核实】` 前缀 |
 * | `reject` | 找不到证据，且句子在声明资金动作已完成 | 整条回复替换为拒答文本 |
 */

import type { Assertion } from './extract.ts'
import { MONEY_ACTION_CLAIM, collectEvidence, extractAssertions } from './extract.ts'
import type { AssertionKind } from './extract.ts'

/** 未核实前缀（TC-W05-09 断言"发出去的文本"以它开头）。 */
export const UNVERIFIED_PREFIX = '【未核实】'

/** 拒答理由码（W13/W14 的拒答正确率按它检索）。 */
export const ASSERTION_REJECT_CODE = 'assertion-unverified'

/** 单条断言的判定结果。 */
export interface AssertionOutcome {
  readonly assertion: Assertion
  readonly status: 'verified' | 'needs-evidence' | 'rejected'
}

/** 一次回复核验的结果（计数与改写文本）。 */
export interface VerifyOutcome {
  readonly total: number
  readonly verified: number
  readonly needsEvidence: number
  readonly rejected: number
  readonly decision: 'pass' | 'annotate' | 'reject'
  /** 应当落账并交给 channels 的文本。 */
  readonly text: string
  readonly assertions: readonly AssertionOutcome[]
}

/** 核验入参。 */
export interface VerifyReplyInput {
  readonly text: string
  /** 本 turn 的工具出参文本 + 权威库命中条目文本。 */
  readonly evidence: readonly string[]
}

/** 拒答文本（稳定理由码：`assertion-unverified`）。 */
export function refusalText(reasonCode: string = ASSERTION_REJECT_CODE): string {
  return `【拒答】回复包含无法核验的资金动作依据，已阻止发送。（reasonCode: ${reasonCode}）`
}

/** 核验一条助手回复。 */
export function verifyReply(input: VerifyReplyInput): VerifyOutcome {
  const assertions = extractAssertions(input.text)
  const evidence = collectEvidence(input.evidence)

  const outcomes: AssertionOutcome[] = assertions.map((assertion) => ({
    assertion,
    status: statusOf(assertion, evidence),
  }))

  const verified = outcomes.filter((item) => item.status === 'verified').length
  const needsEvidence = outcomes.filter((item) => item.status === 'needs-evidence').length
  const rejected = outcomes.filter((item) => item.status === 'rejected').length
  const total = outcomes.length

  if (rejected > 0) {
    return {
      total,
      verified,
      needsEvidence,
      rejected,
      decision: 'reject',
      text: refusalText(),
      assertions: outcomes,
    }
  }
  if (needsEvidence > 0) {
    return {
      total,
      verified,
      needsEvidence,
      rejected,
      decision: 'annotate',
      text: input.text.startsWith(UNVERIFIED_PREFIX) ? input.text : `${UNVERIFIED_PREFIX}${input.text}`,
      assertions: outcomes,
    }
  }
  return {
    total,
    verified,
    needsEvidence,
    rejected,
    decision: 'pass',
    text: input.text,
    assertions: outcomes,
  }
}

/** 否定语境：句子在讲"没办成"，不能按"资金动作已完成"拒答（否则误杀真诚的失败说明）。 */
const NOT_COMPLETED = /(未成功|失败|未完成|被拒|拒绝|取消|未执行|没转成|未到账)/

function statusOf(
  assertion: Assertion,
  evidence: ReturnType<typeof collectEvidence>,
): AssertionOutcome['status'] {
  const isMoney = assertion.kind === 'amount' || assertion.kind === 'balance'
  const isActionClaim =
    isMoney && MONEY_ACTION_CLAIM.test(assertion.sentence) && !NOT_COMPLETED.test(assertion.sentence)

  if (isActionClaim) {
    return evidence.actionValues.has(assertion.value) ? 'verified' : 'rejected'
  }
  return hasValue(assertion.kind, assertion.value, evidence.values) ? 'verified' : 'needs-evidence'
}

function hasValue(
  kind: AssertionKind,
  value: string,
  values: ReadonlyMap<AssertionKind, ReadonlySet<string>>,
): boolean {
  const bucket = values.get(kind)
  if (bucket === undefined) return false
  // 日期允许回复省略年份：`10-26` 命中证据里的 `2026-10-26`。
  if (kind === 'date') {
    for (const candidate of bucket) {
      if (candidate === value || candidate.endsWith(value) || value.endsWith(candidate)) return true
    }
    return false
  }
  return bucket.has(value)
}
