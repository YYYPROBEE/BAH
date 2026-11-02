/**
 * base bundle · `demo:echo`：底座自检用的示例工具（**非银行业务**）。
 *
 * 为什么 base 里带一个 demo 工具：`--profile headless` 的验收要证明"完整 turn"包含
 * 工具七段管线（`tool/call` → `tool/result` → 模型续写），而不是只有一段文本回复。
 * 银行工具族属于插件线，本阶段不实现。
 */

import { TOOLS_SERVICE } from '@bah/runtime'

import type { ToolDefinition } from '@bah/core'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { readRawString, rejectUnknownKeys } from '../config.ts'

/** `demo:echo` 的配置。 */
export interface EchoSettings {
  /** 回显前缀（演示用的可调项，写进 patch 即可）。 */
  readonly prefix: string
}

/** 工具名（模型可见）。 */
export const ECHO_TOOL_NAME = 'echo'

/** 造一个带前缀的 echo 工具。 */
export function createEchoTool(prefix: string): ToolDefinition<{ text: string }, { text: string }> {
  return {
    name: ECHO_TOOL_NAME,
    description: '回显一段文本（底座自检用示例工具，不涉及任何银行数据）',
    schema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
    tier: { level: 'green' },
    sideEffect: 'none',
    execute: (args) => Promise.resolve({ text: `${prefix}${args.text}` }),
    projectContent: (result) => [{ type: 'text', text: result.text }],
  }
}

export const echoPlugin: HostPlugin<EchoSettings> = {
  id: 'demo:echo',

  plugin: {
    name: 'demo:echo',
    inject: [TOOLS_SERVICE.id],
    apply(ctx, config) {
      ctx.get(TOOLS_SERVICE).register(createEchoTool(config.prefix))
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['prefix'], 'demo:echo')
    // 前缀**不 trim**：`'[headless] '` 结尾那个空格是有意义的
    return { prefix: readRawString(config, 'prefix', 'demo:echo') ?? '' }
  },
}
