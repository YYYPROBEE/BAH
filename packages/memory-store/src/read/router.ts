/**
 * 路由决策（施工文档 §7.1）。
 *
 * 四条判决，一条都不能省：
 * - 注册场景 → 只查该域
 * - 显式跨域且置信度 ≥0.6 → 追加目标域（带源标签）
 * - 显式跨域但置信度 <0.6 → **拒借**，返回反问建议
 * - `unknown` → **不检索**（禁通配全域兜底）
 *
 * 最后一条是整个记忆层最容易被"优化"掉的地方：加个"匹配不上就全查"看起来更聪明，
 * 实际是把"我不确定"变成"我全知道"，错配会以最高置信度呈现给用户。
 */

import type { RetrieveQuery, RouteCode, Scene } from '../types.ts'

/** 跨域借用的最低置信度（< 此值拒借并反问）。 */
export const CROSS_SCENE_MIN_CONFIDENCE = 0.6

export interface RoutePlan {
  readonly routeCode: RouteCode
  /** 本次允许命中的场景。空数组 = 不检索。 */
  readonly domains: readonly Scene[]
  readonly crossSceneRef?: { readonly target: Scene; readonly accepted: boolean }
  /** 拒借时给用户的反问建议。 */
  readonly suggestion?: string
}

export function planRoute(query: RetrieveQuery): RoutePlan {
  if (query.scene === 'unknown') {
    return { routeCode: 'EMPTY_UNKNOWN_SCENE', domains: [] }
  }

  const domains: Scene[] = [query.scene]
  if (query.crossSceneRef === undefined) {
    return { routeCode: 'ROUTE_OK', domains }
  }

  const { target, confidence } = query.crossSceneRef
  if (confidence >= CROSS_SCENE_MIN_CONFIDENCE) {
    if (!domains.includes(target)) domains.push(target)
    return {
      routeCode: 'ROUTE_OK',
      domains,
      crossSceneRef: { target, accepted: true },
    }
  }

  return {
    routeCode: 'CROSS_SCENE_REFUSED',
    domains: [],
    crossSceneRef: { target, accepted: false },
    suggestion: `这次的问题涉及「${target}」场景，但我不确定是否该跨场景读取您的偏好。请确认是否允许。`,
  }
}
