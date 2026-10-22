/**
 * 工具参数 → 领域请求的映射（金额单位只在这里转一次：元 → 分）。
 *
 * 所有映射都是纯函数（除 `parseExecuteWhen` 需要时钟）；失败抛
 * `BahError('tool-args-invalid')`，由管线归一化后回灌模型。
 */

import { BahError } from '@bah/util'

import type { ProductId, RiskGrade, TransferReq, WealthFilter } from '../core/index.ts'
import { bankIds, yuanToCents } from '../core/index.ts'
import { readNumber, readObject, readOptionalString, readRequiredEnum, readString } from './args.ts'
import { parseInstant } from './time.ts'

/** 转账参数（试算与执行共用）。 */
export interface TransferInput {
  readonly amountCents: number
  readonly payee: TransferReq['payee']
  readonly when?: string
  readonly idempotencyKey?: string
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
  return {
    amountCents: yuanToCents(amount),
    payee: parsePayee(args),
    ...(when === undefined ? {} : { when }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
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
  return yuanToCents(amount)
}

/** 解析账期口径。 */
export function parsePeriod(
  args: Readonly<Record<string, unknown>>,
): 'month' | 'quarter' {
  return readRequiredEnum(args, 'period', 'bill', ['month', 'quarter'] as const)
}
