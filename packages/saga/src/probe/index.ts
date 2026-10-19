/**
 * 三态探诊阶梯（SA-09 §3.4，批 3）。
 *
 * 阶梯：L1（同步探诊）→ `lag_seconds > 0` 时等 `lagSeconds × probeLagFactor` 后 L2
 * → 仍未见则 `UNRESOLVED`（→ DLQ + 工单，§3.5）。
 *
 * 硬规则：无登记或登记缺 `probe_endpoint` → **直接** `probe-unresolved`，
 * **禁止自动补偿**；探诊只经注入的 `ProbeTransport`，不得发起真实网络调用。
 */

import { SAGA_AUDIT, SAGA_CLOCK, TARGET_REGISTRY } from '../seams.ts'

import type { Context } from '@bah/core'

import type { SagaAudit } from '../seams.ts'
import type { SagaSettings, SagaStep } from '../types.ts'

/** 探诊只需步骤标识（正向步 or 补偿动作共用）——避免向探诊面泄漏整个 SagaStep。 */
export type StepRef = Pick<SagaStep, 'sagaId' | 'stepId' | 'toolName'>

/** 外部域探诊通道：**必须可 mock**（`@bah/test-support`）；**不得**真实网络调用。 */
export type ProbeTransport = (
  endpoint: string,
  ref: StepRef,
  signal: AbortSignal,
) => Promise<ProbeObservation>

/** 一次探诊观测（外部系统只能回答这三类）。 */
export type ProbeObservation =
  | { readonly kind: 'executed'; readonly responseDigest: string }
  | { readonly kind: 'not-executed' }
  | { readonly kind: 'failed' }

/** 阶梯判定结果。 */
export type ProbeVerdict =
  | { readonly kind: 'executed'; readonly responseDigest: string }
  | { readonly kind: 'not-executed' }
  | { readonly kind: 'unresolved'; readonly reason: string }

/** 探诊阶梯：L1 → L2 → UNRESOLVED（→ DLQ，`settle.ts`）。 */
export async function probeStep(
  ctx: Context,
  ref: StepRef,
  transport: ProbeTransport,
  settings: SagaSettings,
): Promise<ProbeVerdict> {
  const registry = ctx.get(TARGET_REGISTRY)
  const audit = ctx.get(SAGA_AUDIT)
  const clock = ctx.get(SAGA_CLOCK)
  const target = registry.get(ref.toolName)

  // L1 前置硬规则：无登记 或 无探诊端点 → 直接 unresolved，**禁止自动补偿**（O3 / unknown-target）。
  if (target === undefined || target.probeEndpoint === undefined) {
    const reason = target === undefined ? 'unknown-target' : 'probe-unresolved'
    record(ctx, audit, ref, {
      ladder: 'L1',
      verdict: 'no-probe-endpoint',
    })
    return { kind: 'unresolved', reason }
  }

  const first = await observe(transport, target.probeEndpoint, ref, settings.probeTimeoutMs)
  record(ctx, audit, ref, {
    ladder: 'L1',
    endpoint: target.probeEndpoint,
    verdict: first.kind,
  })
  if (first.kind === 'executed') return { kind: 'executed', responseDigest: first.responseDigest }
  if (first.kind === 'failed') return { kind: 'unresolved', reason: 'probe-endpoint-failed' }

  // L1 = 未执行 且 lag_seconds > 0 → 等 lagSeconds × probeLagFactor 后二次探诊（M4 / A14）。
  const lagSeconds = target.lagSeconds ?? 0
  if (lagSeconds > 0) {
    const lagWaitMs = lagSeconds * 1000 * settings.probeLagFactor
    await clock.sleep(lagWaitMs)
    const second = await observe(transport, target.probeEndpoint, ref, settings.probeTimeoutMs)
    record(ctx, audit, ref, {
      ladder: 'L2',
      endpoint: target.probeEndpoint,
      verdict: second.kind,
      lagWaitMs,
    })
    if (second.kind === 'executed') {
      return { kind: 'executed', responseDigest: second.responseDigest }
    }
    if (second.kind === 'failed') return { kind: 'unresolved', reason: 'probe-endpoint-failed' }
  }

  return { kind: 'unresolved', reason: 'probe-unresolved' }
}

/** 探诊通道异常按 `failed` 处置（判定依据仍落账，不静默吞错）。 */
async function observe(
  transport: ProbeTransport,
  endpoint: string,
  ref: StepRef,
  timeoutMs: number,
): Promise<ProbeObservation> {
  try {
    return await transport(endpoint, ref, AbortSignal.timeout(timeoutMs))
  } catch {
    return { kind: 'failed' }
  }
}

interface ProbeRecord {
  readonly ladder: 'L1' | 'L2'
  readonly endpoint?: string
  readonly verdict: string
  readonly lagWaitMs?: number
}

/** 探诊动作同时落审计链（证据）与事件出口（观测）。 */
function record(ctx: Context, audit: SagaAudit, ref: StepRef, data: ProbeRecord): void {
  const payload: {
    sagaId: string
    stepId: string
    ladder: 'L1' | 'L2'
    endpoint?: string
    verdict: string
    lagWaitMs?: number
  } = {
    sagaId: ref.sagaId,
    stepId: ref.stepId,
    ladder: data.ladder,
    verdict: data.verdict,
    ...(data.endpoint === undefined ? {} : { endpoint: data.endpoint }),
    ...(data.lagWaitMs === undefined ? {} : { lagWaitMs: data.lagWaitMs }),
  }
  audit.append(ref.sagaId, 'saga/unknown-probe', payload)
  ctx.events.emit('saga/unknown-probe', payload)
}
