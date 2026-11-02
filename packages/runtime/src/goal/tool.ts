/**
 * `goal_set`：内置绿级工具，落账只走管线的 `tool/call` + `tool/result`。
 *
 * `sideEffect:'none'`：本工具不改银行数据、不改外部世界；标的账本本身就是 tool/result
 * 的投影素材。标成 'write' 会让"记了一笔账"混进 effects 帧的"已发生操作清单"——
 * 那是语义污染（effects 清单的用途是"中断后告诉用户钱去哪了"）。
 *
 * 不声明 `projectContent`：出参必须是结构化 JSON，投影层与 `replayGoalStore` 都读它。
 */

import { BahError } from '@bah/util'

import { GOAL_SET_TOOL, type GoalSetArgs, type GoalSetResult, type GoalStore } from './types.ts'

import type { ToolDefinition } from '@bah/core'

export { GOAL_SET_TOOL }

/** 陈述长度上限：账本条目不是文章，超限多半是模型把整段对话塞了进来。 */
export const MAX_STATEMENT_LENGTH = 500

export interface GoalToolDeps {
  /** 当前 turn 序号（`ToolExecContext` 不带 turn，由宿主按会话事件注入）。 */
  readonly turnOf: () => number
  /** 元 → 分。唯一转换点来自 `@bah/bank` 的 `yuanToCents`，由宿主注入（runtime 不依赖 bank）。 */
  readonly toCents: (yuan: number) => number
}

export function createGoalSetTool(
  store: GoalStore,
  deps: GoalToolDeps,
): ToolDefinition<GoalSetArgs, GoalSetResult> {
  return {
    name: GOAL_SET_TOOL,
    description:
      '记录或关闭一个用户目标（意图账本）。当用户表达了一个跨越多步、可能跨多个回合的意图时调用；' +
      '目标完成/放弃/过期时调用关闭。本工具不产生任何资金副作用；' +
      '不要用它跟踪 plan 节点状态（plan 节点清单由事件自动派生）。',
    schema: {
      type: 'object',
      properties: {
        statement: {
          type: 'string',
          description: '脱敏后的一句话意图陈述（不得含卡号/全名等原文敏感字段）；新建时必填',
        },
        goalId: { type: 'string', description: '关闭既有目标时必填；新建时省略' },
        status: {
          type: 'string',
          enum: ['achieved', 'abandoned', 'expired'],
          description: '关闭时必填；不可传 active（active→active 是非法转移，会 fail-loud）',
        },
        planId: { type: 'string', description: '可选：关联的 plan_propose 产物 planId' },
        budget: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: '预算金额（单位：元，与银行工具入参口径一致）' },
            currency: { type: 'string', enum: ['CNY'] },
          },
        },
        constraints: { type: 'array', items: { type: 'string' }, description: '自由文本约束，v1 不做机器判定' },
      },
    },
    tier: { level: 'green' },
    sideEffect: 'none',
    execute: async (args) => {
      const closing = args.goalId !== undefined
      if (closing === (args.statement !== undefined)) {
        throw new BahError(
          'goal-invalid-shape',
          'goal_set: 新建（statement）与关闭（goalId + status）二选一',
          {},
        )
      }
      if (closing) {
        if (args.status === undefined) {
          throw new BahError('goal-invalid-shape', 'goal_set: 关闭必须给 status', { goalId: args.goalId })
        }
        return store.close(args.goalId as string, args.status)
      }
      const statement = args.statement?.trim() ?? ''
      if (statement.length === 0) {
        throw new BahError('goal-invalid-shape', 'goal_set: statement 不能为空', {})
      }
      if (statement.length > MAX_STATEMENT_LENGTH) {
        throw new BahError('goal-invalid-shape', `goal_set: statement 超过 ${MAX_STATEMENT_LENGTH} 字符`, {
          length: statement.length,
        })
      }
      if (args.budget !== undefined && !(Number.isFinite(args.budget.amount) && args.budget.amount > 0)) {
        throw new BahError('goal-invalid-shape', 'goal_set: 预算金额必须是正数（元）', {})
      }
      return store.create({
        statement,
        originTurn: deps.turnOf(),
        ...(args.planId === undefined ? {} : { planId: args.planId }),
        ...(args.budget === undefined
          ? {}
          : { budget: { amountCents: deps.toCents(args.budget.amount), currency: 'CNY' as const } }),
        ...(args.constraints === undefined ? {} : { constraints: args.constraints }),
      })
    },
  }
}
