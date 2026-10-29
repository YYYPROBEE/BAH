/**
 * `todo_write`（04 单 §3.3.3）：模型把**非 plan 类**待办写给用户看的工具。
 *
 * 全量覆写而非增量：增量语义要求服务端保存"模型侧清单当前态"，那又是一个真相源；
 * 全量覆写下，`tool/result` 的最后一条就是完整现状，重放即重建。
 *
 * `sideEffect:'none'`：它写的是给用户看的清单，不碰任何资金/状态。
 * description 必须含"本工具不得用于跟踪 plan 节点"——plan 节点清单自动派生（D8）。
 */

import { BahError } from '@bah/util'

import { TODO_WRITE_TOOL, type TodoWriteArgs, type TodoWriteResult } from './types.ts'

import type { ToolDefinition } from '@bah/core'

export { TODO_WRITE_TOOL }

export const MAX_TODO_ITEMS = 20
export const MAX_TODO_TEXT_LENGTH = 200

export interface TodoToolDeps {
  /** 注入钟（`writtenAt` 用）；不读系统时钟。 */
  readonly now: () => number
}

export function createTodoWriteTool(deps: TodoToolDeps): ToolDefinition<TodoWriteArgs, TodoWriteResult> {
  return {
    name: TODO_WRITE_TOOL,
    description:
      '写入"助手记下的待办清单"（全量覆写：每次传入完整清单，旧的被替换）。' +
      '用于不是 DAG 执行的轻量事项（例如"下周三前上传身份证照片"）。' +
      '本工具不得用于跟踪 plan 节点，plan 节点清单自动派生；也不得用它标记任何资金操作已完成。',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: `完整清单（最多 ${String(MAX_TODO_ITEMS)} 条；传空数组 = 清空）`,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: `事项文案（≤ ${String(MAX_TODO_TEXT_LENGTH)} 字符）` },
              done: { type: 'boolean', description: '是否已完成（缺省 false）' },
            },
            required: ['text'],
          },
        },
      },
      required: ['items'],
    },
    tier: { level: 'green' },
    sideEffect: 'none',
    execute: async (args) => {
      if (!Array.isArray(args.items)) {
        throw new BahError('todo-invalid-item', 'todo_write: items 必须是数组', {})
      }
      if (args.items.length > MAX_TODO_ITEMS) {
        throw new BahError('todo-limit-exceeded', `todo_write: 条目超过 ${MAX_TODO_ITEMS} 条`, {
          count: args.items.length,
        })
      }
      const writtenAt = deps.now()
      const items = args.items.map((item) => {
        const text = item.text.trim()
        if (text.length === 0) {
          throw new BahError('todo-invalid-item', 'todo_write: 条目文案不能为空', {})
        }
        if (text.length > MAX_TODO_TEXT_LENGTH) {
          throw new BahError('todo-limit-exceeded', `todo_write: 单条文案超过 ${MAX_TODO_TEXT_LENGTH} 字符`, {
            length: text.length,
          })
        }
        return { text, done: item.done === true, writtenAt }
      })
      return { items }
    },
  }
}
