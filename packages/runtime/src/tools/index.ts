/**
 * 工具模块入口。
 *
 * 实现分散在 `types.ts`（运行期形状）/ `registry.ts` / `guard.ts` / `recovery.ts` / `pipeline.ts`；
 * 本文件只做 re-export 与「注册 `tools` 服务」这一处装配。
 */

import { defineService } from '@bah/core'

import type { Context, Disposer, ServiceKey } from '@bah/core'

import { ToolRegistry } from './registry.ts'

export * from './contracts.ts'
export * from './guard.ts'
export * from './pipeline.ts'
export * from './recovery.ts'
export * from './registry.ts'
export * from './types.ts'

/** 工具注册表服务键：插件注册工具、主循环取 schema 都走它。 */
export const TOOLS_SERVICE: ServiceKey<ToolRegistry> = defineService<ToolRegistry>('runtime:tools')

/**
 * 注册 `tools` 服务。
 *
 * @param ctx 内核上下文
 * @param registry 复用外部注册表（默认新建）
 * @returns 注销句柄（随宿主插件一起回滚）
 */
export function provideTools(ctx: Context, registry = new ToolRegistry()): Disposer {
  return ctx.provide(TOOLS_SERVICE, registry)
}
