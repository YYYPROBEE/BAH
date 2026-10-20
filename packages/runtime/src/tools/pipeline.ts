/**
 * 七段工具执行管线（施工单 03 §2.2，**顺序冻结、不可重排**）。
 *
 * ```text
 * ① tool/call 落账（执行前）
 * ② presentCall 待执行卡片
 * ③ tools/pre-execute（waterfall，内部五步由各治理平面挂载）→ deny / ask / allow
 *     ask → 签票据 → approval/request（无人应答 = unavailable = deny）
 * ④ 单调 guard（已判 deny 的调用在本 turn 内维持 deny）
 * ⑤ tools/execute（waterfall 环绕：超时 / 重试 / 指标 / 沙箱包装）→ 工具体 execute()
 * ⑥ projectContent → tools/post-execute（accept / block / replace / addContext）
 * ⑦ 归一化（抛错 → isError）→ finalizeContent → tools/result（emit 冻结权威结果）
 *    → tool/result 落账 → additionalContexts（FIFO，user/message）→ presentResult
 * ```
 *
 * 纪律：
 * - 工具体抛错**一律**归一化为 `isError` 结果，不冒泡（施工单 03 硬约束 5）；
 * - presenter 是纯函数，管线保证只把参数/结果传进去，不传 ctx（施工单 03 §2.5）；
 * - 判决顺序改动 = 破坏性变更（施工单 03 硬约束 3）。
 */

import { BahError, assertNever } from '@bah/util'

import type {
  ContentBlock,
  Context,
  PreExecuteVerdict,
  TicketId,
  TicketRef,
  ToolDefinition,
  ToolExecContext,
  UiCard,
} from '@bah/core'

import type { ApprovalInput, PostExecuteInput, PreExecuteInput, ToolExecutor } from '../seams.ts'
import type { SessionId } from '@bah/core'
import type { ApprovalChallenge, ToolResultData } from '../session/types.ts'
import type { SessionSink } from '../session/service.ts'
import type { ContentRenderer, ToolCallInput, ToolExecution } from './types.ts'
import { fingerprintOf, ToolGuard, type DenyVerdict } from './guard.ts'
import type { ToolRegistry } from './registry.ts'

/** `ask` 分支（`PreExecuteVerdict` 的一个分支）。 */
type AskVerdict = Extract<PreExecuteVerdict, { kind: 'ask' }>

/** 工具参数序列化后的硬上限（防止模型用 10MB 文本撑爆落盘与上游 wire）。 */
const MAX_TOOL_ARGS_BYTES = 64 * 1024

/** 管线依赖（全部显式注入，便于单测替换时钟与落账面）。 */
export interface ToolPipelineOptions {
  readonly ctx: Context
  readonly registry: ToolRegistry
  /** 落账面（`runtime:session` 服务即满足）。 */
  readonly session: SessionSink
  /** 单调 guard（每 turn 一个；`reset()` 由主循环在 turn 边界调用）。 */
  readonly guard: ToolGuard
  readonly sessionId: SessionId
  /** 时间戳来源（默认 `Date.now`；测试注入确定性时钟）。 */
  readonly now?: () => number
  /** 取消信号（主循环每 turn 一个 `AbortController`）。 */
  readonly signal?: AbortSignal
  /** 没有 `projectContent` 时的默认内容渲染。 */
  readonly renderContent?: ContentRenderer
}

export class ToolPipeline {
  private readonly ctx: Context
  private readonly registry: ToolRegistry
  private readonly session: SessionSink
  private readonly guard: ToolGuard
  private readonly sessionId: SessionId
  private readonly now: () => number
  private readonly signal: AbortSignal
  private readonly renderContent: ContentRenderer

  constructor(options: ToolPipelineOptions) {
    this.ctx = options.ctx
    this.registry = options.registry
    this.session = options.session
    this.guard = options.guard
    this.sessionId = options.sessionId
    this.now = options.now ?? (() => Date.now())
    this.signal = options.signal ?? new AbortController().signal
    this.renderContent = options.renderContent ?? defaultRender
  }

