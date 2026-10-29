/**
 * 指标登记表 + 派生入口（可观测性 02 / S2.3）。
 *
 * **唯一真相**：36 个 metric family 只在这里声明一次；Prometheus 渲染、JSON 端点、
 * 文档表、门禁都从这张表读。多一个少一个都红。
 *
 * `collectMetrics` 是**纯函数**：不读环境、不读磁盘、不读时钟；进程数字由调用方给。
 * 这样"指标与事实不打架"可以用 10 个纯用例钉住，不需要起进程。
 *
 * 三条纪律：
 * 1. 标签值必须来自闭集（`labelValues` / `labelValuesFrom`），否则基数会随输入爆炸；
 * 2. 计数与金额只从事件算（span 只用于 HTTP / TTFT 这类没有成对事件的面）；
 * 3. `null` / `0` / 未配置是三件事：SLO 无数据输出 NaN，预算未配不输出 series。
 */

import type { TelemetrySpan } from './span.ts'
import type { ProcessSnapshot } from './process.ts'

/** 一个指标的声明（字段含义见 02 §3.1）。 */
export interface MetricSpec {
  readonly name: string
  readonly type: 'counter' | 'gauge' | 'histogram'
  readonly help: string
  readonly labels: readonly string[]
  readonly labelValues?: Readonly<Record<string, readonly string[]>>
  readonly labelValuesFrom?: Readonly<Record<string, 'routes' | 'tools' | 'models'>>
  readonly unit?: 'seconds' | 'bytes' | 'count' | 'micro_yuan'
  readonly source: string
}

/** 一个样本（histogram 的 `value` 为 null，数据在 `histogram`）。 */
export interface MetricSample {
  readonly labels: Readonly<Record<string, string>>
  readonly value: number | null
  readonly histogram?: {
    readonly buckets: readonly { readonly le: number; readonly count: number }[]
    readonly sum: number
    readonly count: number
  }
}

/** 家族 → 样本；Prometheus 与 JSON 都从它渲染。 */
export interface MetricFamily {
  readonly spec: MetricSpec
  readonly samples: readonly MetricSample[]
}

/** 预算一档（`limit <= 0` 视为未配置，不输出 series）。 */
export interface BudgetScope {
  readonly used: number
  readonly limit: number
  readonly exhausted: number
}

/** `collectMetrics` 的全部输入（全部是快照，不在函数内读外部状态）。 */
export interface MetricInputs {
  readonly events: readonly { readonly at: number; readonly type: string; readonly data: unknown }[]
  readonly spans: readonly TelemetrySpan[]
  readonly stats: { readonly spans: number; readonly dropped: number }
  readonly process: ProcessSnapshot
  readonly slo?: Readonly<
    Record<string, { readonly value: number | null; readonly soft: number; readonly hard: number; readonly unit: string }>
  >
  readonly budget?: { readonly turn: BudgetScope | null; readonly session: BudgetScope | null }
  readonly logs: { readonly byLevel: Readonly<Record<string, number>>; readonly suppressed: number }
  readonly alerts: {
    readonly samples: readonly {
      readonly level: 'alert' | 'P0'
      readonly result: 'stderr' | 'file' | 'webhook' | 'failed'
      readonly count: number
    }[]
  }
  readonly costConfigured: boolean
  /** SSE 当前连接数（复用 hub 的既有值，不另建计数）。 */
  readonly sseClients?: number
  /** SSE 帧计数（`publish` / `publishFault`）。 */
  readonly sseFrames?: { readonly frame: number; readonly fault: number }
}

/** 直方图桶（02 §3.3 固定，不按指标定制）。 */
export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const
export const TOOL_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const
export const APPROVAL_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800] as const

