/**
 * SLO 桥（可观测性 02 / S2.6）。
 *
 * `collectSloMetrics` 读 saga 存储/链/心跳；没装 saga 的 profile 必须返回 `undefined`
 * 而不是抛错——否则 headless/plan 会因为"看板功能"起不来。
 */

import { collectSloMetrics, type SloSample } from '@bah/saga'

import type { Context } from '@bah/core'

import { SAGA_SETTINGS } from '../saga.ts'
import { tryService } from './deps.ts'

/** 读八项 SLO；saga 未装配或求值失败一律 `undefined`（JSON 端点显示 null）。 */
export function readSlo(ctx: Context): Record<string, SloSample> | undefined {
  const settings = tryService(ctx, SAGA_SETTINGS)
  if (settings === undefined) return undefined
  try {
    return collectSloMetrics(ctx, settings)
  } catch {
    return undefined
  }
}

/** 把 `WebDeps.trySlo` 的闭包留在本文件（`web.ts` 的 apply 只留一行调用，不新增函数字面量）。 */
export function sloReader(ctx: Context): () => Record<string, SloSample> | undefined {
  return () => readSlo(ctx)
}
