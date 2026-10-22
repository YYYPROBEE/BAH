/**
 * 反向屏障补偿调度（SA-10 §3.2 / §3.5，批 4 执行面）。
 *
 * - 逆拓扑分层：`reverseLayers` 按「到无后继步骤（下游汇点）的最长距离」分层，
 *   汇点层（layers[0]）先补偿、上游层后补偿；层内无相互依赖，层间屏障。
 * - 唯一发射口：`issueComp`。自动路径（`runCompensation`）与手动路径调用**同一个**
 *   函数，`barrierCheck` 在发射前拦截乱序（`barrier-violation`），不存在旁路。
 * - 退避：`compBackoffDelay` 由 `compBackoff` + `attempts` + `@bah/util` 的 seeded
 *   伪随机生成（禁 `Math.random()`），同种子逐位可复现。
 * - 重试硬停：`attempts ≥ maxAttempts` 直接 DLQ，不受任何配置/判决影响（A23）。
 * - 未登记目标 / 无探诊端点：直接 DLQ（`unknown-target`），禁止自动补偿。
 * - 补偿调用与正向调用**对称**走 `settleCall`（R3.8），不另写一套收敛/探诊。
 */

import { BahError, canonicalJson, seededRandom, sha256Hex } from '@bah/util'

import { commitSegment } from '../coordinator/commit.ts'
import { mapPool } from '../coordinator/index.ts'
import { escalateToDlq, settleCall } from '../probe/settle.ts'
import { SAGA_FINAL_SUBJECT_PREFIX } from '../state-machine/reduce.ts'
import {
  SAGA_AUDIT,
  SAGA_CLOCK,
  SAGA_IDEMPOTENCY,
  SAGA_STORE,
  SAGA_TEMPLATES,
  TARGET_REGISTRY,
} from '../seams.ts'
import { projectPayload } from '../templates/index.ts'

import type { Context } from '@bah/core'

import type { ProbeTransport, StepRef } from '../probe/index.ts'
import type { CallOutcome } from '../probe/settle.ts'
import type {
  CompBackoffSettings,
  CompKind,
  CompState,
  CompTemplate,
  CompensatingAction,
  SagaSettings,
  SagaStep,
  StateSnapshot,
} from '../types.ts'

/* ────────────────────────────── 分层 / 下游 / 屏障 ────────────────────────────── */

/**
 * 已完成步骤按逆拓扑分层：下游先补偿（层内并行、层间屏障）。
 *
 * 层号 = 该步骤到「无后继步骤」的最长距离：汇点层为 0，越靠上游层号越大。
 * 返回顺序为补偿发射顺序（层号升序），同层按 `seqNo` 升序保证确定性。
 * 只纳入 `EXECUTED` / `COMP_ISSUED` 的步骤。
 */
export function reverseLayers(steps: readonly SagaStep[]): readonly (readonly SagaStep[])[] {
  const known = new Set(steps.map((step) => step.stepId))
  const dependents = new Map<string, string[]>()
  for (const step of steps) {
    for (const dep of step.topologyDeps) {
      const list = dependents.get(dep)
      if (list === undefined) dependents.set(dep, [step.stepId])
      else list.push(step.stepId)
    }
  }

  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const distanceToSink = (stepId: string): number => {
    const cached = depth.get(stepId)
    if (cached !== undefined) return cached
    // 计划期保证拓扑无环；此处防御性截断，避免脏数据把调度拖进死循环。
    if (visiting.has(stepId)) return 0
    visiting.add(stepId)
    let longest = 0
    for (const downstream of dependents.get(stepId) ?? []) {
      if (!known.has(downstream)) continue
      longest = Math.max(longest, distanceToSink(downstream) + 1)
    }
    visiting.delete(stepId)
    depth.set(stepId, longest)
    return longest
  }

  const byLayer = new Map<number, SagaStep[]>()
  for (const step of steps) {
    if (step.state !== 'EXECUTED' && step.state !== 'COMP_ISSUED') continue
    const layer = distanceToSink(step.stepId)
    const bucket = byLayer.get(layer)
    if (bucket === undefined) byLayer.set(layer, [step])
    else bucket.push(step)
  }

  return [...byLayer.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, bucket]) => bucket.slice().sort((left, right) => left.seqNo - right.seqNo))
}

