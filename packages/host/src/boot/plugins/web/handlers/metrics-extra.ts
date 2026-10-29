/**
 * `/api/metrics` 的 9 个新段与 Prometheus 输入（可观测性 02 / S2.8）。
 *
 * 为什么单独成文件：`metrics.ts` 既有 10 个顶层键的计算是**一行都不许改**的行为基线；
 * 新段全部从"同一份事件快照"派生，放在这里既不改老代码，也能被 Prometheus 复用。
 * 文件保持在 200 行以内（由 `contract.test.ts` 的结构预算守）。
 */

import { readProcessSnapshot, type MetricInputs, type ProcessSnapshot } from '@bah/telemetry'
import { sloVerdict, type SloSample } from '@bah/saga'
import { logStats, type LogStats } from '@bah/util'

import { sseFrameStats } from '../sse.ts'
import { alertSamples, alertSummary, type AlertLevel, type AlertResult } from '../../alert-stats.ts'
import type { TelemetryHandle } from '../../telemetry.ts'
import type { WebDeps } from '../deps.ts'

/** 一次请求内的统一快照（JSON 与 Prometheus 共用，避免两套口径）。 */
export interface MetricsView {
  readonly events: readonly { readonly at: number; readonly type: string; readonly data: unknown }[]
  readonly handle: TelemetryHandle | undefined
  readonly process: ProcessSnapshot
  readonly logs: LogStats
  readonly slo: Readonly<Record<string, SloSample>> | undefined
  readonly costConfigured: boolean
  readonly sseClients: number
  readonly sseFrames: { readonly frame: number; readonly fault: number }
}

/** 读一次进程/会话/遥测快照。`derive()` 先吸收派生 span，再取记录器快照。 */
export function buildMetricsView(deps: WebDeps): MetricsView {
  const handle = deps.tryTelemetry()
  handle?.derive()
  return {
    events: deps.session.events(),
    handle,
    process: readProcessSnapshot(deps.now()),
    logs: logStats(),
    slo: deps.trySlo(),
    costConfigured: handle?.costConfigured() ?? false,
    sseClients: deps.hub.size(),
    sseFrames: sseFrameStats(),
  }
}

/** JSON 的 9 个新段（既有 10 键由 `handleMetrics` 保留）。 */
export function jsonExtrasOf(view: MetricsView): Record<string, unknown> {
  const spans = view.handle?.recorder.snapshot() ?? []
  const http = httpOf(spans)
  const llm = llmOf(view.events, spans)
  const usage = usageOf(view.events)
  const budget = budgetOf(view)
  const plan = planOf(view.events)
  const slo = sloJsonOf(view.slo)
  const derived = view.handle?.derive()

  return {
    http,
    llm,
    cost: {
      configured: view.costConfigured,
      currency: 'micro_yuan',
      total: usage.total.costMicroYuan,
      byTurn: usage.byTurn,
      budget,
    },
    plan,
    slo,
    process: {
      uptimeSec: view.process.uptimeSec,
      rssBytes: view.process.rssBytes,
      heapUsedBytes: view.process.heapUsedBytes,
      eventLoopP99Sec: view.process.eventLoopP99Sec,
      node: view.process.nodeVersion,
    },
    telemetry: {
      spans: view.handle?.stats.size ?? 0,
      dropped: view.handle?.stats.dropped ?? 0,
      treeDepth: maxDepth(derived?.roots ?? []),
    },
    logs: { byLevel: view.logs.byLevel, suppressed: view.logs.suppressed },
    alerts: alertSummary(),
  }
}

/** Prometheus 的 `MetricInputs`。 */
export function metricInputsOf(view: MetricsView): MetricInputs {
  const handle = view.handle
  const usage = usageOf(view.events)
  const guard = handle?.guardLimits ?? { maxTurnCostMicroYuan: 0, maxSessionCostMicroYuan: 0, maxTurnOutputTokens: 0 }
  const exhausted = handle?.budgetExhausted() ?? { turn: 0, session: 0 }
  const lastTurn = usage.lastTurn
  const turnUsage = lastTurn === undefined ? undefined : handle?.usage.ofTurn(lastTurn)

  return {
    events: view.events,
    spans: handle?.recorder.snapshot() ?? [],
    stats: { spans: handle?.stats.size ?? 0, dropped: handle?.stats.dropped ?? 0 },
    process: view.process,
    ...(view.slo === undefined
      ? {}
      : {
          slo: Object.fromEntries(
            Object.entries(view.slo).map(([name, sample]) => [
              name,
              { value: sample.value, soft: sample.soft, hard: sample.hard, unit: sample.unit },
            ]),
          ),
        }),
    budget: {
      turn:
        guard.maxTurnCostMicroYuan > 0
          ? {
              used: turnUsage?.costMicroYuan ?? 0,
              limit: guard.maxTurnCostMicroYuan,
              exhausted: exhausted.turn,
            }
          : null,
      session:
        guard.maxSessionCostMicroYuan > 0
          ? { used: usage.total.costMicroYuan, limit: guard.maxSessionCostMicroYuan, exhausted: exhausted.session }
          : null,
    },
    logs: { byLevel: view.logs.byLevel, suppressed: view.logs.suppressed },
    alerts: { samples: alertSamples() },
    costConfigured: view.costConfigured,
    sseClients: view.sseClients,
    sseFrames: view.sseFrames,
  }
}

/* ────────────────────────────── 内部派生 ────────────────────────────── */

function quantile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((left, right) => left - right)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number)
}

