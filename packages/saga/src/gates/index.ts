/**
 * 闸门与审批 CAS（SA-10 §3.3 / §3.4 / §3.5，批 4 执行面）。
 *
 * 本文件只承载四件事，全部经 `ctx.events.on` / `ctx.get` 工作，**不注册任何服务键、事件键**：
 * 1. `submitDecision`：审批回执带 saga `version` CAS（状态已推进即 `stale`，只审计）；
 * 2. `assertManualOnlyTail`：`IRREVERSIBLE` 执行后的补偿绑定必须是 `MANUAL_ONLY`（M2 终段，只读）；
 * 3. `provideParamGates`：`tools/pre-execute` 的 schema → rule → risk 三道闸（顺序不可重排）；
 * 4. `provideTraceparentInjection`：`tools/execute` 环绕注入 W3C `traceparent`（载体不污染模型可见参数）。
 *
 * 另有 DLQ 分级告警调度（深度阈值取自 Config）与工具面读写分离守卫（补偿端点永不注册进 `ToolRegistry`）。
 *
 * 纪律：
 * - 审计 `append` 的事件名必须是 SA-00 §4.4 表内键（`verify-saga-events` 门禁），本文件只用
 *   `approval/decided`（复用键，审批回执）与 `saga/comp-decided`（终段治理判决）；
 * - 闸门判决是**纯函数**：零 I/O、零随机、零 LLM，便于单测与回归；
 * - `@bah/runtime` 仅以 `import type` 引入（devDependency，编译期类型面）。
 */

import { BahError } from '@bah/util'

import { commitSegment } from '../coordinator/commit.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STEP_CONTEXT, SAGA_STORE } from '../seams.ts'

import type { Context, Disposer } from '@bah/core'
import type { ApprovalDecision, PreExecuteInput, ToolCallInput } from '@bah/runtime'

import type { SagaSettings, SagaStep } from '../types.ts'

/* ────────────────────────────── 审批回执 CAS（§3.3） ────────────────────────────── */

/** 审批提交结论：`applied` = 生效；`stale` = 状态已推进，仅审计。 */
export type DecisionOutcome = 'applied' | 'stale'

/** `stale` 的细分原因（审计明细用；对外理由码统一 `version-conflict`）。 */
export type StaleDetail = 'ticket-missing' | 'version-mismatch' | 'state-not-gate-holding'

/**
 * 审批提交：带 saga `version` CAS；CAS 败返回 `'stale'` 且**只审计、不生效**（M2 / A10）。
 *
 * 三失败分支（票据不存在 / `version` 不匹配 / 状态已不是 `GATE_HOLDING`）一律不抛错：
 * 竞态的另一方已经生效，重复提交是正常业务事件。审计理由码统一记 `version-conflict`，
 * 细分原因落 `detail`（供 SA-11 证据链排查，不参与判决）。
 *
 * @param sagaVersion 提交方读取到的 saga 版本（不是当前版本）
 */
export function submitDecision(
  ctx: Context,
  ticketId: string,
  decision: ApprovalDecision,
  approver: string,
  sagaVersion: number,
): DecisionOutcome {
  const now = ctx.get(SAGA_CLOCK).now()
  const applied = commitSegment(ctx, (tx) => {
    const saga = tx.loadTransactionByTicket(ticketId)
    if (saga === undefined) {
      // 无 saga 可归属：落 per-ticket 审计链（ChainFile 要求合法 sagaId，空串会 fail-loud）。
      appendDecisionAudit(
        ctx,
        ticketAuditChain(ticketId),
        ticketId,
        decision,
        approver,
        sagaVersion,
        'stale',
        'ticket-missing',
      )
      return false
    }
    if (saga.version !== sagaVersion) {
      appendDecisionAudit(
        ctx,
        saga.sagaId,
        ticketId,
        decision,
        approver,
        sagaVersion,
        'stale',
        'version-mismatch',
      )
      return false
    }
    if (!tx.casState(saga.sagaId, 'GATE_HOLDING', 'RUNNING', sagaVersion, now)) {
      appendDecisionAudit(
        ctx,
        saga.sagaId,
        ticketId,
        decision,
        approver,
        sagaVersion,
        'stale',
        'state-not-gate-holding',
      )
      return false
    }
    // 只有 CAS 成功才落回执（票据状态机属主仍在 bank-core；这里只落 saga 侧证据）。
    tx.recordTicketDecision(ticketId, decision, approver, now)
    appendDecisionAudit(ctx, saga.sagaId, ticketId, decision, approver, sagaVersion, 'applied')
    return true
  })
  return applied ? 'applied' : 'stale'
}

