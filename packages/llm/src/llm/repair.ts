/**
 * 工具参数健壮性：三级防线。
 *
 * ```text
 * ① 增量拼接 + 整体 parse（`assemble.ts`：parse 失败只标注，不抛错）
 * ② 非法参数 → **结构化回灌**给模型（说清哪个参数、应为什么、实际是什么）
 * ③ 参数修复**重试 1 次**；仍失败 → 该调用以 isError 结果落账（由调用方落账，本模块只给判决）
 * ```
 *
 * 为什么重试只有一次：模型把参数修不对通常说明工具描述本身有歧义，
 * 反复重试只会烧 token 并延长用户等待；第二次失败要如实暴露给用户与审计，不许无限重试。
 */

import type { AssembledToolCall, ToolSchema } from './types.ts'
import { parseArgumentsText } from './assemble.ts'

/** 一条参数问题（结构化，便于回灌与审计）。 */
export interface ArgumentIssue {
  /** JSON 路径（`$.amount`；整体问题为 `$`）。 */
  readonly path: string
  /** 期望类型（`number` / `string` / `required` / `object` …）。 */
  readonly expected: string
  /** 实际类型（`missing` / `string` / `null` …）。 */
  readonly actual: string
  /** 面向模型的一句话说明。 */
  readonly message: string
}

/** 参数校验结论。 */
export interface ValidateResult {
  readonly ok: boolean
  readonly issues: readonly ArgumentIssue[]
}

/** 模型重新给出的调用草稿（修复重试的入参）。 */
export interface ToolCallDraft {
  readonly callId?: string
  readonly name?: string
  /** 完整参数 JSON 文本。 */
  readonly argsText: string
}

/** 修复重试的入参。 */
export interface RepairInput {
  readonly call: AssembledToolCall
  readonly schema: ToolSchema
  /**
   * 把结构化错误回灌给模型，返回它重发的一次调用草稿。
   *
   * 返回 `undefined` = 模型没有给出可用的重发（或调用方决定不重试），走失败路径。
   */
  readonly reissue: (feedback: string) => Promise<ToolCallDraft | undefined>
}

/** 修复成功（含"一次就合法、无需修复"）。 */
export interface RepairSuccess {
  readonly kind: 'ok'
  readonly callId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  /** 是否经历过修复重试（审计要区分"模型一次就对"与"修过一次才对"）。 */
  readonly repaired: boolean
}

/** 修复失败：该调用必须以 `isError` 结果落账（理由码固定 `tool-args-invalid`）。 */
export interface RepairFailure {
  readonly kind: 'failed'
  readonly callId: string
  readonly name: string
  readonly code: 'tool-args-invalid'
  readonly reason: string
  readonly issues: readonly ArgumentIssue[]
  /** 最后一次回灌给模型的文本（审计与复盘的证据）。 */
  readonly feedback: string
}

export type RepairOutcome = RepairSuccess | RepairFailure

/**
 * 校验工具参数（JSON Schema 的**有限子集**：object 根 + required + 六种基础类型）。
 *
 * 不追求完整 JSON Schema：`enum` / `oneOf` / 嵌套对象等语义由工具自己校验，
 * 半吊子实现反而会给出错误结论。这里只挡"模型把 number 写成字符串"这类高频漂移。
 */
export function validateArguments(schema: ToolSchema, args: unknown): ValidateResult {
  const actual = actualOf(args)
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return {
      ok: false,
      issues: [
        {
          path: '$',
          expected: 'object',
          actual,
          message: `参数必须是 JSON 对象（实际 ${actual}）`,
        },
      ],
    }
  }

  const record = args as Readonly<Record<string, unknown>>
  const issues: ArgumentIssue[] = []

  for (const key of schema.required ?? []) {
    if (key in record) continue
    issues.push({
      path: `$.${key}`,
      expected: 'required',
      actual: 'missing',
      message: `缺少必填参数 ${key}`,
    })
  }

  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (!(key in record)) continue
    const expected = property.type
    // 未声明 type 的参数不校验（作者描述里没写，就没有可判的期望）
    if (expected === undefined) continue
    const value = record[key]
    if (matchesType(expected, value)) continue
    const got = actualOf(value)
    issues.push({
      path: `$.${key}`,
      expected,
      actual: got,
      message: `参数 ${key} 类型错误：应为 ${expected}（实际 ${got}）`,
    })
  }

  return { ok: issues.length === 0, issues }
}

/**
 * 三级防线的 ②③：校验 → 回灌 → 修复重试**一次** → 仍失败给 isError 判决。
 *
 * @returns 成功（`ok`）或失败（`failed`，调用方把它落成 `isError` 的 `tool/result`）
 */
export async function repairToolCall(input: RepairInput): Promise<RepairOutcome> {
  const first = check(input.call, input.schema)
  if (first.issues.length === 0) {
    return { kind: 'ok', callId: input.call.callId, name: input.call.name, args: first.args, repaired: false }
  }

  const feedback = renderFeedback(input.call, first.issues)
  const draft = await input.reissue(feedback)
  if (draft === undefined) {
    return failure(input.call, first.issues, feedback)
  }

  const retried: AssembledToolCall = {
    callId: draft.callId ?? input.call.callId,
    name: draft.name ?? input.call.name,
    argsText: draft.argsText,
    ...parseDraft(draft.argsText),
  }
  const second = check(retried, input.schema)
  if (second.issues.length === 0) {
    return { kind: 'ok', callId: retried.callId, name: retried.name, args: second.args, repaired: true }
  }
  return failure(retried, second.issues, renderFeedback(retried, second.issues))
}

/** 单次校验：先看 parse 结论，再跑 schema。 */
function check(
  call: AssembledToolCall,
  schema: ToolSchema,
): { readonly args: Readonly<Record<string, unknown>>; readonly issues: readonly ArgumentIssue[] } {
  const args = call.args ?? {}
  if (call.parseError !== undefined) {
    return {
      args,
      issues: [
        { path: '$', expected: 'json', actual: 'invalid', message: call.parseError },
      ],
    }
  }
  return { args, issues: validateArguments(schema, args).issues }
}

/** 失败判决（理由码固定，便于审计与前端分支）。 */
function failure(
  call: AssembledToolCall,
  issues: readonly ArgumentIssue[],
  feedback: string,
): RepairFailure {
  return {
    kind: 'failed',
    callId: call.callId,
    name: call.name,
    code: 'tool-args-invalid',
    reason: `工具参数校验失败（${issues.length} 处）：${issues.map((issue) => issue.message).join('；')}`,
    issues,
    feedback,
  }
}

/** 回灌给模型的文本：结构化、可执行、只要求重发参数。 */
function renderFeedback(call: AssembledToolCall, issues: readonly ArgumentIssue[]): string {
  const lines = issues.map((issue) => `- ${issue.path}：${issue.message}`)
  return [
    `调用 ${call.name} 的参数没有通过校验，请修正后重新调用：`,
    ...lines,
    '只返回该工具的完整参数 JSON 对象，不要附加解释。',
  ].join('\n')
}

/** 把重发草稿的 JSON 文本解析成 `AssembledToolCall` 的 args / parseError（不抛错）。 */
function parseDraft(argsText: string): Pick<AssembledToolCall, 'args' | 'parseError'> {
  const parsed = parseArgumentsText(argsText)
  return parsed.error === undefined ? { args: parsed.args } : { parseError: parsed.error }
}

/** JSON 值 → 实际类型标签（面向模型与审计的可读名字）。 */
function actualOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 六种基础类型的判定；未声明（或未支持）的类型一律放行。 */
function matchesType(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true
  }
}
