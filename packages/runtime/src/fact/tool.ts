/**
 * 事实三工具：`fact_remember` / `fact_list` / `fact_forget`。
 *
 * 三个都是**内置工具**（不算银行工具目录的 16 个）。落账只走 `tool/call` + `tool/result`。
 *
 * - `fact_remember` 绿级：只记录用户说过或确认过的事，不推断；
 * - `fact_list` 绿级只读；
 * - `fact_forget` **黄级**：删除走审批通道 + 打字确认（确认词在 `@bah/channels` 的 `confirm.ts` 定义，
 *   服务端校验）。不要用 `prompt_ask` 二选一顶替——那不是审批通道，票据链上什么都不会留。
 */

import { BahError } from '@bah/util'

import {
  FACT_FORGET_TOOL,
  FACT_KINDS,
  FACT_LIST_TOOL,
  FACT_RELATIONS,
  FACT_REMEMBER_TOOL,
  type FactKind,
  type FactRelation,
  type FactStore,
  type LifeFact,
} from './types.ts'

import type { ToolDefinition } from '@bah/core'

/** 工具依赖：当前回合与注入时钟（都从宿主来，工具不读真实时钟）。 */
export interface FactToolDeps {
  readonly turnOf: () => number
  readonly now: () => number
}

/** `fact_remember` 的入参。 */
export interface FactRememberArgs {
  readonly person?: string
  readonly relation?: FactRelation
  readonly kind?: FactKind
  readonly date?: string
  readonly note?: string
  readonly confirmed?: boolean
}

/** `fact_list` 的入参。 */
export interface FactListArgs {
  readonly person?: string
  readonly kind?: FactKind
}

/** `fact_forget` 的入参。 */
export interface FactForgetArgs {
  readonly factId?: string
}

/** `fact_list` 的出参。 */
export interface FactListResult {
  readonly facts: readonly LifeFact[]
}

/** `fact_forget` 的出参（replay 只读 `factId`）。 */
export interface FactForgetResult {
  readonly factId: string
  readonly deleted: true
}

/** 造三个事实工具（宿主注册，注销由注册表 disposer 负责）。 */
export function createFactTools(
  store: FactStore,
  deps: FactToolDeps,
): readonly ToolDefinition<unknown, unknown>[] {
  const remember: ToolDefinition<FactRememberArgs, LifeFact> = {
    name: FACT_REMEMBER_TOOL,
    description:
      '把用户明确说出（或确认过）的生活事实记入账本：人物 / 关系 / 日期 / 偏好四类。' +
      '只记原话里有的字段，不要推测；不确定就先问用户。' +
      '同一人物同一件事重复记录视为"再确认"（版本号 +1）。',
    schema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: '称谓（如"爱人""母亲"），不要填全名' },
        relation: { type: 'string', enum: [...FACT_RELATIONS], description: '关系' },
        kind: { type: 'string', enum: [...FACT_KINDS], description: '事实种类' },
        date: { type: 'string', description: '日期（YYYY-MM-DD）；偏好类可省略' },
        note: { type: 'string', description: '脱敏后的一句话描述（偏好 / 义务用）' },
        confirmed: { type: 'boolean', description: '用户是否已当面确认；本轮刚说的可传 true' },
      },
      required: ['person', 'relation', 'kind'],
    },
    tier: { level: 'green' },
    sideEffect: 'write',
    execute: async (args) => {
      const person = args.person?.trim() ?? ''
      const relation = args.relation
      const kind = args.kind
      if (person.length === 0) throw new BahError('fact-invalid', 'fact_remember: person 不能为空', {})
      if (relation === undefined || kind === undefined) {
        throw new BahError('fact-invalid', 'fact_remember: relation 与 kind 必填', {})
      }
      return store.remember(
        {
          person,
          relation,
          kind,
          ...(args.date === undefined ? {} : { date: args.date }),
          ...(args.note === undefined ? {} : { note: args.note }),
          ...(args.confirmed === undefined ? {} : { confirmed: args.confirmed }),
        },
        deps.now(),
        deps.turnOf(),
      )
    },
  }

  const list: ToolDefinition<FactListArgs, FactListResult> = {
    name: FACT_LIST_TOOL,
    description: '列出已记录的生活事实（可按人物或种类过滤）。只读，不改账本。',
    schema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: '按人物过滤（可选）' },
        kind: { type: 'string', enum: [...FACT_KINDS], description: '按种类过滤（可选）' },
      },
    },
    tier: { level: 'green' },
    sideEffect: 'none',
    execute: async (args) => ({
      facts: store.list({
        ...(args.person === undefined ? {} : { person: args.person }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
      }),
    }),
  }

  const forget: ToolDefinition<FactForgetArgs, FactForgetResult> = {
    name: FACT_FORGET_TOOL,
    description:
      '删除一条生活事实（不可逆）。执行需要用户审批并逐字输入确认词；' +
      '用户没明确要求删除时不要调用。',
    schema: {
      type: 'object',
      properties: {
        factId: { type: 'string', description: '要删除的事实 id' },
      },
      required: ['factId'],
    },
    tier: { level: 'yellow' },
    sideEffect: 'write',
    execute: async (args) => {
      const factId = args.factId?.trim() ?? ''
      if (factId.length === 0) throw new BahError('fact-invalid', 'fact_forget: factId 必填', {})
      const fact = store.forget(factId)
      return { factId: fact.factId, deleted: true }
    },
  }

  return [remember, list, forget]
}
