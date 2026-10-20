/**
 * 进程内告警总线 + SLO 八指标（SA-13 §3.4）。
 *
 * 纪律：
 * - **无 MQ**：出口是进程内 sink（`registerAlertSink`），邮件/webhook 由 bank/渠道适配器消费；
 * - P0（链断裂 / 回放 diff / 心跳失败 …）**只进 sink**，绝不冒充 `saga/dlq-escalated`；
 * - DLQ 深度只在**真实 DLQ 升级事件**（上游已落 `dlq_entry`）上做越阈升级；
 * - 阈值全部来自 `SagaSettings` 与终稿 §8，不新增 Config 字段；
 * - 本模块不是 ServiceKey，不占 SA-00 §4.5 冻结面。
 */

import { lastJobHeartbeat, recordJobHeartbeat, type TickJobName } from '../tick/registry.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE } from '../seams.ts'

import type { Context, Disposer } from '@bah/core'

import type { AlertSink as LegacyAlertSink } from './sink.ts'
import type { SagaSettings } from '../types.ts'

/* ────────────────────────────── SLO 八指标 ────────────────────────────── */

/** 八指标（源 05 §5.9 / 06 §8）。 */
export type SloMetric =
  | 'compFailureRate'
  | 'danglingP95'
  | 'posNegMismatchRate'
  | 'dlqDepth'
  | 'chainBreak'
  | 'rto'
  | 'reconHeartbeat'
  | 'residualDiffRate'

/** 指标顺序（看板导出稳定）。 */
export const SLO_METRICS = [
  'compFailureRate',
  'danglingP95',
  'posNegMismatchRate',
  'dlqDepth',
  'chainBreak',
  'rto',
  'reconHeartbeat',
  'residualDiffRate',
] as const satisfies readonly SloMetric[]

/** 单指标观测值；`null` = 显式「无数据」，不是 0。 */
export interface SloSample {
  readonly metric: SloMetric
  readonly value: number | null
  readonly unit: 'ratio' | 'ms' | 'count' | 'days'
  readonly soft: number
  readonly hard: number
  readonly detail: string
}

/** 无法从存储直接推导的指标由装配位/对账 job 注入。 */
export interface SloObservations {
  /** 正反向不一致条数 / 参与 saga 数。 */
  readonly posNegDiff?: number
  readonly participatingSagas?: number
  /** 最近一次进程重启到恢复调度耗时。 */
  readonly rtoMs?: number
  /** 残差账本 vs 对账单差异条数 / 对账总数。 */
  readonly residualDiff?: number
  readonly residualTotal?: number
}

/** 阈值：来自 SA-00 §10 Config 与 06 终稿 §8。 */
function sample(
  metric: SloMetric,
  value: number | null,
  unit: SloSample['unit'],
  soft: number,
  hard: number,
  detail: string,
): SloSample {
  return { metric, value, unit, soft, hard, detail }
}

function ratio(diff: number | undefined, total: number | undefined): number | null {
  if (diff === undefined || total === undefined || total <= 0) return null
  return diff / total
}

/**
 * 汇总八指标：每个键都有一项（无数据 → `value: null`），看板不存在遗漏。
 * 只读存储/链/心跳，零外部调用。
 */
