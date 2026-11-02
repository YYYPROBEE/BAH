/**
 * 入口平面：`agent/pre-step`（waterfall）。
 *
 * 只做三件事：**归一化 → 9 签名检测 → 审计 + 会话风险分**。
 * **不改判、不拒绝**（铁律一）：监听器末尾无条件 `next()`，判决权留给控制平面。
 *
 * 混淆绕过在这里处理：6 步归一化后的文本才进检测器；
 * IM 不可信来源标记（第 5 行）只做来源标注与审计，不改变判决。
 */

import { detect, normalize } from '../kernel/index.ts'
import type { TraceLog } from '../kernel/index.ts'

import type { Listener } from '@bah/core'
import type { SentrySettings } from './config.ts'
import type { SentrySessionEventType } from './events.ts'
import { parseUntrustedMark } from './im.ts'
import type { SentryState } from './state.ts'

/** 入口平面的装配参数。 */
export interface SentryIngressOptions {
  readonly sessionId: string
  readonly settings: SentrySettings
  readonly state: SentryState
  readonly trace: TraceLog
  readonly record: (type: SentrySessionEventType, data: unknown) => void
  readonly now: () => number
}

/** `agent/pre-step` 载荷的最小结构形状（不 import `@bah/runtime`）。 */
interface PreStepLike {
  readonly messages: readonly { readonly text: string }[]
  readonly turn: number
  readonly step: number
}

/**
 * 造入口监听器（waterfall）。
 *
 * @returns 始终把控制权交还下游的监听器（末尾 `return next(payload)`）
 */
export function createIngressListener(
  options: SentryIngressOptions,
): Listener<'agent/pre-step'> {
  const { sessionId, settings, state, trace, record, now } = options

  return async (payload, next) => {
    const input = payload as PreStepLike
    state.step = input.step

    for (const message of input.messages) {
      const untrusted = parseUntrustedMark(message.text)
      const normalized = normalize(untrusted.text)
      const signal = detect(normalized.normalized, settings.detector)
      state.raiseRisk(signal.score, signal.level)

      const suspicious =
        signal.families.length > 0 || normalized.transforms.length > 0 || untrusted.untrusted
      if (!suspicious) continue

      const at = now()
      const families = [...signal.families]
      trace.bump('detections')
      trace.append({
        session: sessionId,
        kind: 'ingress-detected',
        turn: input.turn,
        step: input.step,
        level: signal.level,
        score: signal.score,
        families,
        transforms: [...normalized.transforms],
        untrusted: untrusted.untrusted,
        at,
      })
      record('sentry/detected', {
        turn: input.turn,
        step: input.step,
        level: signal.level,
        score: signal.score,
        families,
        transforms: [...normalized.transforms],
        untrusted: untrusted.untrusted,
        at,
      })
    }

    // 铁律一：检测器永不阻断——无条件交还控制权
    return next(payload)
  }
}
