/**
 * 工具参数 → 领域请求的映射（金额单位只在这里转一次：元 → 分）。
 *
 * 所有映射都是纯函数（除 `parseExecuteWhen` 需要时钟）；失败抛
 * `BahError('tool-args-invalid')`，由管线归一化后回灌模型。
 */

import { BahError } from '@bah/util'

import type { CardId, ProductId, RiskGrade, TransferReq, WealthFilter } from '../core/index.ts'
import { bankIds, yuanToCents } from '../core/index.ts'
import {
  readNumber,
  readObject,
  readOptionalInteger,
  readOptionalString,
  readRequiredEnum,
  readString,
} from './args.ts'
import { parseInstant } from './time.ts'

/** 转账参数（试算与执行共用）。 */
export interface TransferInput {
  readonly amountCents: number
  readonly payee: TransferReq['payee']
  readonly when?: string
  readonly idempotencyKey?: string
  /** 以哪张卡支付（可选；仅当用户点名用哪张卡时填）。 */
  readonly viaCardId?: CardId
}

/**
 * 元 → 整数分；核心账本的 `money-invalid` 在工具边界归一为 `tool-args-invalid`。
 *
 * TC-W03-02 ⑤ 要求"超过 `MAX_SAFE_INTEGER/100`"表现为**参数非法**。换算精度归
 * `yuanToCents`（唯一铸造点），但 `money-invalid` 是账本错误码，不该让模型在同一件事上
 * 看到两个码。
 */
function amountToCents(amount: number): number {
  try {
    return yuanToCents(amount)
  } catch (error) {
    if (error instanceof BahError && error.code === 'money-invalid') {
      throw new BahError('tool-args-invalid', 'bank-tools: amount 超出可精确表示的范围（单位：元）', {
        amount,
      })
    }
    throw error
  }
}

/** 读取收款人。 */
function parsePayee(args: Readonly<Record<string, unknown>>): TransferReq['payee'] {
  const payee = readObject(args, 'payee', 'transfer')
  const name = readString(payee, 'name', 'transfer.payee')
  const phone = readOptionalString(payee, 'phone', 'transfer.payee')
  const payeeId = readOptionalString(payee, 'payeeId', 'transfer.payee')
  const memo =
    readOptionalString(payee, 'memo', 'transfer.payee') ?? readOptionalString(args, 'remark', 'transfer')
  return {
    name,
    ...(phone === undefined ? {} : { phone }),
    ...(payeeId === undefined ? {} : { payeeId: bankIds.payee(payeeId) }),
    ...(memo === undefined ? {} : { memo }),
  }
}

/**
 * 解析转账参数。
 *
 * @throws `BahError('tool-args-invalid')` 金额 / 收款人非法
 */