const TURN_REASONS = ['completed', 'blocked', 'aborted', 'max-tokens', 'guard-stopped', 'failed'] as const
const LLM_STATUS = ['request', 'error'] as const
const TOKEN_KINDS = ['input', 'cached_input', 'output'] as const
const TOOL_TIERS = ['green', 'yellow', 'red'] as const
const CODE_CLASSES = ['approval', 'validation', 'sandbox', 'internal', 'other'] as const
const APPROVAL_DECISIONS = ['approved', 'rejected', 'other'] as const
const PLAN_NODE_STATUS = ['succeeded', 'failed', 'blocked', 'skipped'] as const
const PLAN_STATUS = ['succeeded', 'failed', 'aborted'] as const
const SLO_VERDICTS = ['ok', 'alert', 'P0', 'no-data'] as const
const BUDGET_SCOPES = ['turn', 'session'] as const
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const ALERT_LEVELS = ['alert', 'P0'] as const
const ALERT_RESULTS = ['stderr', 'file', 'webhook', 'failed'] as const
const SSE_EVENTS = ['frame', 'fault'] as const
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'] as const

/** 36 个 metric family（逐字来自 02 §3.2）。 */
export const METRIC_SPECS: readonly MetricSpec[] = [
  { name: 'bah_up', type: 'gauge', help: 'Process is up', labels: [], unit: 'count', source: '恒 1；进程活着就能被抓到' },
  {
    name: 'bah_build_info',
    type: 'gauge',
    help: 'Build information',
    labels: ['version', 'node'],
    labelValues: { version: ['0.1.0'], node: ['v22', 'v24'] },
    unit: 'count',
    source: '包版本 + process.version',
  },
  {
    name: 'bah_process_start_time_seconds',
    type: 'gauge',
    help: 'Process start time since epoch',
    labels: [],
    unit: 'seconds',
    source: 'now - uptime',
  },
  {
    name: 'bah_process_uptime_seconds',
    type: 'gauge',
    help: 'Process uptime in seconds',
    labels: [],
    unit: 'seconds',
    source: 'process.uptime()',
  },
  {
    name: 'bah_nodejs_rss_bytes',
    type: 'gauge',
    help: 'Resident set size',
    labels: [],
    unit: 'bytes',
    source: 'process.memoryUsage().rss',
  },
  {
    name: 'bah_nodejs_heap_used_bytes',
    type: 'gauge',
    help: 'Heap used',
    labels: [],
    unit: 'bytes',
    source: 'process.memoryUsage().heapUsed',
  },
  {
    name: 'bah_nodejs_eventloop_lag_p99_seconds',
    type: 'gauge',
    help: 'Event loop delay p99',
    labels: [],
    unit: 'seconds',
    source: 'monitorEventLoopDelay 的 p99（每次抓取读一次）',
  },
  {
    name: 'bah_http_requests_total',
    type: 'counter',
    help: 'Completed HTTP requests',
    labels: ['route', 'method', 'status'],
    labelValues: { method: HTTP_METHODS, status: ['200', '201', '202', '204', '400', '401', '403', '404', '405', '409', '423', '429', '500', '503'] },
    labelValuesFrom: { route: 'routes' },
    unit: 'count',
    source: 'http.request span 结束',
  },
  {
    name: 'bah_http_request_duration_seconds',
    type: 'histogram',
    help: 'HTTP request duration',
    labels: ['route'],
    labelValuesFrom: { route: 'routes' },
    unit: 'seconds',
    source: '同上，桶见 02 §3.3',
  },
  {
    name: 'bah_http_in_flight',
    type: 'gauge',
    help: 'In-flight HTTP requests',
    labels: [],
    unit: 'count',
    source: '当前未结束的 http.request span 数',
  },
  {
    name: 'bah_http_rate_limited_total',
    type: 'counter',
    help: 'Rate limited requests',
    labels: [],
    unit: 'count',
    source: '429 次数',
  },
  {
    name: 'bah_sse_clients',
    type: 'gauge',
    help: 'Connected SSE clients',
    labels: [],
    unit: 'count',
    source: 'hub.size()（复用既有值）',
  },
  {
    name: 'bah_sse_frames_total',
    type: 'counter',
    help: 'SSE frames published',
    labels: ['event'],
    labelValues: { event: SSE_EVENTS },
    unit: 'count',
    source: 'hub.publish / publishFault',
  },
  {
    name: 'bah_turns_total',
    type: 'counter',
    help: 'Finished turns',
    labels: [],
    unit: 'count',
    source: 'turn/end 条数（=== JSON 的 turns）',
  },
  {
    name: 'bah_turn_duration_seconds',
    type: 'histogram',
    help: 'Turn duration',
    labels: [],
    unit: 'seconds',
    source: 'turn/start → turn/end',
  },
  {
    name: 'bah_turn_end_total',
    type: 'counter',
    help: 'Turns by end reason',
    labels: ['reason'],
    labelValues: { reason: TURN_REASONS },
    unit: 'count',
    source: 'turn/end.reason.kind',
  },
  {
    name: 'bah_steps_total',
    type: 'counter',
    help: 'Finished steps',
    labels: [],
    unit: 'count',
    source: 'step/end 条数',
  },
  {
    name: 'bah_llm_requests_total',
    type: 'counter',
    help: 'LLM requests',
    labels: ['model', 'status'],
    labelValues: { status: LLM_STATUS },
    labelValuesFrom: { model: 'models' },
    unit: 'count',
    source: 'request/header 计 request，assistant/attempt 计 error',
  },
  {
    name: 'bah_llm_ttft_seconds',
    type: 'histogram',
    help: 'LLM time to first token',
    labels: ['model'],
    labelValuesFrom: { model: 'models' },
    unit: 'seconds',
    source: 'llm.call span 的 ttftMs',
  },
  {
    name: 'bah_llm_tokens_total',
    type: 'counter',
    help: 'LLM tokens',
    labels: ['kind'],
    labelValues: { kind: TOKEN_KINDS },
    unit: 'count',
    source: 'usage/summary 累加',
  },
  {
    name: 'bah_llm_cost_micro_yuan_total',
    type: 'counter',
    help: 'LLM cost in micro yuan',
    labels: ['model'],
    labelValuesFrom: { model: 'models' },
    unit: 'micro_yuan',
    source: 'usage/summary.costMicroYuan 累加（整数）',
  },
  {
    name: 'bah_llm_cost_configured',
    type: 'gauge',
    help: 'Whether pricing is configured',
    labels: [],
    unit: 'count',
    source: '1 = 配了 pricing；0 = 未配',
  },
  {
    name: 'bah_tool_calls_total',
    type: 'counter',
    help: 'Tool calls',
    labels: ['tool', 'tier'],
    labelValues: { tier: TOOL_TIERS },
    labelValuesFrom: { tool: 'tools' },
    unit: 'count',
    source: 'tool/call',
  },
  {
    name: 'bah_tool_errors_total',
    type: 'counter',
    help: 'Tool errors by class',
    labels: ['tool', 'codeClass'],
    labelValues: { codeClass: CODE_CLASSES },
    labelValuesFrom: { tool: 'tools' },
    unit: 'count',
    source: 'tool/result.isError；code 按前缀归成 5 类',
  },
  {
    name: 'bah_tool_duration_seconds',
    type: 'histogram',
    help: 'Tool execution duration',
    labels: ['tool'],
    labelValuesFrom: { tool: 'tools' },
    unit: 'seconds',
    source: 'tool/result.durationMs（权威值）',
  },
  {
    name: 'bah_approvals_total',
    type: 'counter',
    help: 'Approval decisions',
    labels: ['decision'],
    labelValues: { decision: APPROVAL_DECISIONS },
    unit: 'count',
    source: 'approval/decided',
  },
  {
    name: 'bah_approval_wait_seconds',
    type: 'histogram',
    help: 'Approval wait time',
    labels: ['name'],
    labelValues: { name: ['safety_unfreeze', 'other'] },
    labelValuesFrom: { name: 'tools' },
    unit: 'seconds',
    source: 'approval/asked → decided 的墙钟',
  },
  {
    name: 'bah_plan_nodes_total',
    type: 'counter',
    help: 'Plan node outcomes',
    labels: ['status'],
    labelValues: { status: PLAN_NODE_STATUS },
    unit: 'count',
    source: 'plan/node-result + plan/node-blocked',
  },
  {
    name: 'bah_plan_duration_seconds',
    type: 'histogram',
    help: 'Plan run duration',
    labels: ['status'],
    labelValues: { status: PLAN_STATUS },
    unit: 'seconds',
    source: 'plan/completed.durationMs',
  },
  {
    name: 'bah_slo_value',
    type: 'gauge',
    help: 'SLO values',
    labels: ['metric', 'verdict'],
    labelValues: {
      metric: [
        'compFailureRate',
        'danglingP95',
        'posNegMismatchRate',
        'dlqDepth',
        'chainBreak',
        'rto',
        'reconHeartbeat',
        'residualDiffRate',
      ],
      verdict: SLO_VERDICTS,
    },
    unit: 'count',
    source: 'collectSloMetrics 八项；无数据 → NaN',
  },
  {
    name: 'bah_cost_budget_remaining_micro_yuan',
    type: 'gauge',
    help: 'Remaining cost budget',
    labels: ['scope'],
    labelValues: { scope: BUDGET_SCOPES },
    unit: 'micro_yuan',
    source: '预算余额；未配预算 → 不输出该系列',
  },
  {
    name: 'bah_cost_budget_exhausted_total',
    type: 'counter',
    help: 'Budget exhausted events',
    labels: ['scope'],
    labelValues: { scope: BUDGET_SCOPES },
    unit: 'count',
    source: '触发判停次数',
  },
  {
    name: 'bah_telemetry_spans',
    type: 'gauge',
    help: 'Spans in ring buffer',
    labels: [],
    unit: 'count',
    source: '环形缓冲当前条数',
  },
  {
    name: 'bah_telemetry_spans_dropped_total',
    type: 'counter',
    help: 'Dropped spans',
    labels: ['reason'],
    labelValues: { reason: ['capacity'] },
    unit: 'count',
    source: '淘汰计数',
  },
  {
    name: 'bah_log_lines_total',
    type: 'counter',
    help: 'Log lines by level',
    labels: ['level'],
    labelValues: { level: LOG_LEVELS },
    unit: 'count',
    source: '每个 level 写出的行数',
  },
  {
    name: 'bah_alerts_total',
    type: 'counter',
    help: 'Alert deliveries',
    labels: ['level', 'result'],
    labelValues: { level: ALERT_LEVELS, result: ALERT_RESULTS },
    unit: 'count',
    source: '告警扇出结果',
  },
]

