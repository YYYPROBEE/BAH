/**
 * base bundle · `core:prompt`：系统提示词装配。
 *
 * 内建六段由 runtime 提供（`createDefaultPromptRegistry`），插件线的领域段
 * 通过 `SYSTEM_PROMPT_SERVICE` 自己注册；本行只负责把服务挂上来。
 */

import { provideSystemPrompt } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { rejectUnknownKeys } from '../config.ts'

/** `core:prompt` 的配置（无字段）。 */
export type PromptSettings = Record<string, never>

export const promptPlugin: HostPlugin<PromptSettings> = {
  id: 'core:prompt',

  plugin: {
    name: 'core:prompt',
    apply(ctx) {
      provideSystemPrompt(ctx)
    },
  },

  validate(config) {
    rejectUnknownKeys(config, [], 'core:prompt')
    return {}
  },
}