  /**
   * 执行一次工具调用（七段管线）。
   *
   * 未知工具名（模型幻觉 / 拼写错误）**不冒泡**：归一化为 `tool-missing` 的
   * `isError` 结果，模型下一 step 能据此自愈，turn 也不会因一次幻觉而失去 `turn/end`。
   */
  async execute(call: ToolCallInput): Promise<ToolExecution> {
    // 取消短路：已中断的 turn 不再开启新的工具调用（执行中的调用不受影响）
    if (this.signal.aborted) {
      return this.notExecutable(
        call,
        new BahError('tool-interrupted', 'tools: 调用已取消（未执行）', { tool: call.name }),
      )
    }
    let definition: ToolDefinition<unknown, unknown>
    try {
      definition = this.registry.get(call.name)
    } catch (error) {
      return this.notExecutable(call, error)
    }
    let argsSize: number
    try {
      argsSize = JSON.stringify(call.args)?.length ?? 0
    } catch (error) {
      return this.notExecutable(
        call,
        new BahError('tool-args-invalid', 'tools: 工具参数无法序列化', { cause: String(error) }),
      )
    }
    if (argsSize > MAX_TOOL_ARGS_BYTES) {
      return this.notExecutable(
        call,
        new BahError(
          'tool-args-too-large',
          `tools: 工具参数 ${argsSize} 字节超过上限 ${MAX_TOOL_ARGS_BYTES}`,
          { bytes: argsSize, limit: MAX_TOOL_ARGS_BYTES },
        ),
      )
    }
    const fingerprint = fingerprintOf(call)
    const startedAt = this.now()

    // ① tool/call（执行前落账：即便后面被拒，日志里也有"模型想做什么"）
    this.session.append('tool/call', {
      callId: call.callId,
      name: call.name,
      args: call.args,
      fingerprint,
      tier: definition.tier,
      at: startedAt,
    })

    // ② 待执行卡片（纯函数；卡片进渠道，业务逻辑不进渠道）
    const callCard = definition.presentCall?.(call.args)

    // ③ 执行前判决（默认 allow；唯一阻断点）
    const pre: PreExecuteInput = await this.ctx.events.waterfall('tools/pre-execute', {
      call,
      verdict: { kind: 'allow' },
    })

    // ④ 单调 guard：已判 deny 的同名同参调用直接沿用原判决
    const guarded = this.guard.check(fingerprint)
    let verdict: PreExecuteVerdict = guarded ?? pre.verdict
    if (guarded === undefined && verdict.kind === 'deny') this.guard.deny(fingerprint, verdict)

    // ③e ask：签票据 → 走审批（无人应答 = unavailable = deny）
    if (verdict.kind === 'ask') verdict = await this.approve(call, verdict, definition)

    if (verdict.kind === 'deny') return this.reject(call, verdict, callCard)

    // ⑤ 执行环绕 → 工具体（抛错归一化，不冒泡）
    let payload: unknown
    let isError = false
    let code: string | undefined
    let reason: string | undefined
    try {
      payload = await this.invoke(call, definition)
    } catch (error) {
      isError = true
      // 保留工具体抛出的结构化理由码：`tool-failed` 会把审计与自愈都变成瞎子
      code = errorCodeOf(error)
      reason = messageOf(error)
    }

    // ⑥ 预置内容 → 后置判决
    let content: readonly ContentBlock[] = isError
      ? [{ type: 'text', text: reason ?? '工具执行失败' }]
      : (definition.projectContent?.(payload) ?? this.renderContent(payload))
    const additionalContexts: string[] = []

    if (!isError) {
      const post: PostExecuteInput = await this.ctx.events.waterfall('tools/post-execute', {
        call,
        content,
        verdict: { kind: 'accept' },
      })
      switch (post.verdict.kind) {
        case 'accept':
          break
        case 'replace':
          content = post.verdict.content
          break
        case 'addContext':
          additionalContexts.push(...post.verdict.texts)
          break
        case 'block':
          isError = true
          code = post.verdict.code
          reason = post.verdict.reason
          content = [{ type: 'text', text: post.verdict.reason }]
          // 被 block 的结果 = 模型做错了事，必须追加纠正上下文（T-TOOL-008）
          additionalContexts.push(post.verdict.reason)
          break
        default:
          assertNever(post.verdict, 'tools/post-execute')
      }
    }

    // ⑦ 内容不变量（同步、纯函数）→ 冻结权威结果
    content = definition.finalizeContent?.([...content]) ?? content

    const result: ToolResultData = {
      callId: call.callId,
      name: call.name,
      isError,
      content,
      code,
      reason,
      durationMs: this.now() - startedAt,
    }

    // 冻结的权威结果：同步通知（票据记账 / 审计 / UI）
    this.ctx.events.emit('tools/result', result)
    // 唯一面向模型的结果落账
    this.session.append('tool/result', result)
    // 追加校正上下文（FIFO，落在 tool/result 之后 → 模型先看到结果再看到纠正）
    for (const text of additionalContexts) {
      this.session.append('user/message', { content: text, source: 'context' })
    }

    const resultCard = isError ? undefined : definition.presentResult?.(call.args, payload)
    return { result, callCard, resultCard, additionalContexts }
  }

