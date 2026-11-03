/**
 * 会话落盘前的 PII 脱敏。
 *
 * 只做**不可逆掩码**：落盘后不再保留原文，因此不需要代币 Vault。
 * 两类规则：
 * - 键名命中敏感槽（姓名 / 手机 / 证件 / 银行卡 / 邮箱 / 密钥）→ 按槽位掩码；
 * - 任意字符串 → 按模式表掩码（手机 / 证件号 / 银行卡 / 邮箱）。
 *
 * 目标是"日志与审计导出不出现客户明文"，不是替代输入侧脱敏；自由文本里的姓名
 * 无法靠正则可靠识别，结构化字段（`payee.name` 等）是主通道。
 */

import type { SessionEvent } from '@bah/core'

const NAME_KEY = /^(realname|username|payeename|accountname|customername|holdername|recipientname)$/i
/** 裸 `name` 只有挂在这些人/账户容器下才是姓名（顶层 `name` 是工具名，不能掩码）。 */
const NAME_PARENT_KEY =
  /^(payees?|users?|customers?|holders?|accounts?|recipients?|beneficiaries)$/i
const PHONE_KEY = /(phone|mobile|tel)$/i
const ID_KEY = /(idcard|idno|certno|identityno)$/i
const CARD_KEY = /(bankcard|cardno|accountno|accountnumber|iban)$/i
const EMAIL_KEY = /email/i
const SECRET_KEY = /(apikey|token|password|secret|privatekey|cvv|passcode)$/i

const PHONE_PATTERN = /(?<!\d)(1[3-9]\d{9})(?!\d)/g
const IDCARD_PATTERN = /(?<!\d)(\d{17}[\dXx])(?!\w)/g
const BANKCARD_PATTERN = /(?<!\d)(\d{16,19})(?!\d)/g
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/g

/** 姓名掩码：保留首字（中文习惯），其余替换。 */
export function maskName(value: string): string {
  const chars = [...value.trim()]
  if (chars.length === 0) return '***'
  if (chars.length === 1) return `${chars[0]}**`
  return `${chars[0]}**`
}

/** 手机掩码：138****1234。 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 7) return '****'
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/** 证件掩码：保留前 4 与后 4。 */
export function maskIdCard(value: string): string {
  const text = value.trim()
  if (text.length <= 8) return '********'
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(10, text.length - 8))}${text.slice(-4)}`
}

/** 银行卡掩码：只留后 4 位。 */
export function maskCard(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length <= 4) return '****'
  return `****${digits.slice(-4)}`
}

/** 邮箱掩码：保留域名，隐藏本地部分。 */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@')
  return at < 0 ? '***' : `***@${value.slice(at + 1)}`
}

/** 自由文本模式掩码。 */
export function maskText(value: string): string {
  return value
    .replace(PHONE_PATTERN, (match) => maskPhone(match))
    .replace(IDCARD_PATTERN, (match) => maskIdCard(match))
    .replace(BANKCARD_PATTERN, (match) => maskCard(match))
    .replace(EMAIL_PATTERN, (match) => maskEmail(match))
}

function maskByKey(key: string, value: string): string {
  if (SECRET_KEY.test(key)) return '[REDACTED]'
  if (NAME_KEY.test(key)) return maskName(value)
  if (PHONE_KEY.test(key)) return maskPhone(value)
  if (ID_KEY.test(key)) return maskIdCard(value)
  if (CARD_KEY.test(key)) return maskCard(value)
  if (EMAIL_KEY.test(key)) return maskEmail(value)
  return maskText(value)
}

const MAX_DEPTH = 12

/** 深拷贝 + 掩码；只处理 JSON 可表示的值（会话事件必须可落盘）。 */
export function redactValue(value: unknown, depth = 0, parentKey = ''): unknown {
  if (depth > MAX_DEPTH) return '[DEPTH-LIMIT]'
  if (typeof value === 'string') return maskText(value)
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, parentKey))

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    // 原型污染面：日志里的键完全来自模型输入，危险键直接丢弃
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const isBareName = key.toLowerCase() === 'name' && NAME_PARENT_KEY.test(parentKey)
    out[key] =
      typeof child === 'string'
        ? isBareName
          ? maskName(child)
          : maskByKey(key, child)
        : redactValue(child, depth + 1, key)
  }
  return out
}

/** 一条会话事件的脱敏副本（`seq` / `type` / `ignorable` 等结构字段保持不变）。 */
export function redactSessionEvent(event: SessionEvent): SessionEvent {
  return {
    ...event,
    data: redactValue(event.data) as SessionEvent['data'],
  }
}
