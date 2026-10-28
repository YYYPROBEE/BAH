/**
 * base bundle · `obs:telemetry`：遥测内核的宿主装配（可观测性 01 / S1.7）。
 *
 * 它做的只有四件事：**建记录器、按需派生、按需落盘、把句柄交出去**。
 * 三件事它**不做**，且每一件都有人提议过：
 *
 * | 不做 | 理由 |
 * |---|---|
 * | 不产生任何会话事件 | 事件表 v1.0.1 §5 已封口；写事件会逼 7 个场景快照全部重录 |
 * | 不写 `session.jsonl` | 那是事实链，span 是视图；混写等于"两真相" |
 * | 不做 `inject` 广播 | 消费方用 `tryService(ctx, TELEMETRY)` 惰性取；写进别人的 `inject` 会让没装本行的 profile 起不来 |
 *
 * 时钟可信度**由数据判定**而不是由配置项声明：同一会话全部事件 `at` 相同 ⇒ 说明跑的是
 * `fixedClock`（全仓无 `Clock.tick()`），此时派生时长为 0 是事实而不是"很快"。
 * 用一个配置开关去声明它，等于给"忘记配"留了一个静默撒谎的口子。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { defineService, type Context, type ServiceKey } from '@bah/core'
import { SESSION_SERVICE } from '@bah/runtime'
import {
  buildForest,
  createRecorder,
  createUsageLedger,
  deriveSpans,
  toJsonRow,
  type RecorderStats,
  type SpanName,
  type SpanNode,
  type SpanRecorder,
  type TelemetrySpan,
  type UsageLedger,
} from '@bah/telemetry'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { installAlertWebhook, isHttpUrl } from './alert-webhook.ts'
import { logJson } from './log.ts'
import { MODEL_PRICING } from './model.ts'
import { asRecord, bootError, readPositiveInteger, readString, rejectUnknownKeys } from '../config.ts'

/** 派生结果：扁平 span + 森林 + 时钟可信度（三者必须一起给，否则下游会各算一遍）。 */
export interface TelemetrySnapshot {
  readonly spans: readonly TelemetrySpan[]
  readonly roots: readonly SpanNode[]
  /** `false` = 该会话全部事件 `at` 相同，时长不可用（快照回放）。 */
  readonly clockTrusted: boolean
}

/** 预算闸三键（0 = 关；02 §3.5）。 */
export interface GuardSettings {
  readonly maxTurnCostMicroYuan: number
  readonly maxSessionCostMicroYuan: number
  readonly maxTurnOutputTokens: number
}

/** 告警出口配置（02 §3.8）。 */
export interface TelemetryAlertSettings {
  readonly webhook: string | null
}

/** 遥测句柄（`obs:telemetry` 服务键的载荷）。 */
export interface TelemetryHandle {
  readonly recorder: SpanRecorder
  /** 转发（调用点不必先判空 `recorder`）。 */
  withSpan<T>(name: SpanName, attributes: Readonly<Record<string, string | number | boolean>>, fn: (spanId: string) => T): T
  withSpanAsync<T>(name: SpanName, attributes: Readonly<Record<string, string | number | boolean>>, fn: (spanId: string) => Promise<T>): Promise<T>
  /** 从会话事件现算一遍（**不留历史**：按需派生，随时可重算）。 */
  derive(): TelemetrySnapshot
  readonly stats: RecorderStats
  /** 实际使用的 `span.jsonl` 路径（`null` = 只在内存）。启动日志里会打出来。 */
  readonly spanLogPath: string | null
  /** 用量账本（02 / S2.5）：增量缓存，`rebuild` 可与全量重算对齐。 */
  readonly usage: UsageLedger
  /** 计价是否已配置（`core:model.pricing`）。`false` ≠ "免费"：本地 provider 没有账单。 */
  costConfigured(): boolean
  /** 预算上限（全 0 = 关）。 */
  readonly guardLimits: GuardSettings
  /** 预算判停触发次数（按 scope）。 */
  budgetExhausted(): { readonly turn: number; readonly session: number }
}