export function collectSloMetrics(
  ctx: Context,
  settings: SagaSettings,
  observations: SloObservations = {},
): Readonly<Record<SloMetric, SloSample>> {
  const store = ctx.get(SAGA_STORE)
  const now = ctx.get(SAGA_CLOCK).now()

  const transactions = store.listAllSagas()
  let compTotal = 0
  let compFailed = 0
  for (const saga of transactions) {
    for (const comp of store.tx((tx) => tx.listCompensations(saga.sagaId))) {
      compTotal += 1
      if (comp.state === 'DLQ' || comp.state === 'ERR' || comp.state === 'UNKNOWN') compFailed += 1
    }
  }

  const active = store.activeSagas()
  const ages = active
    .map((sagaId) => store.loadTransaction(sagaId))
    .flatMap((saga) => (saga === undefined ? [] : [Math.max(0, now - saga.createdAt)]))
    .sort((left, right) => left - right)

  const depth = store.tx((tx) => tx.dlqDepth())
  const chainBreak = chainBreakCount(ctx)
  const reconLast = lastJobHeartbeat(ctx, 'recon')
  const reconAgeDays = reconLast === undefined ? null : Math.max(0, now - reconLast) / 86_400_000

  return {
    compFailureRate: sample(
      'compFailureRate',
      compTotal === 0 ? 0 : compFailed / compTotal,
      'ratio',
      0.005,
      0.02,
      `补偿失败 ${compFailed}/${compTotal}（DLQ/ERR/UNKNOWN）`,
    ),
    danglingP95: sample(
      'danglingP95',
      p95(ages),
      'ms',
      settings.softSlaMs,
      settings.hardSlaMs,
      `非终态 ${ages.length} 个；P95 存活时长`,
    ),
    posNegMismatchRate: sample(
      'posNegMismatchRate',
      ratio(observations.posNegDiff, observations.participatingSagas),
      'ratio',
      0.001,
      0.005,
      '正反向不一致（对账注入）',
    ),
    dlqDepth: sample('dlqDepth', depth, 'count', settings.dlqAlertDepth, settings.dlqPhoneDepth, '未处置 DLQ 条数'),
    chainBreak: sample('chainBreak', chainBreak, 'count', 0, 1, '审计链断裂数（>0 即 P0）'),
    rto: sample('rto', observations.rtoMs ?? null, 'ms', 300_000, 300_000, '重启→恢复调度（>5min）'),
    reconHeartbeat: sample(
      'reconHeartbeat',
      reconAgeDays,
      'days',
      1,
      2,
      reconLast === undefined ? '对账 job 尚无心跳' : `距上次成功 ${reconAgeDays?.toFixed(2)} 天`,
    ),
    residualDiffRate: sample(
      'residualDiffRate',
      ratio(observations.residualDiff, observations.residualTotal),
      'ratio',
      0.001,
      0.005,
      '残差账本 vs 对账单差异率',
    ),
  }
}

/** 指标越阈等级：`null` 无数据；`P0` 越 hard；`alert` 越 soft；`ok` 未越阈。 */
export function sloVerdict(value: number | null, soft: number, hard: number): 'ok' | 'alert' | 'P0' | 'no-data' {
  if (value === null) return 'no-data'
  if (value >= hard) return 'P0'
  if (value >= soft) return 'alert'
  return 'ok'
}

function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * 0.95) - 1))
  return values[index] as number
}

function chainBreakCount(ctx: Context): number {
  try {
    return ctx.get(SAGA_AUDIT).verify().ok ? 0 : 1
  } catch {
    // 审计服务不可用与"链确实断了"是不同故障：分别计数，避免 SLO 面板把启动顺序问题
    // 当成数据完整性事故（仍按 1 计入，安全侧宁可高估）。
    chainVerifyErrors += 1
    return 1
  }
}

/* ────────────────────────────── 告警汇（sink） ────────────────────────────── */

/** 一条告警：`alert` = 常规；`P0` = 立即升级。 */
export interface AlertEvent {
  readonly level: 'alert' | 'P0'
  readonly metric?: SloMetric
  readonly detail: string
}

/** 告警 sink（进程内出口；邮件/webhook 由消费端实现）。 */
export type AlertEventSink = (event: AlertEvent) => void

const sinks = new Set<AlertEventSink>()

/** 告警出口自身失败的累计数（SLO 面板可读；不反向影响业务路径）。 */
let sinkErrors = 0
/** 审计链校验抛错（服务不可用 / IO 失败）的累计数，区别于"链断"。 */
let chainVerifyErrors = 0

/** 告警出口失败计数（进程级；暴露给运维面板与测试）。 */
export function alertSinkErrorCount(): number {
  return sinkErrors
}

