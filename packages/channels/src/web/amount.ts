/**
 * 金额与合规文本的**渠道侧判定**（施工单 13 §2.2）。
 *
 * 两条铁律：
 * 1. **不发明金额**：金额只从事件里取（`approval/asked.amount` 是分；工具参数里的
 *    `amount` 是元——这是施工单 08 的口径），渠道不做换算猜测以外的任何加工；
 * 2. **没结果就不算确认**：只有本 turn 内该 `callId` 的 `tool/result` 成功返回，
 *    金额才算被证实；否则 UI 必须标灰 + "待确认"（幻觉防护的 UI 侧）。
 */

import { formatCents, yuanToCents } from './format.ts'

/** 工具参数里可能承载金额的键（`amountCents` 优先：它已经是分）。 */
const AMOUNT_CENTS_KEYS = ['amountCents', 'minAmountCents'] as const
const AMOUNT_YUAN_KEYS = ['amount'] as const

/**
 * 从工具参数里取金额（分）。
 *
 * @returns 分；参数里没有合法金额时 `undefined`（不猜 0）
 */
export function amountFromArgs(args: unknown): number | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>

  for (const key of AMOUNT_CENTS_KEYS) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  }
  for (const key of AMOUNT_YUAN_KEYS) {
    const cents = yuanToCents(record[key])
    if (cents !== undefined) return cents
  }
  return undefined
}

/** 从工具参数里取收款人姓名（`payee.name`）。 */
export function payeeFromArgs(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const payee = (args as Record<string, unknown>)['payee']
  if (typeof payee !== 'object' || payee === null || Array.isArray(payee)) return undefined
  const name = (payee as Record<string, unknown>)['name']
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined
}

/** 金额展示文本（分 → `¥…`）。 */
export function amountText(cents: number | undefined): string | undefined {
  return cents === undefined ? undefined : formatCents(cents)
}

/**
 * 从工具结果文本里抽风险提示（理财合规：`disclaimerId` 必须展示）。
 *
 * 口径来自施工单 08：`projectContent` 把 `disclaimerId` 写进正文
 * （`风险提示：wealth.disclaimer.v1（必须向用户展示…）`）。工具卡片（`UiCard`）当前
 * **不落账**，所以渠道只能从**已持久化**的结果正文里取——这比"渠道自己编一句风险提示"安全得多。
 *
 * @returns `{ id, text }`；正文里没有风险提示时 `undefined`
 */
export function extractDisclaimer(text: string): { id: string; text: string } | undefined {
  const match = /风险提示：\s*([^\s（(，,。；;]+)/.exec(text)
  if (match === null) return undefined
  const id = match[1]
  if (id === undefined || id.length === 0) return undefined
  // 取整句作为提示文本（到行尾），没有句子就退回 ID 本身
  const lineStart = text.lastIndexOf('\n', match.index) + 1
  const lineEnd = text.indexOf('\n', match.index)
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim()
  return { id, text: line.length > 0 ? line : `风险提示：${id}` }
}

/**
 * 金额是否已被本 turn 的工具结果证实。
 *
 * @param hasResult 本 turn 内该 `callId` 是否有**成功**的 `tool/result`
 */
export function isAmountConfirmed(hasResult: boolean): boolean {
  return hasResult
}