/** `obs:telemetry` 的配置。 */
export interface TelemetrySettings {
  /** 环形缓冲容量（缺省 2000，范围 [100, 100000]）。 */
  readonly maxSpans: number
  /** 追加式 span 出口路径（缺省 `null` = 只留内存）。相对路径按 `run.jsonlDir` 解析。 */
  readonly spanLog: string | null
  /** 按 span 名覆盖采样率（缺省 `{}`，即用库里的 `DEFAULT_SAMPLE`）。 */
  readonly sample: Readonly<Record<string, number>>
  /** 预算闸（02 §3.5）。 */
  readonly guard: GuardSettings
  /** 告警出口（02 §3.8）。 */
  readonly alerts: TelemetryAlertSettings
}

/** 服务键：跨包只认这个。 */
export const TELEMETRY: ServiceKey<TelemetryHandle> = defineService<TelemetryHandle>('obs:telemetry')

const WHERE = 'obs:telemetry'

/** 缺省配置（与 01 §S1.7 / 02 §4.7 一致）。 */
const DEFAULTS: TelemetrySettings = {
  maxSpans: 2000,
  spanLog: null,
  sample: {},
  guard: { maxTurnCostMicroYuan: 0, maxSessionCostMicroYuan: 0, maxTurnOutputTokens: 0 },
  alerts: { webhook: null },
}

