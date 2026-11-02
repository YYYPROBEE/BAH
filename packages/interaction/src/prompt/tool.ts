/**
 * `prompt_ask` 的 `ToolDefinition`。
 *
 * 不是审批：不签/不赎票据、不产生 `approval/decided`。用户点选只作为一条普通
 * 用户消息回来（D6），任何资金动作仍需 transfer_preview 确认与相应治理。
 */

import { errorCodeOf } from '@bah/util'

import { MANUAL_CHOICE, buildChoices } from './candidates.ts'

import type { ToolDefinition, ToolSchema } from '@bah/core'
import type { PromptAskDeps } from './deps.ts'
import type { CandidateInput, PromptResult } from './types.ts'

/** 同一槽位同一会话的**选择题式**追问上限。第 3 次起降级为开放式提问（不计为追问）。 */
export const MAX_ASK_PER_SLOT = 2

export const PROMPT_ASK_TOOL = 'prompt_ask'

export interface PromptAskArgs {
  readonly question: string
  readonly candidates: readonly CandidateInput[]
  /** 追问目标槽位名（用于防死循环计数）；缺省时按 `_unspecified` 计数。 */
  readonly slot?: string
}

/** 未指定槽位时的计数键（不静默跳过计数：跳过等于把上限关掉）。 */
const UNSPECIFIED = '_unspecified'

/** 入参 schema：与出参契约一起进 `runtime:tool-contracts`，单一来源。 */
export const PROMPT_ASK_ARGS = {
  type: 'object',
  properties: {
    question: { type: 'string', description: '要问用户的问题' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, value: { type: 'string' } },
        required: ['label', 'value'],
      },
    },
    slot: { type: 'string', description: '追问目标槽位名（用于防死循环计数）' },
  },
  required: ['question', 'candidates'],
} satisfies ToolSchema

export function createPromptAskTool(
  deps: PromptAskDeps,
): ToolDefinition<PromptAskArgs, PromptResult> {
  return {
    name: PROMPT_ASK_TOOL,
    description:
      '向用户出一个结构化选择题（业务候选≤3，恒含“手动输入”出口）。' +
      '仅在 intent_resolve 给出 decision=ask 且存在候选时调用；候选为空会自动降级为开放式提问。' +
      '本工具不是审批：用户点选只会作为一条普通用户消息回来，任何资金动作仍需 transfer_preview 确认与相应治理。',
    schema: PROMPT_ASK_ARGS,
    tier: { level: 'green' },
    // 不动票据、不动 approval、不改 approval/decided 载荷（D6）
    sideEffect: 'none',
    execute: async (args, ctx) => {
      const slot = args.slot ?? UNSPECIFIED
      const asked = deps.ledger.count(ctx.sessionId, slot)
      if (asked >= MAX_ASK_PER_SLOT) {
        // 第 3 次起不再出候选，只留开放式输入并如实标记：再出选择题只是打扰
        return {
          question: args.question,
          choices: [MANUAL_CHOICE],
          allowFreeText: true,
          degraded: true,
          askExhausted: true,
        }
      }
      deps.ledger.increment(ctx.sessionId, slot)
      try {
        return {
          question: args.question,
          choices: buildChoices(args.candidates),
          allowFreeText: true,
          degraded: false,
          askExhausted: false,
        }
      } catch (error) {
        if (errorCodeOf(error, 'prompt-ask-failed') !== 'prompt-no-candidates') throw error
        // 降级而不是硬猜：宁可开放式提问，不编造候选
        return {
          question: args.question,
          choices: [MANUAL_CHOICE],
          allowFreeText: true,
          degraded: true,
          askExhausted: false,
        }
      }
    },
    // 不声明 projectContent：沿用管线的默认 JSON 渲染。
    // WHY：追问出参是结构化的（choices/allowFreeText/degraded），JSON 对模型更无损；
    // 验收面（eval 的 tool-result 断言、回放）也因此能取到逐字段原值——
    // 人类可读文本由前端 choice 帧负责（choice-card），不在工具层重复一遍。
  }
}
