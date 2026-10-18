/**
 * 脚本化响应（施工单 05 §2.2 `MockScript { steps: Array<Partial<AssistantMessage>> }`）。
 *
 * 脚本是**确定性**的：按调用次序出队，每步给一段完整的 assistant 回复（内容块 + 结束原因 + 用量）。
 * 出队完毕即抛错——脚本用完了还来要，说明用例写错了，静默返回空回复会让断言变成假绿。
 */

import { BahError } from '@bah/util'

import type { AssistantMessage, ContentBlock, FinishReason } from '../llm/types.ts'

/** 一步脚本 = 一次完整 assistant 回复的部分字段（未给字段取缺省）。 */
export type MockStep = Partial<AssistantMessage>

/** 脚本：按调用次序出队的步骤序列。 */
export interface MockScript {
  readonly steps: readonly MockStep[]
}

/** 一步脚本构造器：纯文本回复。 */
export function textStep(text: string, finishReason: FinishReason = 'stop'): MockStep {
  return { content: [{ kind: 'text', text }], finishReason }
}

/**
 * 一步脚本构造器：一次工具调用。
 *
 * @param callId 调用 ID（`tool/call` 与 `tool/result` 的配对键）
 * @param name 工具名
 * @param args 参数（会被序列化成 JSON 文本再切片，模拟 wire 上的增量）
 */
export function toolCallStep(
  callId: string,
  name: string,
  args: unknown,
  finishReason: FinishReason = 'tool-calls',
): MockStep {
  return {
    content: [{ kind: 'tool-call', id: callId, name, args }],
    finishReason,
  }
}

/**
 * 取第 `cursor` 步脚本。
 *
 * @throws `BahError('mock-script-exhausted')` 脚本已用完
 */
export function resolveStep(script: MockScript, cursor: number): MockStep {
  const step = script.steps[cursor]
  if (step === undefined) {
    throw new BahError(
      'mock-script-exhausted',
      `mock: 脚本已用完（第 ${cursor + 1} 次调用没有对应步骤；脚本共 ${script.steps.length} 步）`,
      { cursor, steps: script.steps.length },
    )
  }
  return step
}

/** 一步脚本的完整形状（默认值填充后）。 */
export interface ResolvedStep {
  readonly content: readonly ContentBlock[]
  readonly finishReason: FinishReason
  readonly usage?: AssistantMessage['usage']
}

/** 填充缺省值：内容缺省为空、结束原因缺省 `stop`。 */
export function resolveStepContent(step: MockStep): ResolvedStep {
  return {
    content: step.content ?? [],
    finishReason: step.finishReason ?? 'stop',
    ...(step.usage === undefined ? {} : { usage: step.usage }),
  }
}