  /** ⑤ 环绕分发：最内层是工具体执行，外层包裹由 `tools/execute` listener 提供。 */
  private async invoke(
    call: ToolCallInput,
    definition: ToolDefinition<unknown, unknown>,
  ): Promise<unknown> {
    const innermost: ToolExecutor = async (target) =>
      definition.execute(target.args, this.execContext(target.callId))
    const executor = await this.ctx.events.waterfall('tools/execute', innermost)
    return executor(call)
  }

  /** ③e 审批：签票据 → `approval/request` → 结论落账。 */
  private async approve(
    call: ToolCallInput,
    ask: AskVerdict,
    definition: ToolDefinition<unknown, unknown>,
  ): Promise<PreExecuteVerdict> {
    const ticket = this.mintTicket(call, ask)
    const challenge: ApprovalChallenge | undefined = ask.challenge

    this.session.append('approval/asked', {
      ticketId: ticket.ticketId,
      callId: call.callId,
      name: call.name,
      amount: ticket.amount,
      challenge,
    })

    const input: ApprovalInput = {
      ticket,
      callId: call.callId,
      name: call.name,
      summary: { title: `执行 ${call.name}`, amount: ticket.amount, tier: definition.tier.level },
      challenge,
      // 无人应答 = 拒绝（available 的反面；施工单 00 §11）
      decision: { decision: 'unavailable' },
    }

    const answered = await this.ctx.events.waterfall('approval/request', input)
    const decision = answered.decision

    this.session.append('approval/decided', {
      ticketId: ticket.ticketId,
      decision: decision.decision,
      reason: decision.reason,
      code: decision.decision === 'allowed-once' ? undefined : `approval-${decision.decision}`,
    })

    if (decision.decision === 'allowed-once') return { kind: 'allow' }
    return {
      kind: 'deny',
      code: `approval-${decision.decision}`,
      reason: decision.reason ?? `审批未通过（${decision.decision}）`,
    }
  }

  /** 没有可执行体（工具未注册）：落一条结构化失败结果，不进入管线各段。 */
  private notExecutable(call: ToolCallInput, error: unknown): ToolExecution {
    const code = errorCodeOf(error)
    const reason = messageOf(error)
    const result: ToolResultData = {
      callId: call.callId,
      name: call.name,
      isError: true,
      content: [{ type: 'text', text: reason }],
      code,
      reason,
      durationMs: 0,
    }
    this.session.append('tool/result', result)
    return { result, additionalContexts: [] }
  }

  /** 拒执行：工具体一次都不跑，结果带结构化理由码落账。 */
  private reject(call: ToolCallInput, verdict: DenyVerdict, callCard?: UiCard): ToolExecution {
    const result: ToolResultData = {
      callId: call.callId,
      name: call.name,
      isError: true,
      content: [{ type: 'text', text: verdict.reason }],
      code: verdict.code,
      reason: verdict.reason,
      durationMs: 0,
    }
    this.ctx.events.emit('tools/result', result)
    this.session.append('tool/result', result)
    return { result, callCard, additionalContexts: [] }
  }

  /** 票据签发（五绑定只做本单可见的三项；状态机属主在 bank-core，施工单 07 §3）。 */
  private mintTicket(call: ToolCallInput, ask: AskVerdict): TicketRef {
    const draft = ask.ticket
    return {
      // 票据 ID 的唯一铸造点：由调用 ID 派生，保证（会话, 调用）→ 票据一一对应
      ticketId: `ticket:${call.callId}` as TicketId,
      fingerprint: draft.fingerprint,
      amount: draft.amount,
      expiresAt: this.now() + draft.ttlMs,
    }
  }

  /** 工具体可见的执行上下文（最小冻结面：会话 / 调用 ID / 取消信号）。 */
  private execContext(callId: string): ToolExecContext {
    return { sessionId: this.sessionId, callId, signal: this.signal }
  }
}

/** 默认内容渲染：字符串直出，其余 JSON 化。 */
const defaultRender: ContentRenderer = (result) => [
  {
    type: 'text',
    text: typeof result === 'string' ? result : (JSON.stringify(result) ?? String(result)),
  },
]

/** 任意抛出物 → 可读理由（非 Error 也要留文本）。 */
function messageOf(error: unknown): string {
  return error instanceof BahError || error instanceof Error ? error.message : String(error)
}

/** 任意抛出物 → 结构化理由码（`BahError` 的 code 优先）。 */
function errorCodeOf(error: unknown): string {
  return error instanceof BahError ? error.code : 'tool-failed'
}
