/**
 * 悬垂清道夫（SA-12 §3.1，批 5）。
 *
 * 三级收敛：soft → 告警；hard → 冻结 + DLQ + 升级工单；force → `MANUALLY_CLOSED`。
 * 纪律：
 * - `age` 一律由 `bah:saga-clock` 计，不读 `Date.now()`；
 * - 动作与审计同提交段（`commitSegment`），消除「状态已关、链未落」的裂脑；
 * - 强制关闭**必须**带未完成副作用清单 + 对账指令（A20），缺则抛 `manifest-required`；
 * - 本模块不自建定时器；节拍只来自批 6 的 `saga/tick`（job 可被直调）。
 */

import { BahError, canonicalJson, sha256Hex } from '@bah/util'

import { noopAlertSink } from '../alert/sink.ts'
import { commitSegment } from '../coordinator/commit.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE } from '../seams.ts'
import { recordJobHeartbeat } from '../tick/registry.ts'

import type { Context } from '@bah/core'
import type { AlertSink } from '../alert/sink.ts'
import type { SagaSettings } from '../types.ts'

/** 未完成副作用清单 + 对账指令：强制关闭的**唯一**通行证（A20）。 */
export interface ForceCloseManifest {
  /** 仍未收敛的副作用（step / comp）标识；可为空（表「确无残留」）。 */
  readonly unfinishedEffects: readonly string[]
  /** 交给对账 job 的指令（如何核对这批残留）。 */
  readonly reconInstruction: string
  /** 编制人（operator）。 */
  readonly preparedBy: string
}

/** 单轮扫描的计数（供心跳与看板）。 */
export interface JanitorCounts {
  readonly alerted: number
  readonly frozen: number
  readonly closed: number
}

/** hard 档的确定性主键：重复扫描不会重复建单/建 DLQ。 */
export function hardEscalationIds(sagaId: string): { readonly ticketId: string; readonly dlqId: string } {
  return {
    ticketId: `tkt:janitor:hard:${sagaId}`,
    dlqId: `dlq:janitor:hard:${sagaId}`,
  }
}

/**
 * 强制关闭：`age > forceCloseMs` 时收敛到终态 `MANUALLY_CLOSED`。
 *
 * 无清单、清单为空、或清单缺 `reconInstruction` → 抛 `manifest-required`（A20）。
 * 已处于 `MANUALLY_CLOSED` → no-op（终态 CAS 是 tick 幂等的底座）。
 */
export function forceClose(ctx: Context, sagaId: string, manifest: ForceCloseManifest | undefined): void {
  if (
    manifest === undefined ||
    manifest.reconInstruction.trim().length === 0 ||
    manifest.preparedBy.trim().length === 0
  ) {
    throw new BahError(
      'manifest-required',
      `bah-saga: manifest-required: ${sagaId} 强制关闭缺副作用清单 + 对账指令`,
      { sagaId },
    )
  }

  const store = ctx.get(SAGA_STORE)
  const at = ctx.get(SAGA_CLOCK).now()
  const saga = store.loadTransaction(sagaId)
  if (saga === undefined || saga.state === 'MANUALLY_CLOSED') return

  // 链上只留摘要：对账指令随事件走，清单本体不落链。
  const manifestRef = `manifest:${sha256Hex(canonicalJson(manifest)).slice(0, 16)}`

  commitSegment(ctx, (tx) => {
    if (!tx.casState(sagaId, saga.state, 'MANUALLY_CLOSED', saga.version, at)) {
      throw new BahError(
        'version-conflict',
        `bah-saga: version-conflict: ${sagaId} 强制关闭 CAS 失败`,
        { sagaId, version: saga.version },
      )
    }
    ctx.get(SAGA_AUDIT).append(sagaId, 'saga/manually-closed', {
      sagaId,
      operator: manifest.preparedBy,
      manifestRef,
      reason: manifest.reconInstruction,
    })
  })

  ctx.events.emit('saga/manually-closed', {
    sagaId,
    operator: manifest.preparedBy,
    manifestRef,
    reason: manifest.reconInstruction,
  })
}

/** hard 档：冻结新发射 + 升级工单 + 落 DLQ；重复扫描只补缺、不重复建单。 */
function freezeAndEscalate(
  ctx: Context,
  settings: SagaSettings,
  sagaId: string,
  age: number,
  at: number,
): void {
  const store = ctx.get(SAGA_STORE)
  const saga = store.loadTransaction(sagaId)
  if (saga === undefined || saga.state === 'MANUALLY_CLOSED') return

  const { ticketId, dlqId } = hardEscalationIds(sagaId)
  let escalated = false

  commitSegment(ctx, (tx) => {
    if (tx.readTicket(ticketId) === undefined) {
      tx.insertTicket({
        ticketId,
        sagaId,
        reason: 'DLQ_ESCALATION',
        contextSnapshotRef: `saga:${sagaId}`,
        slaDeadline: at + settings.hardSlaMs,
      })
      if (tx.readDlq(dlqId) === undefined) {
        tx.insertDlq({
          dlqId,
          sagaId,
          source: 'STEP',
          reason: `sla-hard:${age}`,
          contextRef: `saga:${sagaId}`,
          enteredAt: at,
          slaDeadline: at + settings.hardSlaMs,
        })
      }
      ctx.get(SAGA_AUDIT).append(sagaId, 'saga/dlq-escalated', {
        sagaId,
        dlqId,
        source: 'step',
        reason: `sla-hard:${age}`,
        slaDeadline: at + settings.hardSlaMs,
      })
      escalated = true
    }
    // 冻结不改状态，只拦新步骤发射；重复扫描保持幂等。
    tx.freezeSaga(sagaId, true, at)
  })

  if (escalated) {
    ctx.events.emit('saga/dlq-escalated', {
      sagaId,
      dlqId,
      source: 'step',
      reason: `sla-hard:${age}`,
      slaDeadline: at + settings.hardSlaMs,
    })
  }
}

/** soft 档：只走告警汇，不落链（告警本身由心跳与看板承载）。 */
function alertSoft(sagaId: string, age: number, alerts: AlertSink): void {
  alerts('P1', `sla-soft:${sagaId}:${age}`)
}

/**
 * 单轮扫描：三级分流。返回本级动作计数。
 *
 * 顺序固定 force → hard → soft：同一 saga 只命中最高档，避免「已关闭又升级工单」。
 */
export function runJanitor(
  ctx: Context,
  settings: SagaSettings,
  manifestOf: (sagaId: string) => ForceCloseManifest | undefined,
  alerts: AlertSink = noopAlertSink,
): JanitorCounts {
  const store = ctx.get(SAGA_STORE)
  const at = ctx.get(SAGA_CLOCK).now()
  const counts = { alerted: 0, frozen: 0, closed: 0 }

  for (const sagaId of store.activeSagas()) {
    const saga = store.loadTransaction(sagaId)
    if (saga === undefined) continue
    const age = at - saga.createdAt

    if (age > settings.forceCloseMs) {
      forceClose(ctx, sagaId, manifestOf(sagaId))
      counts.closed += 1
      continue
    }
    if (age > settings.hardSlaMs) {
      freezeAndEscalate(ctx, settings, sagaId, age, at)
      counts.frozen += 1
      continue
    }
    if (age > settings.softSlaMs) {
      alertSoft(sagaId, age, alerts)
      counts.alerted += 1
    }
  }

  // 清道夫自身心跳入监控（M8）；即使本轮零动作也要刷新。
  recordJobHeartbeat(ctx, 'janitor', at)
  return counts
}
