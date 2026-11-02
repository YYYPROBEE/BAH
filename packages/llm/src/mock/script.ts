/**
 * 脚本化响应。
 *
 * 脚本是**确定性**的：按调用次序出队，每步给一段完整的 assistant 回复（内容块 + 结束原因 + 用量）。
 * 出队完毕即抛错——脚本用完了还来要，说明用例写错了，静默返回空回复会让断言变成假绿。
 *
 * 步有两种出话方式：`content`（固定文本）与 `outcome`（按本 turn 的 `tool/result` 二选一）。
 * 后者存在的唯一理由：演示的收尾文案不许承诺一个它没看见的结论。
 */

import { BahError } from '@bah/util'

import type { AssistantMessage, ContentBlock, FinishReason } from '../llm/types.ts'

/** 条件收尾读的一条工具结局（由宿主从会话 `tool/result` 投影而来）。 */
export interface MockToolOutcome {
  readonly name: string
  readonly isError: boolean
  /** 结构化理由码（`tool/result.code`）。 */
  readonly code?: string
  /** 面向模型的理由文本（`tool/result.reason`）。 */
  readonly reason?: string
  /** 工具结果的正文（首个 text 块的原文；只读工具靠它把权威数字说回给人）。 */
  readonly text?: string
}

/**
 * 条件收尾：文案由本 turn 的工具结局决定。
 *
 * 为什么要有它：写死的成功文案在人点了"拒绝"之后会与工具卡当面矛盾
 * ——卡片显示"已拦截"，助手却说"已核销"（演示真实性底线）。
 */
export interface MockOutcome {
  /** 绑定哪个工具（缺省 = 取本 turn 最后一条工具结局）。 */
  readonly tool?: string
  /**
   * 成功时改用工具结果的正文（`MockToolOutcome.text`）。
   *
   * 用于结果里带着**必须逐字转述**的字段（例如改密交办票据号与安全页地址）。
   * 把这些字段再抄进 `ok` 等于造第二真相源，复制品迟早与工具结果漂移。
   */
  readonly okFromResult?: boolean
  /** 成功文案（`okFromResult` 为 true 且结果有正文时被结果正文取代）。 */
  readonly ok: string
  /** 失败文案；`{reason}` 占位符替换成工具给的理由（无理由则退到理由码）。 */
  readonly failed: string
}

/** 一步脚本 = 一次完整 assistant 回复的部分字段（未给字段取缺省），可带条件收尾。 */
export interface MockStep extends Partial<AssistantMessage> {
  readonly outcome?: MockOutcome
  readonly reflect?: MockReflect
}

/**
 * 复述：把工具结果的正文原样作为回复。
 *
 * 与 `outcome` 的分工：`outcome` 是"按成功/失败二选一的话术"，`reflect` 是
 * **直接引用权威结果**——查余额这类问题，助手唯一诚实的回答就是工具给出的那串数字。
 * 让 mock 自己编一句"您的余额是 …"等于把幻觉写进演示脚本。
 */
export interface MockReflect {
  /** 绑定哪个工具（缺省 = 取本 turn 最后一条工具结局）。 */
  readonly tool?: string
  /** 工具结果里没有正文时的兜底话术。 */
  readonly fallback: string
}

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

/** 一步脚本构造器：按本 turn 的工具结局二选一收尾（成功 / 未执行）。 */
export function outcomeStep(outcome: MockOutcome): MockStep {
  return { outcome }
}

/** 一步脚本构造器：把工具结果的正文原样复述（查余额这类"权威数字在结果里"的场景）。 */
export function reflectStep(reflect: MockReflect): MockStep {
  return { reflect }
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

/**
 * 解析条件收尾步的正文：成功出 `ok`，否则出 `failed`（`{reason}` 换成工具给的理由）。
 *
 * @throws `BahError('mock-outcome-absent')` 脚本要按结局出话，但会话里还没有对应的工具结果——
 *   这是脚本与演示路径写岔了，静默编一句"已完成"正是本步要消灭的那种假话
 */
export function resolveOutcome(
  outcome: MockOutcome,
  results: readonly MockToolOutcome[],
): ContentBlock[] {
  const matched =
    outcome.tool === undefined ? results : results.filter((item) => item.name === outcome.tool)
  const last = matched[matched.length - 1]
  if (last === undefined) {
    throw new BahError(
      'mock-outcome-absent',
      `mock: 条件收尾步没有可依据的工具结局${outcome.tool === undefined ? '' : `（工具 ${outcome.tool} 未执行过）`}`,
      { tool: outcome.tool ?? null, results: results.length },
    )
  }
  if (!last.isError) {
    const text =
      outcome.okFromResult === true && last.text !== undefined && last.text.trim() !== ''
        ? last.text
        : outcome.ok
    return [{ kind: 'text', text }]
  }
  const reason = last.reason ?? last.code ?? '工具未执行'
  return [{ kind: 'text', text: outcome.failed.replace(/\{reason\}/g, () => reason) }]
}

/**
 * 解析复述步的正文：原样引用工具结果的第一个 text 块。
 *
 * 工具失败时**不复述**错误正文（那是给运维看的），改用兜底话术——助手不该把
 * "工具抛了个 NullPointer" 念给客户听。
 *
 * @throws `BahError('mock-reflect-absent')` 该工具本 turn 没执行过：脚本与路径写岔了
 */
export function resolveReflect(
  reflect: MockReflect,
  results: readonly MockToolOutcome[],
): ContentBlock[] {
  const matched =
    reflect.tool === undefined ? results : results.filter((item) => item.name === reflect.tool)
  const last = matched[matched.length - 1]
  if (last === undefined) {
    throw new BahError(
      'mock-reflect-absent',
      `mock: 复述步没有可依据的工具结果${reflect.tool === undefined ? '' : `（工具 ${reflect.tool} 未执行过）`}`,
      { tool: reflect.tool ?? null, results: results.length },
    )
  }
  if (last.isError || last.text === undefined || last.text.trim() === '') {
    return [{ kind: 'text', text: reflect.fallback }]
  }
  return [{ kind: 'text', text: last.text }]
}