/**
 * 由 `topology_deps` 的传递闭包取该步骤的全部下游 stepId（下游集合源自拓扑，而非补偿表新列）。
 *
 * 注意方向：`topologyDeps` 记录的是**上游前置**，因此下游集合要走反向边
 * （step → 依赖它的步骤）。
 */
export function downstreamOf(steps: readonly SagaStep[], stepId: string): readonly string[] {
  const dependents = new Map<string, readonly string[]>()
  for (const step of steps) {
    for (const dep of step.topologyDeps) {
      const list = dependents.get(dep)
      dependents.set(dep, list === undefined ? [step.stepId] : [...list, step.stepId])
    }
  }
  const seen = new Set<string>()
  const stack = [...(dependents.get(stepId) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    stack.push(...(dependents.get(id) ?? []))
  }
  return [...seen]
}

/** 已收敛的补偿状态（`NO_OP` 形态在发射时直接记为 `OK`，不引入新状态）。 */
function isConverged(state: CompState): boolean {
  return state === 'OK'
}

/**
 * 发射前屏障检查：上游 comp 早于下游收敛即拒绝发射（乱序结构性拦截）。
 *
 * 自动路径与手动路径共用本函数；下游集合 = `topology_deps` 的传递闭包，
 * 不引入新列。拒绝时先落审计再抛 `BahError('barrier-violation')`。
 */
export function barrierCheck(ctx: Context, sagaId: string, stepId: string): void {
  const store = ctx.get(SAGA_STORE)
  const pending = store.tx((tx) => {
    const steps = tx.listSteps(sagaId)
    const downstream = new Set(downstreamOf(steps, stepId))
    return tx
      .listCompensations(sagaId)
      .filter((comp) => downstream.has(comp.stepId) && !isConverged(comp.state))
      .map((comp) => comp.compId)
  })

  if (pending.length === 0) return

  ctx.get(SAGA_AUDIT).append(sagaId, 'saga/comp-result', {
    sagaId,
    compId: compIdOf(sagaId, stepId),
    outcome: 'unknown',
    reason: 'barrier-violation',
    pending,
  })
  throw new BahError('barrier-violation', 'bah-saga: barrier-violation: 上游补偿早于下游收敛', {
    sagaId,
    stepId,
    pending,
  })
}

/* ────────────────────────────── 退避 ────────────────────────────── */

/**
 * 确定性补偿退避延迟：`min(maxMs, baseMs × 2^(attempts-1) + jitter × baseMs × r)`。
 *
 * `r` 取自 `@bah/util` 的 `seededRandom`（禁 `Math.random()`），按 `(seed, attempts)`
 * 派生：同种子逐位一致，不同种子只改变抖动分量。`attempts ≤ 0` 返回 0。
 * 抖动为**加性**（上界 `jitter × baseMs`），因此序列单调不减并在 `maxMs` 处封顶。
 */
export function compBackoffDelay(
  backoff: CompBackoffSettings,
  attempts: number,
  seed = 0,
): number {
  const attempt = Math.floor(attempts)
  if (!Number.isFinite(attempt) || attempt <= 0) return 0

  const baseMs = Math.max(0, backoff.baseMs)
  const maxMs = Math.max(0, backoff.maxMs)
  if (maxMs === 0) return 0

  const jitter = Math.min(1, Math.max(0, backoff.jitter))
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1))
  const spread = jitter * baseMs * seededRandom(mixSeed(seed, attempt))()
  return Math.min(maxMs, Math.round(exponential + spread))
}

/** 把 `(seed, attempt)` 混成 32 位种子；纯整数运算，跨平台一致。 */
function mixSeed(seed: number, attempt: number): number {
  const base = Number.isFinite(seed) ? Math.trunc(seed) : 0
  return (base + Math.imul(attempt, 0x9e3779b1)) >>> 0
}

/* ────────────────────────────── 发射口 ────────────────────────────── */