/** 未知票据的审计归属：独立 per-ticket 链，不伪造 saga 记录。 */
function ticketAuditChain(ticketId: string): string {
  return `ticket:${ticketId.replace(/[^A-Za-z0-9._:-]/g, '_')}`
}

/** 审批回执审计（与状态 CAS 同提交段；`applied` / `stale` 都落）。 */
function appendDecisionAudit(
  ctx: Context,
  sagaId: string,
  ticketId: string,
  decision: ApprovalDecision,
  approver: string,
  sagaVersion: number,
  outcome: DecisionOutcome,
  detail?: StaleDetail,
): void {
  ctx.get(SAGA_AUDIT).append(sagaId, 'approval/decided', {
    ticketId,
    decision,
    approver,
    sagaVersion,
    outcome,
    ...(outcome === 'stale' ? { reason: 'version-conflict', detail } : {}),
  })
}

/* ────────────────────────── MANUAL_ONLY 终段保护（§3.3 / M2） ────────────────────────── */

/**
 * `IRREVERSIBLE` 终段复核：已执行 `IRREVERSIBLE` 步骤**之后**的补偿绑定必须是 `MANUAL_ONLY`。
 *
 * 计划期由 `bindAtPlan` 拦截；本函数是运行期复核（防手工写入 / 迁移遗留）。**只读**：
 * 不写任何表，违规时先审计再抛 `no-template`。
 *
 * "之后" 的判定口径：`saga_step.seq_no` 严格大于最早一条已执行 `IRREVERSIBLE` 步骤的 `seq_no`
 * ——`seq_no` 是计划期冻结的线性序，`topology_deps` 只表达依赖、不表达"终段"（DDL 无新列）。
 *
 * @throws `BahError('no-template')` 存在非 `MANUAL_ONLY` 的越界绑定
 */
export function assertManualOnlyTail(ctx: Context, sagaId: string): void {
  const store = ctx.get(SAGA_STORE)
  const { cutoff, violation } = store.tx((tx) => {
    const steps = tx.listSteps(sagaId)
    const executedIrreversible = steps.filter(
      (step) => step.sideEffectClass === 'IRREVERSIBLE' && step.state === 'EXECUTED',
    )
    if (executedIrreversible.length === 0) {
      return { cutoff: undefined, violation: undefined }
    }
    const boundary = Math.min(...executedIrreversible.map((step) => step.seqNo))
    const byStep = new Map<string, SagaStep>(steps.map((step) => [step.stepId, step]))
    const bad = tx.listCompensations(sagaId).find((comp) => {
      const step = byStep.get(comp.stepId)
      return step !== undefined && step.seqNo > boundary && comp.compKind !== 'MANUAL_ONLY'
    })
    return { cutoff: boundary, violation: bad }
  })
  if (cutoff === undefined || violation === undefined) return

  ctx.get(SAGA_AUDIT).append(sagaId, 'saga/comp-decided', {
    sagaId,
    stepId: violation.stepId,
    decide: 'manual',
    reason: 'manual-only-tail-violation',
    compKind: violation.compKind,
    irreversibleSeq: cutoff,
  })
  throw new BahError(
    'no-template',
    `bah-saga: no-template: IRREVERSIBLE 之后只允许 MANUAL_ONLY 补偿（${violation.stepId} = ${violation.compKind}）`,
    {
      sagaId,
      stepId: violation.stepId,
      compKind: violation.compKind,
      irreversibleSeq: cutoff,
    },
  )
}

/* ────────────────────────── 三道闸（§3.4 / tools/pre-execute） ────────────────────────── */

/** 闸名（判决顺序：`schema` → `rule` → `risk`，不可重排）。 */
export type ParamGateName = 'schema' | 'rule' | 'risk'