/** 审计链校验抛错计数（与 `chainBreakCount` 的"断链"分开观察）。 */
export function alertChainVerifyErrorCount(): number {
  return chainVerifyErrors
}

/** 订阅告警汇；返回退订 disposer（可直接交给 `ctx.effect`）。 */
export function registerAlertSink(fn: AlertEventSink): Disposer {
  sinks.add(fn)
  return () => {
    sinks.delete(fn)
  }
}

/** 扇出到所有 sink；sink 自身抛错不阻断后续（告警链路不能因一个消费端失联而断）。 */
function fanout(event: AlertEvent): void {
  for (const sink of [...sinks]) {
    try {
      sink(event)
    } catch {
      // 告警出口的失败不反向影响业务路径；计数后由宿主日志兜底。
      sinkErrors += 1
    }
  }
}

/** P0：只进 sink（不派发 `saga/dlq-escalated`）。 */
export function page(_ctx: Context, _level: 'P0', detail: string): void {
  fanout({ level: 'P0', detail })
}

/** 常规告警：带指标名进 sink。 */
export function alertSoft(metric: SloMetric, detail: string): void {
  fanout({ level: 'alert', metric, detail })
}

/** 直接投递一条告警（演练/测试用）。 */
export function emitAlert(event: AlertEvent): void {
  fanout(event)
}

/** 进程内告警总线（非 ServiceKey）。 */
export interface AlertBus {
  alert(metric: SloMetric, detail: string): void
  page(ctx: Context, level: 'P0', detail: string): void
}

/**
 * 装配告警总线：DLQ 深度越阈只由**真实升级事件**触发。
 *
 * `ctx.events.on` 自行返回 disposer，这里交给 `ctx.effect` 登记；
 * 不要把监听器包进 `ctx.effect(() => { on(...) })`（参数只在 dispose 时执行）。
 */
export function provideAlertBus(ctx: Context, settings: SagaSettings): AlertBus {
  ctx.effect(
    ctx.events.on('saga/dlq-escalated', () => {
      const depth = ctx.get(SAGA_STORE).tx((tx) => tx.dlqDepth())
      if (depth >= settings.dlqAlertDepth) {
        fanout({ level: 'alert', metric: 'dlqDepth', detail: `DLQ 深度 ${depth}` })
      }
      if (depth >= settings.dlqPhoneDepth) {
        fanout({ level: 'P0', metric: 'dlqDepth', detail: `电话升级：DLQ 深度 ${depth}` })
      }
    }),
  )

  return {
    alert: (metric, detail) => fanout({ level: 'alert', metric, detail }),
    page: (busCtx, level, detail) => page(busCtx, level, detail),
  }
}

/** 批 5 的 `(level, message)` 出口 → 告警汇（宿主装配 janitor/recon 时使用）。 */
export function legacyAlertSink(): LegacyAlertSink {
  return (level, message) => {
    fanout({ level: level === 'P0' ? 'P0' : 'alert', detail: message })
  }
}

/** 心跳助手：job 自身运行状态（M8），非 ServiceKey。 */
export function heartbeat(ctx: Context, job: TickJobName, at: number): void {
  recordJobHeartbeat(ctx, job, at)
}

/**
 * 链健康检查：`verify` 断裂或验签异常 → P0 只进 sink。
 *
 * @returns 与 `SagaAudit.verify` 同形；异常归一为 `{ ok:false }`
 */
export function checkChainHealth(ctx: Context, sagaId?: string): { ok: boolean; brokenAt?: number } {
  try {
    const result = ctx.get(SAGA_AUDIT).verify(sagaId)
    if (!result.ok) {
      page(ctx, 'P0', `chain-broken: ${sagaId ?? 'all'} at ${String(result.brokenAt)}`)
    }
    return result
  } catch (error) {
    page(ctx, 'P0', `chain-verify-failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false }
  }
}