/** 补偿调用入参（`invoke` 的唯一入参形状）。 */
export interface CompensationInvocation {
  readonly sagaId: string
  readonly stepId: string
  readonly compId: string
  readonly toolName: string
  /** 模板冻结的补偿端点。 */
  readonly endpoint: string
  readonly compKind: CompKind
  readonly compKey: string
  readonly template: CompTemplate
  readonly payload: Readonly<Record<string, unknown>>
}

/** 补偿调用与探诊通道（测试注入；省略即 fail-loud）。 */
export interface CompensationDeps {
  invoke(input: CompensationInvocation, signal: AbortSignal): Promise<CallOutcome>
  readonly probe: ProbeTransport
}

/** 运行时未注入通道：直接抛错，绝不静默跳过补偿。 */
const MISSING_TRANSPORT: CompensationDeps = {
  invoke: async () => {
    throw new BahError(
      'comp-transport-missing',
      'bah-saga: comp-transport-missing: 未注入补偿调用通道（CompensationDeps.invoke）',
    )
  },
  probe: async () => {
    throw new BahError(
      'comp-transport-missing',
      'bah-saga: comp-transport-missing: 未注入探诊通道（CompensationDeps.probe）',
    )
  },
}

/** 补偿行主键（与 `bindCompensation` 的 `comp_id` 口径一致）。 */
function compIdOf(sagaId: string, stepId: string): string {
  return `comp:${sagaId}:${stepId}`
}

function readComp(
  ctx: Context,
  sagaId: string,
  stepId: string,
): CompensatingAction | undefined {
  return ctx
    .get(SAGA_STORE)
    .tx((tx) => tx.listCompensations(sagaId).find((comp) => comp.stepId === stepId))
}

/**
 * 单一补偿发射口（自动路径与手动路径共用）。
 *
 * 顺序：读回冻结模板 → 重试硬停 → 目标登记 → `saga/comp-decided` waterfall →
 * 屏障检查 → 载荷投影/幂等键 → `saga/comp-issued` → 对称收敛 → `saga/comp-result`。
 *
 * @param deps 省略即 fail-loud（`comp-transport-missing`）
 * @throws `BahError('no-template')` 无计划期冻结绑定
 * @throws `BahError('barrier-violation')` 下游补偿未收敛
 */
