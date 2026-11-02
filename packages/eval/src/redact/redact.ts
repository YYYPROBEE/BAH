/**
 * 敏感字段令牌化（00 §6）——**轨迹落盘时**在记录器出口执行。
 *
 * 规则（00 §6 逐条）：
 * - 卡号 13–19 位数字 → `CARD-{hash8}`
 * - 证件号 18 位（末位可为 X）→ `ID-{hash8}`
 * - 手机号 11 位 → `TEL-{hash8}`
 *
 * 零第三方依赖：正则自写，散列用 node 内置 crypto（不是第三方库）。
 *
 * ── 三个必须说清的口径 ────────────────────────────────────────────────
 * 1. **优先序**：先 18 位证件号、再 13–19 位卡号、最后 11 位手机号。
 *    18 位纯数字既像身份证又像卡号，无法从形状上区分；先匹配更长/更严的规则，
 *    保证**任何情况下都不会漏**（最坏只是令牌种类标错，不是原文泄漏）。
 * 2. **只脱敏字符串**：数值型字段原样保留。因为把数值也令牌化会污染
 *    PSA 的数值域断言（金额变成 `CARD-xxxx` 就永远判不出「超上限 1 分」）。
 *    例外：**键名像身份字段**（card / pan / phone / idcard…）的数值仍会令牌化，
 *    避免模型用 JSON number 夹带卡号绕过规则。
 * 3. **令牌是关联用的伪名，不是隐私级匿名化**：同一原值恒得同一令牌（跨 episode
 *    可关联），无盐时对 11 位手机号可穷举反推。部署面要真匿名化，需传入机密盐
 *    （`salt` 选项），这是 M2+ 的事，M0 不假装已经做到。
 */

import { createHash } from 'node:crypto'

import { isPlainObject } from '../plain-object.ts'

/** 令牌前缀（00 §6 指定的三种形态）。 */
export const TOKEN_PREFIX = {
  card: 'CARD',
  id: 'ID',
  tel: 'TEL',
} as const

export type RedactKind = keyof typeof TOKEN_PREFIX

/**
 * 无盐时的固定域分隔前缀。
 *
 * 是常量而非随机值：令牌必须跨进程、跨 episode 稳定，否则同一张卡在不同 episode
 * 里得到不同令牌，证据链就失去「同一实体」的关联能力。
 */
const DEFAULT_SALT = 'bah-eval:v1'

/** 证件号：18 位，末位可为 X/x。前后不能再接字母数字（防从更长串里截取）。 */
const ID_PATTERN = /(?<![0-9A-Za-z])\d{17}[0-9Xx](?![0-9A-Za-z])/g

/**
 * 卡号：13–19 位纯数字。
 *
 * 两侧都排除字母：`ref=11010119900307123X9` 这类「数字夹字母」的标识符里，
 * 17 位数字片段不该被当成卡号吃掉（否则原文会留下 `CARD-xxx` + 残尾 `X9` 的怪形态）。
 */
const CARD_PATTERN = /(?<![0-9A-Za-z])\d{13,19}(?![0-9A-Za-z])/g

/** 手机号：11 位纯数字（同样排除字母两侧）。 */
const TEL_PATTERN = /(?<![0-9A-Za-z])\d{11}(?![0-9A-Za-z])/g

/** 键名像身份字段时，连数值也令牌化（防 JSON number 夹带）。 */
const IDENTITY_KEY_PATTERN = /(card|pan|account|acct|idcard|id_no|idno|identity|phone|mobile|tel)/i

export interface RedactOptions {
  /** 部署机密盐；缺省用固定常量（令牌可跨进程稳定）。 */
  readonly salt?: string
}

/** 原值 → 令牌。同一 (kind, value, salt) 恒得同一结果。 */
export function tokenize(kind: RedactKind, value: string, options: RedactOptions = {}): string {
  const digest = createHash('sha256')
    .update(`${options.salt ?? DEFAULT_SALT}:${kind}:${value}`)
    .digest('hex')
    .slice(0, 8)
  return `${TOKEN_PREFIX[kind]}-${digest}`
}

/**
 * 字符串内的敏感片段替换为令牌。
 *
 * 三段替换**按序**执行且不可交换：证件号先吃掉 18 位，卡号规则才不会被
 * 18 位身份证误命中；手机号最后跑，避免把 13–19 位的卡号切出 11 位残片。
 */
export function redactText(text: string, options: RedactOptions = {}): string {
  return text
    .replace(ID_PATTERN, (match) => tokenize('id', match, options))
    .replace(CARD_PATTERN, (match) => tokenize('card', match, options))
    .replace(TEL_PATTERN, (match) => tokenize('tel', match, options))
}

/** 键名判定：是身份类字段就返回 true（决定数值要不要令牌化）。 */
function isIdentityKey(key: string): boolean {
  return IDENTITY_KEY_PATTERN.test(key)
}

/** 按位数猜种类（用于身份类键下的数值）。 */
function classifyDigits(value: string): RedactKind {
  if (value.length === 18) return 'id'
  if (value.length === 11) return 'tel'
  return 'card'
}

/**
 * 递归脱敏任意 JSON 值。
 *
 * - 字符串：按形状替换（无论键名）；
 * - 数值：仅当键名像身份字段且位数落在 11–19 才令牌化（保护 PSA 数值断言）；
 * - 数组 / 普通对象：逐元素递归，键名原样保留（键是 schema，不是用户数据）。
 */
export function redactValue(value: unknown, options: RedactOptions = {}, keyHint = ''): unknown {
  if (typeof value === 'string') return redactText(value, options)

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || !isIdentityKey(keyHint)) return value
    const digits = String(Math.abs(value))
    if (digits.length < 11 || digits.length > 19) return value
    return tokenize(classifyDigits(digits), digits, options)
  }

  if (Array.isArray(value)) return value.map((item) => redactValue(item, options, keyHint))

  // 只递归**普通对象**：Date / Map / 类实例按叶子原样透传。
  // 用 `typeof === 'object'` 判会把 `new Date()` 吃成 `{}`（Object.entries 为空），
  // 那是比漏脱敏更糟的假象——数据没了，还看不出是哪一步丢的。
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      output[key] = redactValue(item, options, key)
    }
    return output
  }

  // boolean / null / undefined / bigint / function 等：无可脱敏内容，原样透传。
  return value
}

/** 记录器出口用的便捷入口：把一次工具调用的参数/结果摘要整体脱敏。 */
export function redactRecord(
  record: Readonly<Record<string, unknown>>,
  options: RedactOptions = {},
): Record<string, unknown> {
  const redacted = redactValue(record, options)
  // redactValue 对普通对象恒返回新对象；这层断言只为收窄类型，不改变语义。
  return redacted as Record<string, unknown>
}