/** 单闸判决（`pass=false` 时 `code`/`reason` 由闸函数给出）。 */
export interface ParamGateVerdict {
  readonly pass: boolean
  readonly reason?: string
  readonly code?: string
}

/** 单闸：纯函数，只读调用形状。 */
export type ParamGate = (call: ToolCallInput) => ParamGateVerdict

const PASS: ParamGateVerdict = { pass: true }

/** 规则闸拒绝清单：这些都是**服务面控制位**，模型不得自报（M1 读写分离）。 */
export const RULE_DENIED_ARG_KEYS: readonly string[] = [
  'approvalDecision',
  'skipApproval',
  'bypassRisk',
  'forceCompensate',
]

/** 规则闸必填参数：带金额语义的工具必须给出对应参数（空串 / `null` 视为缺失）。 */
export const RULE_REQUIRED_ARGS: Readonly<Record<string, readonly string[]>> = {
  'pay.charge': ['amount'],
  'pay.refund': ['amount'],
  'pay.transfer': ['amount', 'currency'],
}

/** 风控闸硬阈值（金额，单位与工具体一致）；超阈值**直接拒绝**，不转审批。 */
export const RISK_AMOUNT_THRESHOLD = 200_000

/** 风控闸拒绝理由码。 */
export const RISK_THRESHOLD_CODE = 'risk-amount-threshold'

/** 闸门顺序表（导出让单测钉住"顺序不可重排"）。 */
export const PARAM_GATES: readonly { readonly gate: ParamGateName; readonly run: ParamGate }[] = [
  { gate: 'schema', run: checkSchema },
  { gate: 'rule', run: checkBusinessRule },
  { gate: 'risk', run: checkRisk },
]

/** 闸一：入参形状（工具名非空 + `args` 是普通对象）。 */
export function checkSchema(call: ToolCallInput): ParamGateVerdict {
  if (typeof call.name !== 'string' || call.name.trim().length === 0) {
    return { pass: false, code: 'schema-tool-name', reason: '工具名不能为空（模型按名字寻址）' }
  }
  if (!isPlainObject(call.args)) {
    return { pass: false, code: 'schema-args-not-object', reason: '工具参数必须是普通对象' }
  }
  return PASS
}

/** 闸二：业务规则（拒绝清单 + 必填参数）。 */
export function checkBusinessRule(call: ToolCallInput): ParamGateVerdict {
  const denied = Object.keys(call.args).find((key) => RULE_DENIED_ARG_KEYS.includes(key))
  if (denied !== undefined) {
    return {
      pass: false,
      code: 'rule-denied-arg',
      reason: `参数 ${denied} 是服务面控制位，模型不得自报`,
    }
  }
  const required = RULE_REQUIRED_ARGS[call.name] ?? []
  const missing = required.find((key) => isBlank(call.args[key]))
  if (missing !== undefined) {
    return { pass: false, code: 'rule-missing-arg', reason: `缺少必填参数 ${missing}` }
  }
  return PASS
}

/** 闸三：风控钩子（阈值式策略；超阈值即拒，不转审批）。 */
export function checkRisk(call: ToolCallInput): ParamGateVerdict {
  const amount = call.args['amount']
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > RISK_AMOUNT_THRESHOLD) {
    return {
      pass: false,
      code: RISK_THRESHOLD_CODE,
      reason: `金额 ${amount} 超过硬阈值 ${RISK_AMOUNT_THRESHOLD}`,
    }
  }
  return PASS
}

/**
 * 装配三道闸：`saga/param-validated` 是本挂点的唯一记账事件（emit）。
 *
 * - 任一闸拒绝 → 若作用域绑定了 saga，emit `{verdict:'reject', gate, code}`，并**短路**返回
 *   `{...input, verdict:{kind:'deny', reason, code}}`（不调 `next`，本挂点拥有该判决）；
 * - 全部通过 → 绑定 saga 时 emit `{verdict:'pass', gate:'risk'}`，然后**必须** `return next(input)`；
 * - 无 saga 绑定（工具不属于任何 saga）→ 跳过事件，仍 `return next(input)`。
 */