export const telemetryPlugin: HostPlugin<TelemetrySettings> = {
  id: 'obs:telemetry',

  plugin: {
    name: 'obs:telemetry',
    // 两个都要：`bah:run` 给钟与 `jsonlDir`，`runtime:session` 给 `events()`。
    // `core:session` 在 `HOST_PLUGINS` 里排第一，所以本行拿得到它。
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE)
      const spanLogPath = resolveSpanLog(config.spanLog, run.jsonlDir)

      if (spanLogPath !== null) {
        try {
          mkdirSync(dirname(spanLogPath), { recursive: true })
        } catch (error) {
          // fail-open：观测面写不出去不该让转账失败。
          logJson('warn', 'telemetry.span-log-unavailable', { reason: String(error) })
        }
      }

      const recorder = createRecorder({
        sessionId: run.sessionId,
        now: run.now,
        maxSpans: config.maxSpans,
        sample: config.sample,
        ...(spanLogPath === null
          ? {}
          : {
              sink: (span: TelemetrySpan): void => {
                // 追加式 JSONL：一行一条，稳定键序（`toJsonRow` 的键序是钉死的）。
                appendFileSync(spanLogPath, `${JSON.stringify(toJsonRow(span))}\n`)
              },
            }),
      })

      const derive = (): TelemetrySnapshot => {
        const events = session.events()
        const clockTrusted = isClockTrusted(events)
        const spans = deriveSpans(events, { sessionId: run.sessionId, clockTrusted })
        recorder.absorb(spans)
        return { spans, roots: buildForest(spans), clockTrusted }
      }

      // 用量账本：从事件增量累积；boot 时先用已有事件 rebuild（重启后预算不丢）。
      const usage = createUsageLedger()
      usage.rebuild(session.events())
      ctx.effect(ctx.events.on('session/event', ({ event }) => usage.observe(event)))

      let exhaustedTurn = 0
      let exhaustedSession = 0
      const guard = config.guard
      if (guard.maxTurnCostMicroYuan > 0 || guard.maxTurnOutputTokens > 0) {
        ctx.effect(
          ctx.events.on('agent/pre-step', (input, next) => {
            // `usage/summary` 在 turn 收尾才落账，所以"每轮第一步"看到的是**上一轮**的用量；
            // 想用当前 turn 的数字做闸，只能等 `turn-stopping`，那已经来不及阻止这一轮。
            const previous = usage.lastTurn()
            const turn = previous === undefined ? undefined : usage.ofTurn(previous)
            if (
              turn !== undefined &&
              guard.maxTurnCostMicroYuan > 0 &&
              turn.costMicroYuan > guard.maxTurnCostMicroYuan
            ) {
              exhaustedTurn += 1
              return {
                ...input,
                verdict: {
                  kind: 'reject',
                  code: 'usage-budget-exhausted',
                  reason: `上一轮成本已用尽：${String(turn.costMicroYuan)}/${String(guard.maxTurnCostMicroYuan)} µ元`,
                },
              }
            }
            if (
              turn !== undefined &&
              guard.maxTurnOutputTokens > 0 &&
              turn.output > guard.maxTurnOutputTokens
            ) {
              exhaustedTurn += 1
              return {
                ...input,
                verdict: {
                  kind: 'reject',
                  code: 'usage-budget-exhausted',
                  reason: `上一轮输出 token 已用尽：${String(turn.output)}/${String(guard.maxTurnOutputTokens)}`,
                },
              }
            }
            return next(input)
          }),
        )
      }
      if (guard.maxSessionCostMicroYuan > 0) {
        ctx.effect(
          ctx.events.on('agent/turn-stopping', (input) => {
            const total = usage.total()
            if (total.costMicroYuan > guard.maxSessionCostMicroYuan) {
              exhaustedSession += 1
              input.stop(
                `会话预算已用尽：${String(total.costMicroYuan)}/${String(guard.maxSessionCostMicroYuan)} µ元`,
              )
            }
          }),
        )
      }

      // 告警 webhook：没配就完全不注册（不留空转）。
      if (config.alerts.webhook !== null) {
        ctx.effect(installAlertWebhook(config.alerts.webhook))
      }

      const costConfigured = (): boolean => {
        try {
          return ctx.get(MODEL_PRICING).configured
        } catch {
          return false
        }
      }

      const handle: TelemetryHandle = {
        recorder,
        withSpan: (name, attributes, fn) => recorder.withSpan(name, attributes, fn),
        withSpanAsync: (name, attributes, fn) => recorder.withSpanAsync(name, attributes, fn),
        derive,
        get stats() {
          return recorder.stats
        },
        spanLogPath,
        usage,
        costConfigured,
        guardLimits: guard,
        budgetExhausted: () => ({ turn: exhaustedTurn, session: exhaustedSession }),
      }

      ctx.provide(TELEMETRY, handle)
      if (spanLogPath !== null) {
        logJson('info', 'telemetry.span-log-enabled', { path: spanLogPath })
      }
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['maxSpans', 'spanLog', 'sample', 'guard', 'alerts'], WHERE)
    // 环境变量优先于 bundle config（S1.10）：部署现场临时开一轮落盘/调容量时，
    // 不必改 `packages/cli/bundles/base/index.ts` 再重打包。非法值忽略并留一条 warn，
    // **不阻断启动**——这类开关配错不该让演示起不来。
    const maxSpans = envMaxSpans() ?? readPositiveInteger(config, 'maxSpans', WHERE) ?? DEFAULTS.maxSpans
    if (maxSpans < 100 || maxSpans > 100_000) {
      throw bootError(
        'telemetry-config-invalid',
        `${WHERE}: maxSpans 必须在 [100, 100000]（收到 ${String(maxSpans)}）`,
      )
    }
    const spanLog = envSpanLog() ?? readString(config, 'spanLog', WHERE) ?? DEFAULTS.spanLog
    return {
      maxSpans,
      spanLog,
      sample: readSample(config['sample']),
      guard: readGuard(config['guard']),
      alerts: readAlerts(config['alerts']),
    }
  },
}

/**
 * 时钟是否可信：同一会话里出现过**不止一个** `at` 就认为可信。
 *
 * 判据来自代码现状而不是约定：`fixedClock.now()` 幂等、全仓无 `Clock.tick()`，
 * 所以快照场景里所有事件 `at` 完全相同。反过来，"真钟"下哪怕只有两条事件，
 * 时间也几乎不可能撞在同一毫秒——真撞了，代价只是把时长显示成 0（保守方向）。
 */
function isClockTrusted(events: readonly { readonly at: number }[]): boolean {
  const first = events[0]?.at
  return events.some((event) => event.at !== first)
}

