/**
 * 接管状态桥（施工单 03 §2.6 用户侧）。
 *
 * 接管会循环（进入 → 认领 → 交回 → 再进入），所以状态必须按**帧序列**归约，
 * 不能只看"最后一条 active"：认领帧沿用进入时刻，交回帧不带 operator。
 *
 * 本文件只做纯归约；推送由 `session/hub.ts` 负责。
 */

import type { WebFrame } from '@bah/channels'

import { handoffTextOf } from '../approval/texts.ts'

/** 接管帧（从联合里摘出来；channels 的 barrel 只导出部分帧类型）。 */
type HandoffFrame = Extract<WebFrame, { readonly kind: 'handoff' }>

/** 当前接管状态。 */
export interface HandoffState {
  readonly active: boolean
  readonly operator?: string
}

/** 初始状态（未接管）。 */
export const IDLE_HANDOFF: HandoffState = { active: false }

/** 快照里最后一条 handoff 帧的状态（没有则 `undefined`）。 */
export function findLastHandoffState(frames: readonly WebFrame[]): HandoffState | undefined {
  let found: HandoffState | undefined
  for (const frame of frames) {
    if (frame.kind !== 'handoff') continue
    found = {
      active: frame.active,
      ...(frame.operator === undefined ? {} : { operator: frame.operator }),
    }
  }
  return found
}

/**
 * 应用一条接管帧。
 *
 * @returns `undefined` = 状态没变（不重复推送）
 */
export function handoffTransition(
  current: HandoffState,
  frame: HandoffFrame,
): { readonly state: HandoffState; readonly text: string } | undefined {
  const next: HandoffState = {
    active: frame.active,
    ...(frame.operator === undefined ? {} : { operator: frame.operator }),
  }
  if (next.active === current.active && next.operator === current.operator) return undefined
  return { state: next, text: handoffTextOf(frame) }
}