/** 标签键排序（Prometheus 输出与内部去重都靠它）。 */
function labelKey(labels: Readonly<Record<string, string>>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key] ?? ''}`)
    .join('\u0001')
}

/** 代码 → 理由类（闭集 5 个；原始 code 只进 JSON 端点）。 */
export function codeClassOf(code: string | undefined): (typeof CODE_CLASSES)[number] {
  if (code === undefined || code.length === 0) return 'other'
  if (code.startsWith('approval-')) return 'approval'
  if (code.startsWith('tool-arg') || code.endsWith('-invalid') || code.startsWith('tool-schema-')) {
    return 'validation'
  }
  if (code.startsWith('sandbox-') || code.startsWith('compute-')) return 'sandbox'
  if (code.startsWith('tool-')) return 'internal'
  return 'other'
}

/** 审批结论 → 三分类（`other` 不并进 rejected）。 */
function approvalClass(decision: string): (typeof APPROVAL_DECISIONS)[number] {
  if (decision === 'allowed-once') return 'approved'
  if (decision === 'rejected') return 'rejected'
  return 'other'
}

/** SLO 阈值判决（与 saga 的 `sloVerdict` 同一口径；telemetry 不依赖 saga，所以就地实现）。 */
function verdictOf(value: number | null, soft: number, hard: number): (typeof SLO_VERDICTS)[number] {
  if (value === null) return 'no-data'
  if (value >= hard) return 'P0'
  if (value >= soft) return 'alert'
  return 'ok'
}

/** 直方图累积（`le` 是上界；+Inf 的 count 恒等于样本数）。 */
function histogramOf(
  values: readonly number[],
  buckets: readonly number[],
): NonNullable<MetricSample['histogram']> {
  const finite = [...buckets].sort((left, right) => left - right)
  const rows = finite.map((le) => ({
    le,
    count: values.filter((value) => value <= le).length,
  }))
  rows.push({ le: Number.POSITIVE_INFINITY, count: values.length })
  return {
    buckets: rows,
    sum: values.reduce((total, value) => total + value, 0),
    count: values.length,
  }
}

/** 从事件/span/快照派生全部 36 个 family。纯函数：同输入同输出。 */
export function collectMetrics(inputs: MetricInputs): readonly MetricFamily[] {
  const counters = new Map<string, Map<string, number>>()
  const gauges = new Map<string, Map<string, number>>()
  const histograms = new Map<string, Map<string, number[]>>()

  const bump = (name: string, labels: Readonly<Record<string, string>> = {}, amount = 1): void => {
    const bucket = counters.get(name) ?? new Map<string, number>()
    const key = labelKey(labels)
    bucket.set(key, (bucket.get(key) ?? 0) + amount)
    counters.set(name, bucket)
  }
  const setGauge = (name: string, labels: Readonly<Record<string, string>>, value: number): void => {
    const bucket = gauges.get(name) ?? new Map<string, number>()
    bucket.set(labelKey(labels), value)
    gauges.set(name, bucket)
  }
  const recordHist = (name: string, labels: Readonly<Record<string, string>>, value: number): void => {
    const bucket = histograms.get(name) ?? new Map<string, number[]>()
    const key = labelKey(labels)
    const values = bucket.get(key) ?? []
    values.push(value)
    bucket.set(key, values)
    histograms.set(name, bucket)
  }

  const turnStarts = new Map<number, number>()
  const callNames = new Map<string, string>()
  const asked = new Map<string, { readonly at: number; readonly name: string }>()
  const lastModelByTurn = new Map<number, string>()
  /** 最近一次 `request/header` 的模型：`assistant/attempt` 本身不带 turn/step/model。 */
  let currentModel = 'unknown'

  // 零样本 family：没有事件时也要有 series，否则"抓不到"和"值为 0"分不开。
  bump('bah_turns_total', {}, 0)
  bump('bah_steps_total', {}, 0)
  bump('bah_http_rate_limited_total', {}, 0)

  for (const event of inputs.events) {
    const at = typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : 0
    const data = recordOf(event.data)
    switch (event.type) {
      case 'turn/start': {
        const turn = numberOf(data, 'turn')
        if (turn !== undefined) turnStarts.set(turn, at)
        break
      }
      case 'turn/end': {
        bump('bah_turns_total')
        const turn = numberOf(data, 'turn')
        const reason = String(recordOf(data?.['reason'])?.['kind'] ?? 'failed')
        bump('bah_turn_end_total', { reason })
        const start = turn === undefined ? undefined : turnStarts.get(turn)
        if (start !== undefined) recordHist('bah_turn_duration_seconds', {}, Math.max(0, at - start) / 1000)
        break
      }
      case 'step/end':
        bump('bah_steps_total')
        break
      case 'request/header': {
        const model = String(data?.['model'] ?? 'unknown')
        bump('bah_llm_requests_total', { model, status: 'request' })
        currentModel = model
        const turn = numberOf(data, 'turn')
        if (turn !== undefined) lastModelByTurn.set(turn, model)
        break
      }
      case 'assistant/attempt': {
        // 事件本身不带 turn/step/model；用**最近一次** request/header 的模型归因。
        bump('bah_llm_requests_total', { model: currentModel, status: 'error' })
        break
      }
      case 'tool/call': {
        const name = String(data?.['name'] ?? 'unknown')
        const tier = String(recordOf(data?.['tier'])?.['level'] ?? 'green')
        bump('bah_tool_calls_total', { tool: name, tier })
        const callId = String(data?.['callId'] ?? '')
        if (callId.length > 0) callNames.set(callId, name)
        break
      }
      case 'tool/result': {
        const callId = String(data?.['callId'] ?? '')
        const name = String(data?.['name'] ?? callNames.get(callId) ?? 'unknown')
        if (data?.['isError'] === true) {
          bump('bah_tool_errors_total', { tool: name, codeClass: codeClassOf(stringOf(data?.['code'])) })
        }
        const duration = numberOf(data, 'durationMs')
        // `durationMs` 缺省 ≠ 0ms：缺省的样本直接跳过，不污染 _count/_sum。
        if (duration !== undefined && duration >= 0) {
          recordHist('bah_tool_duration_seconds', { tool: name }, duration / 1000)
        }
        break
      }
      case 'approval/asked': {
        const ticketId = String(data?.['ticketId'] ?? '')
        if (ticketId.length > 0) {
          asked.set(ticketId, { at, name: String(data?.['name'] ?? 'other') })
        }
        break
      }
      case 'approval/decided': {
        const ticketId = String(data?.['ticketId'] ?? '')
        const decision = String(data?.['decision'] ?? 'unavailable')
        bump('bah_approvals_total', { decision: approvalClass(decision) })
        const ask = asked.get(ticketId)
        if (ask !== undefined) {
          recordHist('bah_approval_wait_seconds', { name: ask.name }, Math.max(0, at - ask.at) / 1000)
        }
        break
      }
      case 'usage/summary': {
        const input = numberOf(data, 'input') ?? 0
        const output = numberOf(data, 'output') ?? 0
        const cached = numberOf(data, 'cachedInput') ?? 0
        const cost = numberOf(data, 'costMicroYuan') ?? 0
        const turn = numberOf(data, 'turn')
        bump('bah_llm_tokens_total', { kind: 'input' }, input)
        bump('bah_llm_tokens_total', { kind: 'cached_input' }, cached)
        bump('bah_llm_tokens_total', { kind: 'output' }, output)
        const model = (turn === undefined ? undefined : lastModelByTurn.get(turn)) ?? 'unknown'
        bump('bah_llm_cost_micro_yuan_total', { model }, cost)
        break
      }
      case 'plan/node-result': {
        bump('bah_plan_nodes_total', { status: String(data?.['status'] ?? 'failed') })
        break
      }
      case 'plan/node-blocked':
        bump('bah_plan_nodes_total', { status: 'blocked' })
        break
      case 'plan/completed': {
        const duration = numberOf(data, 'durationMs')
        if (duration !== undefined && duration >= 0) {
          recordHist('bah_plan_duration_seconds', { status: String(data?.['status'] ?? 'failed') }, duration / 1000)
        }
        break
      }
      default:
        break
    }
  }

  let inFlight = 0
  for (const span of inputs.spans) {
    if (span.name === 'http.request') {
      const route = String(span.attributes['route'] ?? 'unmatched')
      const method = String(span.attributes['method'] ?? 'GET')
      const status = String(span.attributes['status'] ?? 0)
      if (span.endMs === null) {
        inFlight += 1
        continue
      }
      bump('bah_http_requests_total', { route, method, status })
      const duration = Math.max(0, span.endMs - span.startMs) / 1000
      recordHist('bah_http_request_duration_seconds', { route }, duration)
      if (status === '429') bump('bah_http_rate_limited_total')
      continue
    }
    if (span.name === 'llm.call') {
      const ttft = span.attributes['ttftMs']
      if (typeof ttft === 'number' && Number.isFinite(ttft) && ttft >= 0) {
        recordHist('bah_llm_ttft_seconds', { model: String(span.attributes['model'] ?? 'unknown') }, ttft / 1000)
      }
    }
  }

  setGauge('bah_up', {}, 1)
  setGauge('bah_build_info', { version: '0.1.0', node: majorNode(inputs.process.nodeVersion) }, 1)
  setGauge('bah_process_start_time_seconds', {}, inputs.process.startedAtMs / 1000)
  setGauge('bah_process_uptime_seconds', {}, inputs.process.uptimeSec)
  setGauge('bah_nodejs_rss_bytes', {}, inputs.process.rssBytes)
  setGauge('bah_nodejs_heap_used_bytes', {}, inputs.process.heapUsedBytes)
  setGauge('bah_nodejs_eventloop_lag_p99_seconds', {}, inputs.process.eventLoopP99Sec)
  setGauge('bah_http_in_flight', {}, inFlight)
  setGauge('bah_sse_clients', {}, inputs.sseClients ?? 0)
  bump('bah_sse_frames_total', { event: 'frame' }, inputs.sseFrames?.frame ?? 0)
  bump('bah_sse_frames_total', { event: 'fault' }, inputs.sseFrames?.fault ?? 0)
  setGauge('bah_llm_cost_configured', {}, inputs.costConfigured ? 1 : 0)
  setGauge('bah_telemetry_spans', {}, inputs.stats.spans)
  bump('bah_telemetry_spans_dropped_total', { reason: 'capacity' }, inputs.stats.dropped)
  for (const level of LOG_LEVELS) bump('bah_log_lines_total', { level }, inputs.logs.byLevel[level] ?? 0)

  for (const sample of inputs.alerts.samples) {
    bump('bah_alerts_total', { level: sample.level, result: sample.result }, sample.count)
  }

  if (inputs.budget?.turn !== undefined && inputs.budget.turn !== null && inputs.budget.turn.limit > 0) {
    const scope = inputs.budget.turn
    setGauge('bah_cost_budget_remaining_micro_yuan', { scope: 'turn' }, scope.limit - scope.used)
    bump('bah_cost_budget_exhausted_total', { scope: 'turn' }, scope.exhausted)
  }
  if (
    inputs.budget?.session !== undefined &&
    inputs.budget.session !== null &&
    inputs.budget.session.limit > 0
  ) {
    const scope = inputs.budget.session
    setGauge('bah_cost_budget_remaining_micro_yuan', { scope: 'session' }, scope.limit - scope.used)
    bump('bah_cost_budget_exhausted_total', { scope: 'session' }, scope.exhausted)
  }

  for (const [metric, sample] of Object.entries(inputs.slo ?? {})) {
    const verdict = verdictOf(sample.value, sample.soft, sample.hard)
    setGauge('bah_slo_value', { metric, verdict }, sample.value === null ? Number.NaN : sample.value)
  }

  return METRIC_SPECS.map((spec) => ({ spec, samples: samplesOf(spec, counters, gauges, histograms) }))
}

function samplesOf(
  spec: MetricSpec,
  counters: Map<string, Map<string, number>>,
  gauges: Map<string, Map<string, number>>,
  histograms: Map<string, Map<string, number[]>>,
): MetricSample[] {
  if (spec.type === 'histogram') {
    const bucket = histograms.get(spec.name) ?? new Map<string, number[]>()
    return [...bucket.entries()].map(([key, values]) => ({
      labels: labelsOf(key),
      value: null,
      histogram: histogramOf(values, bucketFor(spec.name)),
    }))
  }
  const source = spec.type === 'counter' ? counters : gauges
  const bucket = source.get(spec.name) ?? new Map<string, number>()
  return [...bucket.entries()].map(([key, value]) => ({ labels: labelsOf(key), value }))
}

function bucketFor(name: string): readonly number[] {
  if (name === 'bah_tool_duration_seconds' || name === 'bah_llm_ttft_seconds') return TOOL_BUCKETS
  if (name === 'bah_approval_wait_seconds') return APPROVAL_BUCKETS
  return HTTP_BUCKETS
}

function labelsOf(key: string): Readonly<Record<string, string>> {
  if (key.length === 0) return {}
  const labels: Record<string, string> = {}
  for (const pair of key.split('\u0001')) {
    const index = pair.indexOf('=')
    if (index > 0) labels[pair.slice(0, index)] = pair.slice(index + 1)
  }
  return labels
}

function majorNode(version: string): string {
  const match = /^v(\d+)/.exec(version)
  return match === null ? 'v22' : `v${match[1] ?? '22'}`
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numberOf(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