/** 相对路径按 `run.jsonlDir` 解析；未传 `--jsonl` 时按 `process.cwd()`（并留一条 warn）。 */
function resolveSpanLog(spanLog: string | null, jsonlDir: string | undefined): string | null {
  if (spanLog === null || spanLog.trim() === '') return null
  if (isAbsolute(spanLog)) return spanLog
  const base = jsonlDir ?? process.cwd()
  const resolved = resolve(base, spanLog)
  logJson('warn', 'telemetry.span-log-relative', { resolved, base })
  return resolved
}

/** `BAH_TELEMETRY_MAX_SPANS`：正整数覆盖 config；非法值忽略并留 warn，不阻断启动。 */
function envMaxSpans(): number | undefined {
  const raw = process.env['BAH_TELEMETRY_MAX_SPANS']
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value <= 0) {
    logJson('warn', 'telemetry.env-invalid', { key: 'BAH_TELEMETRY_MAX_SPANS', value: raw })
    return undefined
  }
  return value
}

/** `BAH_SPAN_LOG`：非空即覆盖 config；相对路径的解析与 config 同口径（见 `resolveSpanLog`）。 */
function envSpanLog(): string | undefined {
  const raw = process.env['BAH_SPAN_LOG']
  if (raw === undefined || raw.trim() === '') return undefined
  return raw.trim()
}

/** 读一个非负整数配置（0 合法；负数/小数/非数 fail-loud）。 */
function readNonNegative(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): number {
  const value = record[key]
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw bootError('telemetry-config-invalid', `${where}.${key} 必须是非负整数`)
  }
  return value
}

/** `guard` 三键（02 §3.5；全 0 = 关）。 */
function readGuard(value: unknown): GuardSettings {
  if (value === undefined) return DEFAULTS.guard
  const record = asRecord(value, `${WHERE}.guard`)
  rejectUnknownKeys(
    record,
    ['maxTurnCostMicroYuan', 'maxSessionCostMicroYuan', 'maxTurnOutputTokens'],
    `${WHERE}.guard`,
  )
  return {
    maxTurnCostMicroYuan: readNonNegative(record, 'maxTurnCostMicroYuan', `${WHERE}.guard`),
    maxSessionCostMicroYuan: readNonNegative(record, 'maxSessionCostMicroYuan', `${WHERE}.guard`),
    maxTurnOutputTokens: readNonNegative(record, 'maxTurnOutputTokens', `${WHERE}.guard`),
  }
}

/** `alerts.webhook`：env 优先；非 http(s) 直接启动失败（02 §3.8）。 */
function readAlerts(value: unknown): TelemetryAlertSettings {
  let webhook: string | null = DEFAULTS.alerts.webhook
  if (value !== undefined) {
    const record = asRecord(value, `${WHERE}.alerts`)
    rejectUnknownKeys(record, ['webhook'], `${WHERE}.alerts`)
    webhook = readString(record, 'webhook', `${WHERE}.alerts`) ?? null
  }
  const fromEnv = process.env['BAH_ALERT_WEBHOOK']?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) webhook = fromEnv
  if (webhook !== null && !isHttpUrl(webhook)) {
    throw bootError(
      'telemetry-config-invalid',
      `${WHERE}.alerts.webhook 必须是 http(s) URL（收到 ${webhook}）`,
    )
  }
  return { webhook }
}

/** `sample` 必须是 `{ <span 名>: 0..1 }`；不在闭集里的名字不会生效，但也不抛（前向兼容）。 */
function readSample(value: unknown): Readonly<Record<string, number>> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bootError('telemetry-sample-invalid', `${WHERE}: sample 必须是对象：{ "<span 名>": 0..1 }`)
  }
  const result: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      throw bootError(
        'telemetry-sample-invalid',
        `${WHERE}: sample.${key} 必须是 [0,1] 内的数（收到 ${String(raw)}）`,
      )
    }
    result[key] = raw
  }
  return result
}

/** 供 `web/deps.ts` 等消费方惰性取（`ctx.get` 抛错时返回 `undefined`）。 */
export function tryTelemetry(ctx: Context): TelemetryHandle | undefined {
  try {
    return ctx.get(TELEMETRY)
  } catch {
    return undefined
  }
}
