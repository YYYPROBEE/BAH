/**
 * `prompt:ask`：追问工具（`prompt_ask`）的宿主接线（03 单 §4 步 9）。
 *
 * 只做三件事：取意图平面的会话状态（追问计数与它共用一份数据）、注册工具、
 * 复用 `intent:plane` 已注册的契约源（契约服务只能有一个提供者）。
 *
 * ## 为什么这里不注册契约
 *
 * `runtime:tool-contracts` 是单实例服务，重复 `provide` 会抛 `service-conflict`。
 * 两个工具的 schema 在 `intent:plane` 里合并注册；本插件只依赖工具面。
 * 代价：单独装配 `prompt:ask` 而不装 `intent:plane` 会在 apply 期 fail-loud（取不到
 * `bah:intent-state`）——这是刻意的，宁可启动失败，也不要一个没有计数上限的追问工具。
 */

import { createPromptAskTool } from '@bah/interaction'
import { TOOLS_SERVICE, type ToolRegistry } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { readBoolean, rejectUnknownKeys } from '../config.ts'
import { INTENT_STATE_SERVICE } from './intent.ts'

const WHERE = 'prompt:ask'

export interface PromptAskSettings {
  readonly enabled: boolean
}

export const promptAskPlugin: HostPlugin<PromptAskSettings> = {
  id: WHERE,

  plugin: {
    name: WHERE,
    apply(ctx, settings) {
      if (!settings.enabled) return
      const registry = (): ToolRegistry => ctx.get(TOOLS_SERVICE)
      const state = ctx.get(INTENT_STATE_SERVICE)
      const tool = createPromptAskTool({ ledger: state })
      ctx.effect(registry().register(tool))
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['enabled'], WHERE)
    return { enabled: readBoolean(config, 'enabled', WHERE, true) }
  },
}