export function provideParamGates(ctx: Context): Disposer {
  return ctx.events.on('tools/pre-execute', (input, next) => {
    const bind = ctx.scope.get(SAGA_STEP_CONTEXT)
    for (const { gate, run } of PARAM_GATES) {
      const verdict = run(input.call)
      if (verdict.pass) continue
      const code = verdict.code ?? `param-${gate}`
      const reason = verdict.reason ?? `参数闸 ${gate} 拒绝`
      if (bind !== undefined) {
        ctx.events.emit('saga/param-validated', {
          sagaId: bind.sagaId,
          stepId: bind.stepId,
          verdict: 'reject',
          gate,
          code,
        })
      }
      const denied: PreExecuteInput = { ...input, verdict: { kind: 'deny', reason, code } }
      return denied
    }
    if (bind !== undefined) {
      ctx.events.emit('saga/param-validated', {
        sagaId: bind.sagaId,
        stepId: bind.stepId,
        verdict: 'pass',
        gate: 'risk',
      })
    }
    return next(input)
  })
}

/* ────────────────────── 出站 traceparent 注入（§3.4 / tools/execute） ────────────────────── */

/** 携带出站追踪头的调用形状：`traceparent` 是**非枚举**属性，不进模型可见参数。 */
export type TracedToolCall = ToolCallInput & { readonly traceparent: string }

/**
 * W3C 标识与 `traceparent` 的**唯一实现**在 `@bah/telemetry`（可观测性 01 / S1.9）。
 *
 * 为什么搬走而不是留两份：出站 `traceparent` 与派生 span 的 trace-id 必须能对上，
 * 两套实现迟早会在"归一规则"（`toW3cTraceId` 的零值兜底）上分叉，而分叉的表现是
 * "连上了但图断了"——那种问题在演示现场几乎查不出来。
 *
 * **算法逐字保留**：`spanIdOf(callId) = sha256(callId)[0..16]`，**没有** `bah/span/` 前缀。
 * `gates.test.ts` 里有硬编码期望值，改算法等于改已发出的协议。
 *
 * `withTraceparent` / `traceparentOf` 也一并迁走，但用了结构泛型（`T extends object`）——
 * 因为 `@bah/telemetry` **不依赖 `@bah/core`**（宪法 R-2）。行为完全不变：
 * 浅拷贝 + 非枚举 + 不可写/不可配置。
 */
import {
  buildTraceparent,
  spanIdOf,
  toW3cTraceId,
  traceparentOf,
  withTraceparent,
} from '@bah/telemetry'

export { buildTraceparent, spanIdOf, toW3cTraceId, traceparentOf, withTraceparent }


/**
 * 环绕 `tools/execute`：派发前把 saga `traceId` 绑成 `traceparent`。
 *
 * saga 归属取自作用域键 `SAGA_STEP_CONTEXT`（工具面本身不认识 saga）：
 * 未绑定 / saga 行缺失 → **原样透传**（追踪是旁路，永不阻断业务调用）。
 */
export function provideTraceparentInjection(ctx: Context): Disposer {
  return ctx.events.on('tools/execute', (run, next) =>
    next(async (call: ToolCallInput) => {
      const traceparent = traceparentForCall(ctx, call)
      return run(traceparent === undefined ? call : withTraceparent(call, traceparent))
    }),
  )
}

/** 由作用域绑定 + saga 行解析出站 traceparent；任一缺失即 `undefined`。 */
function traceparentForCall(ctx: Context, call: ToolCallInput): string | undefined {
  const bind = ctx.scope.get(SAGA_STEP_CONTEXT)
  if (bind === undefined) return undefined
  const saga = ctx.get(SAGA_STORE).loadTransaction(bind.sagaId)
  if (saga === undefined) return undefined
  return buildTraceparent(saga.traceId, spanIdOf(call.callId))
}

/* ────────────────────────────── DLQ 分级告警（§3.5） ────────────────────────────── */

/** 告警级别判决（阈值取 Config；`alert < phone` 由载入期校验保证）。 */
export interface DlqDepthVerdict {
  readonly alert: boolean
  readonly phone: boolean
}

/** 告警信号：深度 + 级别 + 归因（进程内告警总线 SA-13 的输入面）。 */
export interface DlqDepthSignal extends DlqDepthVerdict {
  readonly depth: number
  readonly sagaId: string
  readonly dlqId: string
}

