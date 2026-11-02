/**
 * 证据结构与 PII 脱敏。
 *
 * 为什么在证据构造点脱敏而不是在日志层兜底：evidence 会进 `tool/result` 载荷并被回放，
 * 日志层的 FORBIDDEN_KEYS 只护住日志出口，护不住事件流与快照。
 */

import { maskName } from './slots.ts'

import type { SlotName, SlotSource } from './types.ts'

export interface EvidenceItem {
  /** 命中的规则（R-VAGUE-1…），审计可回放到判定条款。 */
  readonly ruleId: string
  /** 触发该规则的原话片段，**已脱敏**。 */
  readonly span: string
  /** 该证据支撑的槽位。 */
  readonly slot?: SlotName
  /** 槽位值来源（「这个值哪来的」）。 */
  readonly slotSource?: SlotSource
}

/**
 * 证据里不得包含（PII 纪律）：
 *  - 全账号 / 卡号：只允许 ****1234 尾号形态；
 *  - 姓名原文：只允许张** / 欧阳** 形态；
 *  - 全手机号：只允许 138****5678；
 *  - 证件号、CVV、短信验证码、密码：一律不允许，任何形态。
 */
export function buildEvidence(
  ruleId: string,
  span: string,
  slot?: SlotName,
  slotSource?: SlotSource,
): EvidenceItem {
  const base = { ruleId, span: sanitizeSpan(span) }
  // WHY 可选字段分开构造：多一个 `undefined` 键会改变 JSON 的 canonical 形态，
  // 而证据会进 `tool/result` 并被签名链与回放逐字比对。
  const withSlot = slot === undefined ? base : { ...base, slot }
  return slotSource === undefined ? withSlot : { ...withSlot, slotSource }
}

/** 11 位 1 开头视为手机号。 */
const PHONE = /\b1\d{10}\b/g
/** 连续 ≥8 位数字视为账号/卡号候选。 */
const ACCOUNT = /\b\d{8,}\b/g
/** 姓名原文只出现在「给X转」「转给X」这类槽位句式里，按位置替换而不是猜所有汉字。 */
const NAMED_PAYEE = /(给|转给|收款人[:：]?)\s*([\u4e00-\u9fa5]{2,4})(?=\s*(?:转|汇款|打款|打钱|$))/g

/**
 * 一段原话进证据前的清洗。
 *
 * WHY 整段丢弃而不是打码保留：证据的目的是「解释规则为什么命中」，不是「复述敏感值」。
 * 先手机号后账号：11 位号码同时命中账号正则，顺序反了会得到 `[redacted:account]` 的错标签。
 */
export function sanitizeSpan(text: string): string {
  return text
    .replace(PHONE, '[redacted:phone]')
    .replace(ACCOUNT, '[redacted:account]')
    .replace(NAMED_PAYEE, (_match, prefix: string, name: string) => `${prefix}${maskName(name)}`)
}