export async function issueComp(
  ctx: Context,
  sagaId: string,
  step: SagaStep,
  settings: SagaSettings,
  deps: CompensationDeps = MISSING_TRANSPORT,
): Promise<void> {
  const clock = ctx.get(SAGA_CLOCK)
  const template = ctx.get(SAGA_TEMPLATES).boundFor(sagaId, step.stepId)
  if (template === undefined) {
    throw new BahError('no-template', `bah-saga: no-template: ${step.stepId} 无计划期冻结绑定`, {
      sagaId,
      stepId: step.stepId,
    })
  }

  const current = readComp(ctx, sagaId, step.stepId)
  if (current === undefined) {
    throw new BahError('no-template', `bah-saga: no-template: ${step.stepId} 无补偿绑定行`, {
      sagaId,
      stepId: step.stepId,
    })
  }
  if (current.state === 'OK' || current.state === 'DLQ') return

  // 重试硬停（M5 / A23）：代码级熔断，不读任何开关，waterfall 也无法放行。
  const maxAttempts = Math.max(1, settings.maxAttempts)
  if (current.attempts >= maxAttempts) {
    deadLetter(ctx, current, step, settings, 'max-attempts', current.attempts)
    return
  }

  // 未登记目标 / 探诊端点为空 → 禁止自动补偿（O3 / unknown-target）。
  const target = ctx.get(TARGET_REGISTRY).get(step.toolName)
  if (
    target === undefined ||
    target.probeEndpoint === undefined ||
    target.probeEndpoint.length === 0
  ) {
    deadLetter(ctx, current, step, settings, 'unknown-target', current.attempts)
    return
  }

  // 治理平面可拦截自动补偿（唯一 waterfall；不调 next() 者拥有判决）。
  const decision = await ctx.events.waterfall('saga/comp-decided', {
    sagaId,
    stepId: step.stepId,
    decide: 'compensate',
    reason: 'step-failed',
  })
  if (decision.decide !== 'compensate') return

  const payload = projectPayload(template, snapshotOf(ctx, step))
  const payloadDigest = sha256Hex(canonicalJson(payload))
  // 补偿键：`COMP` 命名空间 + 补偿主键 + PLAN 期 nonce（**不含** attempt，负向用例 #2）。
  const compKey = ctx
    .get(SAGA_IDEMPOTENCY)
    .makeKey('COMP', sagaId, compIdOf(sagaId, step.stepId), step.idempotencyNonce)

  // 发射闸门：自动与手动共用（在 comp-issued 之前）。
  barrierCheck(ctx, sagaId, step.stepId)

  if (template.compKind === 'NO_OP') {
    finish(ctx, current, { state: 'OK', maxAttempts, payloadDigest }, 'ok')
    return
  }

  const attempts = current.attempts + 1
  const issued = {
    sagaId,
    compId: current.compId,
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    compKind: template.compKind,
    compKey,
    payloadDigest,
  }
  commitSegment(ctx, (tx) => {
    tx.updateCompensation({
      ...current,
      state: 'ISSUED',
      attempts,
      maxAttempts,
      payloadDigest,
      backoffPolicy: JSON.stringify(settings.compBackoff),
      compDeadline: clock.now() + settings.hardSlaMs,
    })
    ctx.get(SAGA_AUDIT).append(sagaId, 'saga/comp-issued', issued)
  })
  ctx.events.emit('saga/comp-issued', issued)

  // 对称三态收敛：`settleCall` 自带 COMP 幂等占位 + 探诊 + 错误分类（R3.8）。
  // `ref.stepId` 取补偿主键，保证 `settleCall` 内部重建的键与 `compKey` 逐字一致。
  const ref: StepRef = { sagaId, stepId: current.compId, toolName: step.toolName }
  const outcome = await settleCall(
    ctx,
    {
      namespace: 'COMP',
      ref,
      nonce: step.idempotencyNonce,
      requestDigest: payloadDigest,
      invoke: (signal) =>
        deps.invoke(
          {
            sagaId,
            stepId: step.stepId,
            compId: current.compId,
            toolName: step.toolName,
            endpoint: template.compEndpoint,
            compKind: template.compKind,
            compKey,
            template,
            payload,
          },
          signal,
        ),
    },
    deps.probe,
    settings,
  )

  if (outcome.kind === 'ok') {
    finish(ctx, current, { state: 'OK', attempts, maxAttempts, payloadDigest }, 'ok')
    return
  }
  if (outcome.kind === 'err') {
    // 失败留在 ERR：由调用方（`runCompensation`）按 `compBackoff` 退避重试，达上限即硬停。
    finish(ctx, current, { state: 'ERR', attempts, maxAttempts, payloadDigest }, 'err')
    return
  }
  if (outcome.kind === 'unknown' && outcome.code === 'lease-held') {
    // 幂等键被他人持有：不硬抢、不 DLQ，留 UNKNOWN 等下一轮（租约过期后接管）。
    finish(ctx, current, { state: 'UNKNOWN', attempts, maxAttempts, payloadDigest }, 'unknown')
    return
  }

  // 探诊后仍含糊 / 未执行 / 同键异载 → DLQ，禁止再次自动补偿。
  const reason =
    outcome.kind === 'unresolved'
      ? outcome.reason
      : outcome.code === 'key-conflict'
        ? 'key-conflict'
        : 'probe-unresolved'
  deadLetter(ctx, current, step, settings, reason, attempts, payloadDigest)
}

/** 收敛结果落账：补偿行状态 + 审计同提交段，事件在提交后派发。 */
function finish(
  ctx: Context,
  row: CompensatingAction,
  patch: {
    readonly state: CompState
    readonly attempts?: number
    readonly maxAttempts?: number
    readonly payloadDigest?: string
  },
  outcome: 'ok' | 'err' | 'unknown',
): void {
  const event: {
    sagaId: string
    compId: string
    outcome: 'ok' | 'err' | 'unknown'
    residualAmount?: number
  } = {
    sagaId: row.sagaId,
    compId: row.compId,
    outcome,
    ...(row.residualAmount > 0 ? { residualAmount: row.residualAmount } : {}),
  }
  commitSegment(ctx, (tx) => {
    tx.updateCompensation({ ...row, ...patch })
    ctx.get(SAGA_AUDIT).append(row.sagaId, 'saga/comp-result', event)
  })
  ctx.events.emit('saga/comp-result', event)
}