function httpOf(spans: readonly { readonly name: string; readonly startMs: number; readonly endMs: number | null; readonly attributes: Readonly<Record<string, string | number | boolean>> }[]): Record<string, unknown> {
  const durations: number[] = []
  let requests = 0
  let errors = 0
  let rateLimited = 0
  let inFlight = 0
  for (const span of spans) {
    if (span.name !== 'http.request') continue
    if (span.endMs === null) {
      inFlight += 1
      continue
    }
    requests += 1
    const status = Number(span.attributes['status'] ?? 0)
    if (status >= 500) errors += 1
    if (status === 429) rateLimited += 1
    durations.push(Math.max(0, span.endMs - span.startMs))
  }
  return { requests, errors, rateLimited, inFlight, durationMs: { p50: quantile(durations, 0.5), p95: quantile(durations, 0.95) } }
}

function llmOf(events: readonly { readonly type: string; readonly data: unknown }[], spans: readonly { readonly name: string; readonly attributes: Readonly<Record<string, string | number | boolean>> }[]): Record<string, unknown> {
  let requests = 0
  let errors = 0
  const ttft: number[] = []
  for (const event of events) {
    if (event.type === 'request/header') requests += 1
    if (event.type === 'assistant/attempt') errors += 1
  }
  for (const span of spans) {
    if (span.name !== 'llm.call') continue
    const value = span.attributes['ttftMs']
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) ttft.push(value)
  }
  return { requests, errors, ttftMs: { p50: quantile(ttft, 0.5), p95: quantile(ttft, 0.95) }, tokensPerTurn: tokensPerTurnOf(events) }
}

function tokensPerTurnOf(events: readonly { readonly type: string; readonly data: unknown }[]): { turn: number; input: number; output: number; cachedInput: number }[] {
  const byTurn = new Map<number, { turn: number; input: number; output: number; cachedInput: number }>()
  for (const event of events) {
    if (event.type !== 'usage/summary') continue
    const data = event.data as Record<string, unknown>
    const turn = typeof data['turn'] === 'number' ? data['turn'] : 0
    const row = byTurn.get(turn) ?? { turn, input: 0, output: 0, cachedInput: 0 }
    row.input += number(data['input'])
    row.output += number(data['output'])
    row.cachedInput += number(data['cachedInput'])
    byTurn.set(turn, row)
  }
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn)
}

function usageOf(events: readonly { readonly type: string; readonly data: unknown }[]): {
  total: { costMicroYuan: number }
  byTurn: { turn: number; costMicroYuan: number; input: number; output: number }[]
  lastTurn: number | undefined
} {
  const byTurn = new Map<number, { turn: number; costMicroYuan: number; input: number; output: number }>()
  let total = 0
  let lastTurn: number | undefined
  for (const event of events) {
    if (event.type !== 'usage/summary') continue
    const data = event.data as Record<string, unknown>
    const turn = typeof data['turn'] === 'number' ? data['turn'] : 0
    const cost = number(data['costMicroYuan'])
    const row = byTurn.get(turn) ?? { turn, costMicroYuan: 0, input: 0, output: 0 }
    row.costMicroYuan += cost
    row.input += number(data['input'])
    row.output += number(data['output'])
    byTurn.set(turn, row)
    total += cost
    lastTurn = turn
  }
  return {
    total: { costMicroYuan: total },
    byTurn: [...byTurn.values()].sort((left, right) => left.turn - right.turn).slice(-50),
    lastTurn,
  }
}

function budgetOf(view: MetricsView): Record<string, unknown> {
  const handle = view.handle
  const usage = usageOf(view.events)
  const guard = handle?.guardLimits ?? { maxTurnCostMicroYuan: 0, maxSessionCostMicroYuan: 0, maxTurnOutputTokens: 0 }
  const turnUsage = usage.lastTurn === undefined ? 0 : (handle?.usage.ofTurn(usage.lastTurn).costMicroYuan ?? 0)
  const scope = (used: number, limit: number): Record<string, number> | null =>
    limit > 0 ? { used, limit, remaining: limit - used } : null
  return {
    turn: scope(turnUsage, guard.maxTurnCostMicroYuan),
    session: scope(usage.total.costMicroYuan, guard.maxSessionCostMicroYuan),
  }
}

function planOf(events: readonly { readonly type: string; readonly data: unknown }[]): Record<string, unknown> {
  const nodes = { succeeded: 0, failed: 0, blocked: 0, skipped: 0 }
  for (const event of events) {
    if (event.type === 'plan/node-blocked') nodes.blocked += 1
    if (event.type === 'plan/node-result') {
      const status = String((event.data as Record<string, unknown>)['status'] ?? 'failed')
      if (status === 'succeeded' || status === 'failed' || status === 'skipped') nodes[status] += 1
    }
  }
  return { nodes }
}

function sloJsonOf(slo: Readonly<Record<string, SloSample>> | undefined): Record<string, unknown> | null {
  if (slo === undefined) return null
  return Object.fromEntries(
    Object.entries(slo).map(([name, sample]) => [
      name,
      { value: sample.value, verdict: sloVerdict(sample.value, sample.soft, sample.hard), unit: sample.unit, soft: sample.soft, hard: sample.hard },
    ]),
  )
}

function maxDepth(roots: readonly { readonly depth: number; readonly children: readonly { readonly depth: number; readonly children: readonly unknown[] }[] }[]): number {
  let depth = 0
  const walk = (node: { readonly depth: number; readonly children: readonly unknown[] }): void => {
    depth = Math.max(depth, node.depth)
    for (const child of node.children) walk(child as { readonly depth: number; readonly children: readonly unknown[] })
  }
  for (const root of roots) walk(root)
  return depth
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 供测试/门禁确认告警标签闭集。 */
export type { AlertLevel, AlertResult }
