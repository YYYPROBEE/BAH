/**
 * base bundle · `core:tools`：工具注册表（施工单 03 §3 第 9 步）。
 *
 * 只注册服务，不注册工具——具体工具族由插件线（施工单 08）以行插进 profile。
 */

import { provideTools } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { rejectUnknownKeys } from '../config.ts'

/** `core:tools` 的配置（无字段）。 */
export type ToolsSettings = Record<string, never>

export const toolsPlugin: HostPlugin<ToolsSettings> = {
  id: 'core:tools',

  plugin: {
    name: 'core:tools',
    apply(ctx) {
      provideTools(ctx)
    },
  },

  validate(config) {
    rejectUnknownKeys(config, [], 'core:tools')
    return {}
  },
}