/** 补偿 DLQ 升级：`saga/dlq-escalated`（`escalateToDlq`）+ 补偿行 `DLQ` + 结果审计。 */
function deadLetter(
  ctx: Context,
  row: CompensatingAction,
  step: SagaStep,
  settings: SagaSettings,
  reason: string,
  attempts: number,
  payloadDigest?: string,
): void {
  const at = ctx.get(SAGA_CLOCK).now()
  escalateToDlq(ctx, {
    sagaId: row.sagaId,
    stepId: step.stepId,
    source: 'comp',
    reason,
    slaDeadline: at + settings.hardSlaMs,
  })

  const event: { sagaId: string; compId: string; outcome: 'unknown' } = {
    sagaId: row.sagaId,
    compId: row.compId,
    outcome: 'unknown',
  }
  commitSegment(ctx, (tx) => {
    tx.updateCompensation({
      ...row,
      state: 'DLQ',
      attempts,
      ...(payloadDigest === undefined ? {} : { payloadDigest }),
    })
    ctx.get(SAGA_AUDIT).append(row.sagaId, 'saga/comp-result', { ...event, reason })
  })
  ctx.events.emit('saga/comp-result', event)
}

/**
 * 正向快照：步骤运行期字段 + 最新 `state_snapshot` 的摘要面。
 *
 * 明文载荷只存在 vault（SA-11），冻结的 `SagaTx` 不提供解密面，因此本层只投影
 * 可见的确定性字段；模板 `payload_projection` 的 `from` 路径对这里取值。
 */
function snapshotOf(ctx: Context, step: SagaStep): Readonly<Record<string, unknown>> {
  const latest: StateSnapshot | undefined = ctx
    .get(SAGA_STORE)
    .tx((tx) => tx.readLatestSnapshot(step.sagaId))
  return {
    sagaId: step.sagaId,
    stepId: step.stepId,
    seqNo: step.seqNo,
    toolName: step.toolName,
    endpoint: step.endpoint,
    sideEffectClass: step.sideEffectClass,
    requestDigest: step.requestDigest,
    responseDigest: step.responseDigest,
    attempts: step.attempts,
    ...(latest === undefined
      ? {}
      : {
          snapshotId: latest.snapshotId,
          stepSeq: latest.stepSeq,
          contextDigest: latest.contextDigest,
        }),
  }
}

/* ────────────────────────────── 编排 ────────────────────────────── */

/**
 * 补偿编排：逆拓扑逐层发射（层内并行 ≤ `maxParallelBranches`），
 * 每层内按 `compBackoff` 退避重试至收敛 / 硬停，层间由 `barrierCheck` 屏障。
 *
 * 下游层未收敛（DLQ）时，上游层的 `issueComp` 会抛 `barrier-violation`——
 * 这是结构性拦截，不是异常吞掉。
 */
export async function runCompensation(
  ctx: Context,
  sagaId: string,
  settings: SagaSettings,
  deps: CompensationDeps = MISSING_TRANSPORT,
): Promise<void> {
  const store = ctx.get(SAGA_STORE)
  const maxAttempts = Math.max(1, settings.maxAttempts)
  try {
    for (const layer of reverseLayers(store.listSteps(sagaId))) {
      // `NONE` 步骤无补偿绑定，不进入补偿调度。
      const scheduled = layer.filter((step) => step.sideEffectClass !== 'NONE')
      if (scheduled.length === 0) continue
      await runLayer(ctx, sagaId, scheduled, settings, deps, maxAttempts)
    }
  } catch (error) {
    // 下游已 DLQ 时上游屏障必拒绝发射：这不是异常吞掉，而是结构性停止。
    // 状态收敛为 PARTIALLY_COMPENSATED，余下人工处置（DLQ 工单已落账）。
    if (!(error instanceof BahError) || error.code !== 'barrier-violation') throw error
    // 先收敛可判定的终态，再把结构性拦截原样抛给调用方（不静默吞错）。
    finalizeCompensation(ctx, sagaId, true)
    throw error
  }
  finalizeCompensation(ctx, sagaId)
}

