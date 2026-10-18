/**
 * 系统提示词装配入口（施工单 05 §4）。
 *
 * 实现在 `types.ts` / `sections.ts` / `registry.ts` / `reconcile.ts`；
 * 本文件只做 re-export 与「注册 `runtime:system-prompt` 服务」这一处装配。
 */

import { defineService } from '@bah/core'

import type { Context, Disposer, ServiceKey } from '@bah/core'

import { PromptRegistry } from './registry.ts'
import { DEFAULT_SECTIONS } from './sections.ts'

export * from './reconcile.ts'
export * from './registry.ts'
export * from './sections.ts'
export * from './types.ts'

/** 系统提示词注册表服务键：插件加 section、主循环取装配结果都走它。 */
export const SYSTEM_PROMPT_SERVICE: ServiceKey<PromptRegistry> = defineService<PromptRegistry>(
  'runtime:system-prompt',
)

/** 造一个装了六段内建 section 的注册表（顺序由 `SECTION_ORDERS` 决定）。 */
export function createDefaultPromptRegistry(): PromptRegistry {
  const registry = new PromptRegistry()
  for (const section of DEFAULT_SECTIONS) registry.register(section)
  return registry
}

/**
 * 注册 `runtime:system-prompt` 服务。
 *
 * @param ctx 内核上下文
 * @param registry 复用外部注册表（默认新建一个装了六段的实例）
 * @returns 注销句柄（随宿主插件一起回滚）
 */
export function provideSystemPrompt(ctx: Context, registry = createDefaultPromptRegistry()): Disposer {
  return ctx.provide(SYSTEM_PROMPT_SERVICE, registry)
}
