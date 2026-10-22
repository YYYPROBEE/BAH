/**
 * 状态视图（SA-13 §3.1）：五态分类、单 saga 全时间线、审批卡片数据。
 *
 * 纪律：**无 HTTP**。这里只产出渠道无关的纯数据，渲染由 `apps/*` 负责。
 * 业务逻辑不入渠道；时间戳只作展示，不参与因果判定。
 */

import { assertNever } from '@bah/util'

import { SAGA_STORE } from '../seams.ts'

import type { Context } from '@bah/core'

import type { ChainRow } from '../recon/types.ts'
import type { SagaState, SagaTransaction } from '../types.ts'

/** 五态分类档（渠道看板的一级过滤）。 */
export type FiveStateBucket = 'success' | 'failed' | 'compensating' | 'compensated' | 'manual_dlq'

/** 五档顺序（导出/渲染时保持稳定，避免渠道各排各的）。 */
export const FIVE_STATE_BUCKETS = [
  'success',
  'failed',
  'compensating',
  'compensated',
  'manual_dlq',
] as const satisfies readonly FiveStateBucket[]

/**
 * 状态 → 五态档（11 态全覆盖；封闭联合，`assertNever` 收尾）。
 *
 * 「进行中（补偿中）」涵盖一切非终态、尚在推进/补偿/待处理的活跃 saga。
 */
export function bucketOf(state: SagaState): FiveStateBucket {
  switch (state) {
    case 'SUCCEEDED':
      return 'success'
    case 'ABORTED_CLEAN':
      return 'failed'
    case 'CREATED':
    case 'RUNNING':
    case 'COMPENSATING':
    case 'PARTIALLY_COMPENSATED':
    case 'GATE_HOLDING':
    case 'PENDING_RISK_REVIEW':
      return 'compensating'
    case 'COMPENSATED':
      return 'compensated'
    case 'COMPENSATION_DLQ':
    case 'MANUALLY_CLOSED':
      return 'manual_dlq'
    default:
      return assertNever(state, 'bucketOf')
  }
}

/** 五态分类 + 业务类型过滤；含终态，故走全表（`listAllSagas`）。 */
export function listSagas(
  ctx: Context,
  filter: { readonly bucket?: FiveStateBucket; readonly businessType?: string },
): readonly SagaTransaction[] {
  const store = ctx.get(SAGA_STORE)
  return store
    .listAllSagas()
    .filter((saga) => filter.bucket === undefined || bucketOf(saga.state) === filter.bucket)
    .filter((saga) => filter.businessType === undefined || saga.businessType === filter.businessType)
}

/** 单条时间线（事件为骨架，join 运行时步骤/补偿/工单引用）。 */
export interface SagaTimelineRow {
  readonly seqInSaga: number
  readonly eventType: string
  readonly subjectRef: string
  /** `saga_step.stepId` 命中。 */
  readonly stepRef?: string
  /** `compensating_action.compId` 命中。 */
  readonly compRef?: string
  /** `suspension_ticket.ticketId` / `dlq_entry.dlqId` 命中。 */
  readonly ticketRef?: string
}

/**
 * 导出单 saga 全时间线。
 *
 * `rows` 由装配位注入链只读面（与 SA-12 `ReconDeps.readStream` 同一来源）；
 * 本包不 import `@bah/persistence`。工单引用按 subjectRef 直查（票据/DLQ 主键即 subject）。
 */
export function sagaTimeline(
  ctx: Context,
  sagaId: string,
  rows: readonly ChainRow[],
): readonly SagaTimelineRow[] {
  const store = ctx.get(SAGA_STORE)
  const steps = new Set(store.listSteps(sagaId).map((step) => step.stepId))
  const comps = new Set(store.tx((tx) => tx.listCompensations(sagaId)).map((comp) => comp.compId))
  const dlqIds = new Set(
    store.tx((tx) =>
      tx
        .listDlqPending()
        .filter((entry) => entry.sagaId === sagaId)
        .map((entry) => entry.dlqId),
    ),
  )
  const subjects = new Set(rows.map((row) => row.sub))
  const ticketIds = new Set<string>()
  for (const subject of subjects) {
    if (subject.length === 0) continue
    const ticket = store.tx((tx) => tx.readTicket(subject))
    if (ticket !== undefined && ticket.sagaId === sagaId) ticketIds.add(subject)
  }

  return rows.map((row) => ({
    seqInSaga: row.q,
    eventType: row.t,
    subjectRef: row.sub,
    ...(steps.has(row.sub) ? { stepRef: row.sub } : {}),
    ...(comps.has(row.sub) ? { compRef: row.sub } : {}),
    ...(ticketIds.has(row.sub) || dlqIds.has(row.sub) ? { ticketRef: row.sub } : {}),
  }))
}

/** 审批卡片数据：六项必现（BAH 03 §2.5 呈现契约）。 */
export interface ApprovalCardData {
  readonly kind: 'approval-request'
  readonly operationType: string
  readonly amount: number
  readonly payee: string
  readonly riskTier: string
  readonly ticketTtlMs: number
  readonly rejectReasonInput: { readonly visible: true; readonly requiredOnReject: true }
}

/** 审批卡片的输入面（来自原始事件 + 持久化结果元数据）。 */
export interface ApprovalCardInput {
  readonly operationType: string
  readonly amount: number
  readonly payee: string
  readonly riskTier: string
  readonly ticketTtlMs: number
}

/**
 * 审批卡片 presenter：**纯函数**（同输入同输出，不访问 `ctx`、不读时钟）。
 *
 * 拒绝理由输入框是契约常量：审批拒绝必须携带理由，不能由渠道自行省略。
 */
export function buildApprovalCard(input: ApprovalCardInput): ApprovalCardData {
  return {
    kind: 'approval-request',
    operationType: input.operationType,
    amount: input.amount,
    payee: input.payee,
    riskTier: input.riskTier,
    ticketTtlMs: input.ticketTtlMs,
    rejectReasonInput: { visible: true, requiredOnReject: true },
  }
}