/**
 * 补偿终态收敛：全部 OK → COMPENSATED；存在 DLQ/ERR/UNKNOWN → PARTIALLY_COMPENSATED。
 *
 * 只从 `COMPENSATING` 出发（`advance` 先校验合法出边，再 CAS）。
 * 注意：冻结事件表里没有「补偿完成」事件，本批只推进存储状态；
 * `saga/dlq-escalated` 仍按既有语义折叠为 `COMPENSATION_DLQ`，投影口径留待批 6 对齐。
 */
function finalizeCompensation(ctx: Context, sagaId: string, barrierStopped = false): void {
  const store = ctx.get(SAGA_STORE)
  const saga = store.loadTransaction(sagaId)
  if (saga === undefined || saga.state !== 'COMPENSATING') return

  const comps = store.tx((tx) => tx.listCompensations(sagaId))
  if (comps.length === 0) return
  const failed = comps.some(
    (comp) => comp.state === 'DLQ' || comp.state === 'ERR' || comp.state === 'UNKNOWN',
  )
  const settled = comps.every(
    (comp) => comp.state === 'OK' || comp.state === 'DLQ' || comp.state === 'ERR',
  )
  // 屏障停止时上游可能仍为 PENDING；只要已有失败项，即按部分补偿收敛。
  if (!settled && !(barrierStopped && failed)) return

  const to =
    comps.every((comp) => comp.state === 'OK') ? 'COMPENSATED' : 'PARTIALLY_COMPENSATED'
  const at = ctx.get(SAGA_CLOCK).now()
  // 状态收敛与「补偿完成」链记录同提交段：冻结事件表无独立完成事件，
  // 以既有 `saga/comp-result` 的保留 subjectRef（`$final:<STATE>`）承载终态，
  // 回放据此从 CREATED 全量折叠到与运行时一致（SA-16 §8 批 6 对齐）。
  commitSegment(ctx, (tx) => {
    if (!tx.casState(sagaId, 'COMPENSATING', to, saga.version, at)) {
      throw new BahError('version-conflict', `bah-saga: version-conflict: ${sagaId}@v${saga.version}`, {
        sagaId,
        version: saga.version,
        from: 'COMPENSATING',
        to,
      })
    }
    ctx.get(SAGA_AUDIT).append(sagaId, 'saga/comp-result', {
      sagaId,
      compId: `${SAGA_FINAL_SUBJECT_PREFIX}${to}`,
    })
  })
}

async function runLayer(
  ctx: Context,
  sagaId: string,
  layer: readonly SagaStep[],
  settings: SagaSettings,
  deps: CompensationDeps,
  maxAttempts: number,
): Promise<void> {
  const clock = ctx.get(SAGA_CLOCK)
  // 轮次 0 为首发；之后每轮先按 compBackoff 退避再重试；`attempts ≥ maxAttempts`
  // 的那一轮不再 invoke（issueComp 内部硬停转 DLQ）。
  for (let round = 0; round <= maxAttempts; round += 1) {
    const pending = layer.filter((step) => {
      const comp = readComp(ctx, sagaId, step.stepId)
      return comp === undefined || (comp.state !== 'OK' && comp.state !== 'DLQ')
    })
    if (pending.length === 0) return

    const retryable = pending.filter((step) => {
      const comp = readComp(ctx, sagaId, step.stepId)
      return comp === undefined || comp.attempts < maxAttempts
    })
    if (round > 0 && retryable.length > 0) {
      const delay = Math.max(
        ...retryable.map((step) =>
          compBackoffDelay(
            settings.compBackoff,
            round,
            seedOf(compIdOf(sagaId, step.stepId)),
          ),
        ),
      )
      await clock.sleep(delay)
    }

    await mapPool(pending, settings.maxParallelBranches, (step) =>
      issueComp(ctx, sagaId, step, settings, deps),
    )
  }
}

/** 字符串 → 32 位种子（FNV-1a；纯整数运算，跨平台一致）。 */
function seedOf(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
