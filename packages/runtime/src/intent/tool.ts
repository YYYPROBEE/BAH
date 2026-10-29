/**
 * `intent_resolve` 的 `ToolDefinition`（03 单 §3.8）。
 *
 * 工厂形态（对齐先例：`plan_propose` 也是插件内以 deps 构造 ToolDefinition）。
 * 零新事件键：落账只有管线自动落的 `tool/call` + `tool/result`（D5）。
 */

import { BahError, errorCodeOf } from '@bah/util'

import { planRecall, toSnapshot } from './recall.ts'
import { resolveIntent } from './resolve.ts'
import { intentResolveResult, type IntentResolveResult } from './result.ts'

import type { ToolDefinition } from '@bah/core'
import type { IntentToolDeps } from './deps.ts'
import type { RecallSnapshot } from './recall.ts'
import type { ResolveInput } from './resolve.ts'

/** 入参：模型侧只有「原话 + 场景」两件，别的都从宿主状态来。 */
export interface IntentResolveArgs {
  readonly utterance: string
  readonly scene: string
}

export const INTENT_RESOLVE_TOOL = 'intent_resolve'

export function createIntentResolveTool(
  deps: IntentToolDeps,
): ToolDefinition<IntentResolveArgs, IntentResolveResult> {
  return {
    name: INTENT_RESOLVE_TOOL,
    description:
      '解析用户话语的意图种类（explicit/vague/elliptical/implicit/ambiguous）并归一化槽位' +
      '（金额一律 integer 分），给出 proceed/ask/propose 决策。' +
      '话语含历史指代、省略、场景陈述或多候选歧义时，先调用本工具再行动；' +
      'decision=ask 时必须改用 prompt_ask 出选择题，decision=propose 时只能出提案、禁止执行；' +
      'requiresPreview=true 时必须先调 transfer_preview 让用户确认，绝不直接执行资金类工具。',
    schema: {
      type: 'object',
      properties: {
        utterance: { type: 'string', description: '用户原话原文（点选时为选项 label 文本）' },
        scene: { type: 'string', description: '当前场景（transfer/bills/investment/card/subscription/cross_scene/unknown）' },
      },
      required: ['utterance', 'scene'],
    },
    tier: { level: 'green' },
    // 本工具确实零写副作用：不落库、不动票据。（会话槽位表由宿主插件维护，不是本工具的写。）
    sideEffect: 'none',
    execute: async (args, ctx) => {
      // execute 是意图平面唯一允许 IO 的位置：先 recall（记忆端口），再喂纯函数。
      // 失败 fail-loud：检索异常不降级成「假装没有历史」（那会让 vague 意图静默变成瞎猜）。
      let snapshot: RecallSnapshot
      try {
        const result = await deps.memory.retrieve(planRecall(args.utterance, args.scene))
        snapshot = toSnapshot(result, deps.minCrossSceneConfidence)
      } catch (error) {
        throw new BahError('intent-recall-failed', '记忆检索失败，拒绝在无历史依据下解析指代', {
          callId: ctx.callId,
          cause: errorCodeOf(error, 'memory-store-unavailable'),
        })
      }

      const input: ResolveInput = {
        utterance: args.utterance,
        slots: deps.state.slotTable(ctx.sessionId, args.utterance),
        recall: snapshot,
        lastTurnKind: deps.state.lastTurnKind(ctx.sessionId),
      }
      const resolution = resolveIntent(input, {
        scene: args.scene,
        today: deps.clock.today(),
      })
      // 提交发生在 resolve 之后、返回之前：本轮的判定结果就是下一轮可继承的会话状态
      deps.state.commit(ctx.sessionId, resolution)
      return intentResolveResult(resolution)
    },
    // 不声明 presentCall/presentResult：意图判定不改状态，完成卡片沿用默认 ToolFrame 渲染路径
  }
}