export function parseTransferInput(args: Readonly<Record<string, unknown>>): TransferInput {
  const amount = readNumber(args, 'amount', 'transfer')
  if (amount <= 0) {
    throw new BahError('tool-args-invalid', 'bank-tools: amount 必须大于 0（单位：元）', { amount })
  }
  const when = readOptionalString(args, 'when', 'transfer')
  const idempotencyKey = readOptionalString(args, 'idempotencyKey', 'transfer')
  const viaCardId = readOptionalString(args, 'viaCardId', 'transfer')
  return {
    amountCents: amountToCents(amount),
    payee: parsePayee(args),
    ...(when === undefined ? {} : { when }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(viaCardId === undefined ? {} : { viaCardId: bankIds.card(viaCardId) }),
  }
}

/**
 * 解析执行时间：当前只支持 `now`（定时转账属 P1 `transfer.schedule`）。
 *
 * @throws `BahError('when-in-past')` 给了已经过去的时间
 * @throws `BahError('unsupported-schedule')` 给了未来时间（能力未实现，不是参数错误）
 * @throws `BahError('tool-args-invalid')` 时间非法
 */
export function assertExecutableNow(when: string | undefined, now: number): void {
  if (when === undefined || when.toLowerCase() === 'now') return
  const at = parseInstant(when, 'transfer.when')
  if (at < now) {
    throw new BahError('when-in-past', 'bank-tools: 执行时间已经过去，不能补做历史转账', { when })
  }
  if (at > now) {
    throw new BahError(
      'unsupported-schedule',
      'bank-tools: 定时转账属 P1（transfer.schedule），当前只支持 when = now',
      { when },
    )
  }
}

/** 理财筛选条件。 */
export function parseWealthFilter(
  args: Readonly<Record<string, unknown>>,
): WealthFilter | undefined {
  const filter = args['filter']
  if (filter === undefined) return undefined
  const record = readObject(args, 'filter', 'wealth_list')
  const riskGrade = readOptionalString(record, 'riskGrade', 'wealth_list.filter')
  if (riskGrade !== undefined && !/^R[1-5]$/i.test(riskGrade)) {
    throw new BahError('tool-args-invalid', 'bank-tools: riskGrade 只能是 R1–R5', { riskGrade })
  }
  const kind = readOptionalString(record, 'kind', 'wealth_list.filter')
  if (kind !== undefined && !['deposit', 'fixed', 'fund'].includes(kind)) {
    throw new BahError('tool-args-invalid', 'bank-tools: kind 只能是 deposit / fixed / fund', { kind })
  }
  const maxTermDays = record['maxTermDays']
  if (
    maxTermDays !== undefined &&
    (typeof maxTermDays !== 'number' || !Number.isInteger(maxTermDays) || maxTermDays < 1)
  ) {
    throw new BahError('tool-args-invalid', 'bank-tools: maxTermDays 必须是正整数', { maxTermDays })
  }
  return {
    ...(riskGrade === undefined ? {} : { riskGrade: riskGrade.toUpperCase() as RiskGrade }),
    ...(kind === undefined ? {} : { kind: kind as 'deposit' | 'fixed' | 'fund' }),
    ...(maxTermDays === undefined ? {} : { maxTermDays: maxTermDays as number }),
  }
}

/** 理财产品 ID（品牌铸造点只在工具边界）。 */
export function parseProductId(value: string): ProductId {
  return bankIds.product(value)
}

/** 解析购买金额（元 → 分）。 */
export function parsePurchaseAmount(args: Readonly<Record<string, unknown>>): number {
  const amount = readNumber(args, 'amount', 'wealth_purchase')
  if (amount <= 0) {
    throw new BahError('tool-args-invalid', 'bank-tools: amount 必须大于 0（单位：元）', { amount })
  }
  return amountToCents(amount)
}

/**
 * 解析账期口径。
 *
 * 白名单是**闭合**的：非白名单值直接抛 `tool-args-invalid`，不是静默降级——
 * 模型传 `year` 而工具不认时，让它立刻看到可修正的参数，比编一份错的年度报告安全。
 */
export function parsePeriod(
  args: Readonly<Record<string, unknown>>,
): 'month' | 'quarter' | 'year' {
  return readRequiredEnum(args, 'period', 'bill', ['month', 'quarter', 'year'] as const)
}

/** 账单口径 + 账期锚点。 */
export interface BillScope {
  readonly period: 'month' | 'quarter' | 'year'
  /** 锚点账期（`YYYY-MM`，显式）。 */
  readonly month?: string
  /** 锚点自然年（`YYYY`）：表示"该自然年的 12 个账期"。 */
  readonly year?: string
  /** 相对当前月的偏移（0 = 本月，-1 = 上个月，-11 = 去年同月）。 */
  readonly monthOffset?: number
  /** 只给月份（1–12）：由调用方按"不晚于当前月"落到具体年份。 */
  readonly monthOfYear?: number
}

const MONTH_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/
const YEAR_KEY = /^\d{4}$/

/**
 * 解析账单口径（`bill_analyze` / `bill_report` 共用）。
 *
 * 五种写法，**最多给一个**：
 * - `period`：month / quarter / year（相对当前月，向后兼容）；
 * - `month: 'YYYY-MM'`：显式历史月份（模型知道今天是几号时用）；
 * - `year: 'YYYY'`：显式自然年；
 * - `monthOffset: -1`：上个月（离线脚本用——脚本没有时钟，算不了 `YYYY-MM`）；
 * - `monthOfYear: 9`：只要月份，年份由调用方按"不晚于当前月"补齐。
 *
 * WHY 要有相对口径：用户最自然的话术是"上个月账单""9 月花了多少"。
 * 只支持相对 period 时，"2025 年" 会被算成"近 12 个月"——数字与用户预期不符，
 * 在评委眼里就是报告编数。**换算留在调用方**：本函数是纯函数，不碰时钟。
 */
export function parseBillScope(args: Readonly<Record<string, unknown>>): BillScope {
  const period = parsePeriod(args)
  const month = readOptionalString(args, 'month', 'bill')
  const year = readOptionalString(args, 'year', 'bill')
  const monthOffset = readOptionalInteger(args, 'monthOffset', 'bill')
  const monthOfYear = readOptionalInteger(args, 'monthOfYear', 'bill')

  const anchors = [month, year, monthOffset, monthOfYear].filter(
    (value) => value !== undefined,
  ).length
  if (anchors > 1) {
    throw new BahError(
      'tool-args-invalid',
      'bank-tools: month / year / monthOffset / monthOfYear 只能给一个',
      {},
    )
  }

  if (month !== undefined) {
    if (!MONTH_KEY.test(month)) {
      throw new BahError('tool-args-invalid', `bank-tools: month 必须是 YYYY-MM（收到 ${month}）`, {
        month,
      })
    }
    return { period: 'month', month }
  }
  if (year !== undefined) {
    if (!YEAR_KEY.test(year)) {
      throw new BahError('tool-args-invalid', `bank-tools: year 必须是 YYYY（收到 ${year}）`, {
        year,
      })
    }
    return { period: 'year', year }
  }
  if (monthOffset !== undefined) {
    if (monthOffset > 0 || monthOffset < -36) {
      throw new BahError(
        'tool-args-invalid',
        `bank-tools: monthOffset 必须在 -36..0（0 = 本月，收到 ${monthOffset}）`,
        { monthOffset },
      )
    }
    return { period, monthOffset }
  }
  if (monthOfYear !== undefined) {
    if (monthOfYear < 1 || monthOfYear > 12) {
      throw new BahError(
        'tool-args-invalid',
        `bank-tools: monthOfYear 必须在 1..12（收到 ${monthOfYear}）`,
        { monthOfYear },
      )
    }
    return { period, monthOfYear }
  }
  return { period }
}