/** 告警出口（生产实现挂 SA-13 的进程内总线；测试注入 fake sink）。 */
export interface DlqAlertSink {
  /** 深度告警（同时是入口熔断的启用信号，阈值复用 `dlqAlertDepth`）。 */
  alert(message: string, signal: DlqDepthSignal): void
  /** 电话升级。 */
  phone(message: string, signal: DlqDepthSignal): void
}

/**
 * 阈值判决（纯函数）：`depth ≥ dlqAlertDepth` 告警，`depth ≥ dlqPhoneDepth` 电话升级。
 */
export function dlqDepthVerdict(
  depth: number,
  thresholds: Pick<SagaSettings, 'dlqAlertDepth' | 'dlqPhoneDepth'>,
): DlqDepthVerdict {
  return {
    alert: depth >= thresholds.dlqAlertDepth,
    phone: depth >= thresholds.dlqPhoneDepth,
  }
}

/**
 * 装配 DLQ 分级告警：监听 `saga/dlq-escalated`，按**当前**未处置深度分级出口。
 *
 * 深度在事件派发后读取（`escalateToDlq` 先提交段再 emit），因此看到的是已落账深度。
 *
 * @returns disposer（dispose 后不再有任何告警出口被调用）
 */
export function installDlqAlerts(
  ctx: Context,
  settings: SagaSettings,
  sink: DlqAlertSink,
): Disposer {
  return ctx.events.on('saga/dlq-escalated', (payload) => {
    const depth = ctx.get(SAGA_STORE).tx((tx) => tx.dlqDepth())
    const verdict = dlqDepthVerdict(depth, settings)
    if (!verdict.alert && !verdict.phone) return
    const signal: DlqDepthSignal = {
      depth,
      ...verdict,
      sagaId: payload.sagaId,
      dlqId: payload.dlqId,
    }
    if (signal.alert) {
      sink.alert(`DLQ 深度 ${depth} ≥ ${settings.dlqAlertDepth}（启用入口熔断）`, signal)
    }
    if (signal.phone) {
      sink.phone(`DLQ 深度 ${depth} ≥ ${settings.dlqPhoneDepth}`, signal)
    }
  })
}

/* ────────────────────── 工具面读写分离（§3.4 / M1） ────────────────────── */

/** 服务面端点前缀：模型可见工具面（`ToolRegistry`）里不应出现该前缀。 */
export const SERVICE_PLANE_ENDPOINT_PREFIX = 'saga.'

/**
 * 补偿端点的**服务面**名字（只经 ServiceKey + 内部 handler 暴露）。
 *
 * 该名字**永不**交给 `registry.register`——模型按名字寻址时只会得到 `tool-missing`。
 */
export function compensationEndpointName(toolName: string): string {
  return `${SERVICE_PLANE_ENDPOINT_PREFIX}compensate.${toolName}`
}

/** 工具面最小查询面（`ToolRegistry` 满足；不 import 实现类，避免运行期依赖）。 */
export interface ToolNameLookup {
  has(name: string): boolean
}

/**
 * 断言端点不在模型可见工具面。
 *
 * @throws `BahError('tool-missing')` 该端点已被注册进工具面（越界即 fail-loud）
 */
export function assertNotModelVisible(registry: ToolNameLookup, name: string): void {
  if (registry.has(name)) {
    throw new BahError(
      'tool-missing',
      `bah-saga: tool-missing: ${name} 属服务面端点，不得注册进模型可见工具面`,
      { tool: name },
    )
  }
}

/* ────────────────────────────── 装配（disposer 可组合） ────────────────────────────── */

/**
 * 装配闸门平面：三道闸 + 出站 traceparent。
 *
 * 不注册 `ToolRegistry`（补偿 / 审批 / 重放端点一律服务面）；返回复合 disposer，
 * 幂等、逆序撤销（主线程接线只需持有这一个句柄）。
 */
export function installGates(ctx: Context): Disposer {
  const disposers: Disposer[] = [provideParamGates(ctx), provideTraceparentInjection(ctx)]
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
  }
}

/* ────────────────────────────── 内部工具 ────────────────────────────── */

function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true
  return typeof value === 'string' && value.trim().length === 0
}
