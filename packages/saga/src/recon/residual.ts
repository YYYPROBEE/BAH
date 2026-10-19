/**
 * 残差账本（SA-12 §3.3 / O5，批 5）。
 *
 * - 补偿 OK 时按模板 `residual_rules` 计算残差入账；
 * - **非白名单类型拒绝入账**（A21），绝不静默入账；
 * - 日终勾稽「残差账本 vs 外部对账单差异率」，阈值沿用对账档：
 *   告警 0.1% / P0 0.5%（严格大于）。
 */

import { BahError } from '@bah/util'

import { noopAlertSink } from '../alert/sink.ts'
import { commitSegment } from '../coordinator/commit.ts'
import { SAGA_AUDIT, SAGA_STORE } from '../seams.ts'

import type { Context } from '@bah/core'
import type { AlertSink } from '../alert/sink.ts'
import type { ResidualLedgerEntry } from '../types.ts'

/** 残差类型白名单（A21：白名单外一律拒绝入账；月度财务/审计交叉复核）。 */
export const RESIDUAL_WHITELIST: ReadonlySet<string> = new Set([
  'FX_SPREAD',
  'INTEREST_ACCRUAL',
  'TIMING_LAG',
  'MIN_FEE',
])

/** 日终差异率告警阈值：> 0.1% 告警。 */
export const RESIDUAL_ALERT_RATE = 0.001
/** 日终差异率 P0 阈值：> 0.5% 升级。 */
export const RESIDUAL_P0_RATE = 0.005

/** 残差入账输入。 */
export interface ResidualInput {
  readonly sagaId: string
  readonly compId: string
  readonly residualType: string
  readonly amount: number
  readonly note?: string
}

/** 外部残差对账单的一行。 */
export interface ResidualStatementRow {
  readonly residualId: string
  readonly amount: number
}

/** 外部残差对账单（mock 网关，README C3）。 */
export type ResidualStatement = (
  entries: readonly ResidualLedgerEntry[],
) => Promise<readonly ResidualStatementRow[]>

/**
 * 补偿 OK 时的残差入账。
 *
 * 幂等：`residualId = res:<compId>`，重复调用返回同一 id，不重复插入。
 *
 * @throws `BahError('residual-not-whitelisted')` 类型不在白名单
 */
export function recordResidual(ctx: Context, input: ResidualInput): string {
  if (!RESIDUAL_WHITELIST.has(input.residualType)) {
    throw new BahError(
      'residual-not-whitelisted',
      `bah-saga: residual-not-whitelisted: ${input.residualType} 非白名单残差类型`,
      { sagaId: input.sagaId, residualType: input.residualType },
    )
  }

  const store = ctx.get(SAGA_STORE)
  const residualId = `res:${input.compId}`
  const existing = store.tx((tx) =>
    tx.listResiduals(input.sagaId).find((entry) => entry.residualId === residualId),
  )
  if (existing !== undefined) return residualId

  commitSegment(ctx, (tx) => {
    tx.insertResidual({
      residualId,
      sagaId: input.sagaId,
      compId: input.compId,
      residualType: input.residualType,
      amount: input.amount,
      ...(input.note === undefined ? {} : { note: input.note }),
      reconciled: false,
    })
    ctx.get(SAGA_AUDIT).append(input.sagaId, 'saga/residual-recorded', {
      sagaId: input.sagaId,
      compId: input.compId,
      residualType: input.residualType,
      amount: input.amount,
    })
  })

  ctx.events.emit('saga/residual-recorded', {
    sagaId: input.sagaId,
    compId: input.compId,
    residualType: input.residualType,
    amount: input.amount,
  })

  return residualId
}

/**
 * 日终勾稽：返回差异率 = Σ|ledger - statement| / Σ|statement|。
 *
 * 分母为 0 时：账本有残差而外部无对账 → 记 1（100% 差异）；两边都空 → 0。
 * 阈值严格大于才告警（与 SA-13 SLO 档一致）。
 */
export async function dayEndResidualDiff(
  ctx: Context,
  statement: ResidualStatement,
  alerts: AlertSink = noopAlertSink,
): Promise<number> {
  const store = ctx.get(SAGA_STORE)
  const entries = store
    .listAllSagas()
    .flatMap((saga) => store.tx((tx) => tx.listResiduals(saga.sagaId)))
  const external = await statement(entries)
  const externalByResidual = new Map(external.map((row) => [row.residualId, row.amount]))

  let diff = 0
  let externalTotal = 0
  for (const entry of entries) {
    const externalAmount = externalByResidual.get(entry.residualId) ?? 0
    diff += Math.abs(entry.amount - externalAmount)
    externalTotal += Math.abs(externalAmount)
  }

  const rate = externalTotal === 0 ? (diff > 0 ? 1 : 0) : diff / externalTotal
  if (rate > RESIDUAL_P0_RATE) {
    alerts('P0', `residual-diff-p0:${rate}`)
  } else if (rate > RESIDUAL_ALERT_RATE) {
    alerts('P1', `residual-diff-alert:${rate}`)
  }
  return rate
}
