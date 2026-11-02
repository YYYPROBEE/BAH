/**
 * `checkWindow`：授权窗口的条件复验（纯函数）。
 *
 * 输入窗口 + 世界快照 + 判定时刻，输出**输入 + 结论 + 摘要**。
 * 失败一律 `downgrade:'ask'`——窗口失守只降级为人工确认，绝不自动放行。
 *
 * 摘要是 `WindowVerdictInputs` 的规范化哈希：回放时用同一份输入重算，
 * 结论必须一致（门禁 I13）。这使"授权"从"可声称"变成"可复算"。
 */

import { canonicalJson, sha256Hex } from '@bah/util'

import {
  DEFAULT_MAX_SKEW_MS,
  type ArmedPlan,
  type WindowCondition,
  type WindowFailure,
  type WindowFailureCode,
  type WindowVerdict,
  type WindowVerdictInputs,
  type WorldSnapshot,
} from './types.ts'

/** 单条条件的复验结果。 */
export interface ConditionVerdict {
  readonly ok: boolean
  readonly failure?: WindowFailure
}

/** 复验一条条件（导出给单测与解释面板用）。 */
export function checkCondition(
  condition: WindowCondition,
  window: Pick<ArmedPlan, 'budgetCents' | 'planId'>,
  snapshot: WorldSnapshot,
): ConditionVerdict {
  switch (condition.kind) {
    case 'balance-at-least': {
      if (snapshot.balanceCents >= condition.cents) return { ok: true }
      return {
        ok: false,
        failure: {
          kind: condition.kind,
          expected: `>= ${String(condition.cents)}`,
          actual: String(snapshot.balanceCents),
        },
      }
    }
    case 'fact-unchanged': {
      const actual = snapshot.factVersions[condition.factId]
      if (actual === condition.version) return { ok: true }
      return {
        ok: false,
        failure: {
          kind: condition.kind,
          expected: `${condition.factId}@${String(condition.version)}`,
          actual: actual === undefined ? '缺失' : `${condition.factId}@${String(actual)}`,
        },
      }
    }
    case 'plan-not-cancelled': {
      if (!snapshot.cancelledPlans.includes(condition.planId)) return { ok: true }
      return {
        ok: false,
        failure: { kind: condition.kind, expected: '未被撤销', actual: '已撤销' },
      }
    }
    case 'amount-within': {
      if (window.budgetCents <= condition.cents) return { ok: true }
      return {
        ok: false,
        failure: {
          kind: condition.kind,
          expected: `<= ${String(condition.cents)}`,
          actual: String(window.budgetCents),
        },
      }
    }
    case 'address-unchanged': {
      const actual = snapshot.addressVersions[condition.addressId]
      if (actual === condition.version) return { ok: true }
      return {
        ok: false,
        failure: {
          kind: condition.kind,
          expected: `${condition.addressId}@${String(condition.version)}`,
          actual: actual === undefined ? '缺失' : `${condition.addressId}@${String(actual)}`,
        },
      }
    }
    default:
      return assertUnreachable(condition)
  }
}

function assertUnreachable(value: never): never {
  throw new Error(`checkWindow: 未覆盖的条件种类 ${JSON.stringify(value)}`)
}

/** 判决输入的摘要（唯一实现；落账与重算都调它）。 */
export function digestOfInputs(inputs: WindowVerdictInputs): string {
  return sha256Hex(canonicalJson(inputs))
}

/**
 * 复验一张已武装计划的授权窗口。
 *
 * 判定顺序（不可重排）：时钟越界 → 过期 → 计划撤销 → 条件逐条。
 * 为什么时钟最先：`at` 是外部入参，先把它钉住，后面的结论才有意义。
 *
 * @param window 已武装计划
 * @param snapshot 世界快照（**调用方负责取数**；本函数不查任何服务）
 * @param at 判定时刻（epoch ms）
 * @param maxSkewMs 允许的时钟漂移（缺省 5 分钟）
 */
export function checkWindow(
  window: ArmedPlan,
  snapshot: WorldSnapshot,
  at: number,
  maxSkewMs: number = DEFAULT_MAX_SKEW_MS,
): WindowVerdict {
  const planState: 'armed' | 'cancelled' = snapshot.cancelledPlans.includes(window.planId)
    ? 'cancelled'
    : 'armed'
  const inputs: WindowVerdictInputs = {
    balanceCents: snapshot.balanceCents,
    factVersions: snapshot.factVersions,
    planState,
    at,
    budgetCents: window.budgetCents,
  }
  const digest = digestOfInputs(inputs)
  const failures: WindowFailure[] = []

  if (window.state === 'cancelled' || planState === 'cancelled') {
    failures.push({ kind: 'plan-not-cancelled', expected: 'armed', actual: 'cancelled' })
  }
  if (window.expiresAt !== undefined && at > window.expiresAt) {
    failures.push({
      kind: 'window-expired',
      expected: `<= ${String(window.expiresAt)}`,
      actual: String(at),
    })
  }
  for (const condition of window.conditions) {
    const verdict = checkCondition(condition, window, snapshot)
    if (!verdict.ok && verdict.failure !== undefined) failures.push(verdict.failure)
  }
  if (at > snapshot.now + maxSkewMs) {
    failures.push({
      kind: 'window-clock-ahead',
      expected: `<= ${String(snapshot.now + maxSkewMs)}`,
      actual: String(at),
    })
  }

  if (failures.length === 0) return { ok: true, inputs, digest }
  return {
    ok: false,
    inputs,
    digest,
    code: codeOf(failures),
    failed: failures,
    downgrade: 'ask',
  }
}

/** 失败集合 → 主码（顺序即优先级）。 */
function codeOf(failures: readonly WindowFailure[]): WindowFailureCode {
  const kinds = new Set(failures.map((failure) => failure.kind))
  if (kinds.has('window-clock-ahead')) return 'window-clock-ahead'
  if (kinds.has('window-expired')) return 'window-expired'
  if (kinds.has('plan-not-cancelled')) return 'plan-cancelled'
  return 'condition-failed'
}
