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

import { randomUUID } from 'node:crypto'

import { BahError, assertNever, errorCodeOf, logJson, reasonOf } from '@bah/util'

import type {
  ContentBlock,
  Context,
  PreExecuteVerdict,
  TicketAuthorization,
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
import { checkToolArgs, checkToolResult, findToolContracts } from './contracts.ts'
import type { ToolContractViolation } from '@bah/util'
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
  /** `tools/result` 的派发出口（并行批次用它先缓冲，默认直接 emit）。 */
  readonly emitResult?: (result: ToolResultData) => void
  /**
   * 票据 ID 生成器（缺省 `ticket:<randomUUID>`）。
   *
   * **生产不要传**：票号会出现在审批 URL 与审计里，必须不可预测。
   * 只给验收面（快照回放）注入按 `callId` 派生的确定性 ID，让"两次回放全等"
   * 这条断言成立——「不可预测属生产、可复现属验收」。
   */
  readonly mintTicketId?: (callId: string) => TicketId
  /**
   * 授权来源（ADR-0006）：唤醒执行器为整次 run 注入，逐节点落到 `ticket/*`。
   *
   * 只由受控执行器（`plan_wake`）设置；页面端永远不会走到这里。
   * ask 判决自带 `authorization` 时以判决为准（更内层、更具体）。
   */
  readonly authorization?: TicketAuthorization
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
  private readonly emitResult: (result: ToolResultData) => void
  private readonly mintTicketId: (callId: string) => TicketId
  private readonly authorization: TicketAuthorization | undefined

  constructor(options: ToolPipelineOptions) {
    this.ctx = options.ctx
    this.registry = options.registry
    this.session = options.session
    this.guard = options.guard
    this.sessionId = options.sessionId
    this.now = options.now ?? (() => Date.now())
    this.signal = options.signal ?? new AbortController().signal
    this.renderContent = options.renderContent ?? defaultRender
    this.emitResult =
      options.emitResult ??
      ((result) => {
        // 记账广播：单个 listener 抛错不得阻断后续 listener，也不得回滚已落账结果。
        this.ctx.events.emitIsolated('tools/result', result, (error) => {
          this.auditCallbackFailure('emit-result', result.callId, error)
        })
      })
    this.mintTicketId =
      options.mintTicketId ?? ((_callId) => `ticket:${randomUUID()}` as TicketId)
    this.authorization = options.authorization
  }

  /**
   * 是否可进入并行批次：绿级 + 显式只读/无副作用。
   *
   * 只看 tier 不够：`verify_*` 也是绿级但会写尝试次数；没有 `sideEffect` 声明一律保守拒绝。
   */
  isReadOnly(name: string): boolean {
    try {
      const definition = this.registry.get(name)
      return (
        definition.tier.level === 'green' &&
        (definition.sideEffect === 'read' || definition.sideEffect === 'none')
      )
    } catch {
      return false
    }
  }

  /** 本 turn 已判 deny 的同名同参调用不得进入并行批次（必须串行复用原判决）。 */
  isDenied(call: ToolCallInput): boolean {
    return this.guard.check(fingerprintOf(call)) !== undefined
  }

  /** 非权威回调的统一边界：抛错 → 落审计 + 回退安全值。 */
  private safe<T>(stage: string, callId: string, run: () => T, fallback: T): T {
    try {
      return run()
    } catch (error) {
      this.auditCallbackFailure(stage, callId, error)
      return fallback
    }
  }

  /** 回调失败审计：审计自身再失败也不能反噬主流程。 */
  private auditCallbackFailure(stage: string, callId: string, error: unknown): void {
    try {
      this.session.append('tool/callback-failed', {
        stage,
        callId,
        code: errorCodeOf(error, 'tool-failed'),
        reason: reasonOf(error),
        at: this.now(),
      })
    } catch (auditError) {
      // 审计通道本身不可用时，至少让运维能在进程日志里看到（不静默吞错）。
      logJson('error', 'runtime.callback-audit-failed', {
        stage,
        callId,
        reason: reasonOf(auditError),
      })
    }
  }

  /** 广播权威结果（自定义出口如并行缓冲也要包一层）。 */
  private emitResultSafely(result: ToolResultData): void {
    try {
      this.emitResult(result)
    } catch (error) {
      this.auditCallbackFailure('emit-result', result.callId, error)
    }
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
    const callCard = this.safe<UiCard | undefined>(
      'present-call',
      call.callId,
      () => definition.presentCall?.(call.args),
      undefined,
    )

    // ②e 入参契约校验（W03）
    //
    // **必须夹在 ① 与 ③ 中间**：
    // - 放到 ① 之前 → `tool/call` 里就没有"模型发了什么非法参数"，审计失去线索（TC-W03-09）；
    // - 放到 ③ 之后 → 票据可能已签发，等于"批了才发现参数错"（TC-W03-01）。
    const contracts = findToolContracts(this.ctx)
    const argsViolation = checkToolArgs(contracts, call.name, call.args)
    if (argsViolation !== undefined) {
      return this.invalid(call, argsViolation, 'tool-args-invalid', callCard)
    }

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
    // 票据 ID 是随机 UUID：**必须显式往下传**，否则工具体只能自己"算"一个（算不出来）。
    let ticketId: TicketId | undefined
    let approvalWaitedMs: number | undefined
    if (verdict.kind === 'ask') {
      const approved = await this.approve(call, verdict, definition)
      verdict = approved.verdict
      ticketId = approved.ticketId
      approvalWaitedMs = approved.waitedMs
    }

    if (verdict.kind === 'deny') return this.reject(call, verdict, callCard, approvalWaitedMs)

    // ⑤ 执行环绕 → 工具体（抛错归一化，不冒泡）
    let payload: unknown
    let isError = false
    let code: string | undefined
    let reason: string | undefined
    try {
      payload = await this.invoke(call, definition, ticketId)
    } catch (error) {
      isError = true
      // 保留工具体抛出的结构化理由码：`tool-failed` 会把审计与自愈都变成瞎子
      code = errorCodeOf(error, 'tool-failed')
      reason = reasonOf(error)
    }

    // ⑤e 出参契约校验（W03）
    //
    // 挂在 ⑥ 之前：一旦判定不合格，下面 `content` 的分支就会走"错误文案"，
    // 落账的 `tool/result` 自然带 `isError: true`（TC-W03-04）。
    // 为什么必须有这一步：出参不合格的"成功"是全仓最危险的形状——
    // 模型会拿着假数据继续决策，而审计里只看得到一条成功的 `tool/result`。
    if (!isError) {
      const resultViolation = checkToolResult(contracts, call.name, payload)
      if (resultViolation !== undefined) {
        isError = true
        code = 'tool-result-invalid'
        reason = describeViolation(resultViolation)
      }
    }

    // ⑥ 预置内容 → 后置判决
    let content: readonly ContentBlock[] = isError
      ? [{ type: 'text', text: reason ?? '工具执行失败' }]
      : this.safe(
          'project-content',
          call.callId,
          () => definition.projectContent?.(payload) ?? this.renderContent(payload),
          fallbackContent(payload),
        )
    const additionalContexts: string[] = []

    if (!isError) {
      let post: PostExecuteInput
      try {
        post = await this.ctx.events.waterfall('tools/post-execute', {
          call,
          content,
          verdict: { kind: 'accept' },
        })
      } catch (error) {
        // 后置监听器坏了不等于工具执行坏了：按 accept 继续，落审计。
        this.auditCallbackFailure('post-execute', call.callId, error)
        post = { call, content, verdict: { kind: 'accept' } }
      }
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
    content = this.safe(
      'finalize-content',
      call.callId,
      () => definition.finalizeContent?.([...content]) ?? content,
      content,
    )

    const result: ToolResultData = {
      callId: call.callId,
      name: call.name,
      isError,
      content,
      code,
      reason,
      durationMs: this.now() - startedAt,
    }

    // 权威结果先落账，再广播：广播失败不能阻止日志留下结果。
    this.session.append('tool/result', result)
    this.emitResultSafely(result)
    // 追加校正上下文（FIFO，落在 tool/result 之后 → 模型先看到结果再看到纠正）
    for (const text of additionalContexts) {
      this.session.append('user/message', { content: text, source: 'context' })
    }

    const resultCard = isError
      ? undefined
      : this.safe<UiCard | undefined>(
          'present-result',
          call.callId,
          () => definition.presentResult?.(call.args, payload),
          undefined,
        )
    return {
      result,
      callCard,
      resultCard,
      additionalContexts,
      // 结构化原值只随成功返回：失败没有"结果原文"，而调用方（plan 动态 args）只该读成功的那份
      ...(isError ? {} : { value: payload }),
      ...(approvalWaitedMs === undefined ? {} : { approvalWaitedMs }),
    }
  }

  /** ⑤ 环绕分发：最内层是工具体执行，外层包裹由 `tools/execute` listener 提供。 */
  private async invoke(
    call: ToolCallInput,
    definition: ToolDefinition<unknown, unknown>,
    ticketId?: TicketId,
  ): Promise<unknown> {
    const innermost: ToolExecutor = async (target) =>
      definition.execute(target.args, this.execContext(target.callId, ticketId))
    const executor = await this.ctx.events.waterfall('tools/execute', innermost)
    // 把票据 ID 挂到 call 上再交给包裹层：`tools/execute` 的 listener 只拿得到 call，
    // 票据是随机 UUID，不给它就等于逼包裹层去猜（saga 桥接正是需要它的那个包裹层）
    return executor(ticketId === undefined ? call : { ...call, ticketId })
  }

  /**
   * ③e 审批：签票据 → `approval/request` → 结论落账。
   *
   * 返回里带上 `ticketId`：票据 ID 是随机 UUID，执行期必须**由管线传下去**，
   * 工具体才能拿着它去核销（以前靠 `ticket:${callId}` 反推，改 UUID 后就推不出来了）。
   */
  private async approve(
    call: ToolCallInput,
    ask: AskVerdict,
    definition: ToolDefinition<unknown, unknown>,
  ): Promise<{ verdict: PreExecuteVerdict; ticketId: TicketId; waitedMs: number }> {
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
      // 授权来源（ADR-0006）：ask 判决自带的优先；否则用执行器为整次 run 注入的那一份
      ...(ask.authorization === undefined && this.authorization === undefined
        ? {}
        : { authorization: ask.authorization ?? this.authorization }),
      // 无人应答 = 拒绝（available 的反面；施工单 00 §11）
      decision: { decision: 'unavailable' },
    }

    // ★ 等待时长用**注入钟**测：它是 `plan/node-waiting.waitedMs` 的唯一来源，
    //   换成 `Date.now()` 会让快照回放的这个数每次都不一样（`verify-plan-determinism` 会红）。
    const askedAt = this.now()
    const answered = await this.ctx.events.waterfall('approval/request', input)
    const waitedMs = this.now() - askedAt
    const decision = answered.decision

    this.session.append('approval/decided', {
      ticketId: ticket.ticketId,
      decision: decision.decision,
      reason: decision.reason,
      code: decision.decision === 'allowed-once' ? undefined : `approval-${decision.decision}`,
    })

    if (decision.decision === 'allowed-once')
      return { verdict: { kind: 'allow' }, ticketId: ticket.ticketId, waitedMs }
    return {
      verdict: {
        kind: 'deny',
        code: `approval-${decision.decision}`,
        reason: decision.reason ?? `审批未通过（${decision.decision}）`,
      },
      ticketId: ticket.ticketId,
      waitedMs,
    }
  }

  /** 没有可执行体（工具未注册）：落一条结构化失败结果，不进入管线各段。 */
  private notExecutable(call: ToolCallInput, error: unknown): ToolExecution {
    const code = errorCodeOf(error, 'tool-failed')
    const reason = reasonOf(error)
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
    this.emitResultSafely(result)
    return { result, additionalContexts: [] }
  }

  /** 拒执行：工具体一次都不跑，结果带结构化理由码落账。 */
  private reject(
    call: ToolCallInput,
    verdict: DenyVerdict,
    callCard?: UiCard,
    approvalWaitedMs?: number,
  ): ToolExecution {
    const result: ToolResultData = {
      callId: call.callId,
      name: call.name,
      isError: true,
      content: [{ type: 'text', text: verdict.reason }],
      code: verdict.code,
      reason: verdict.reason,
      durationMs: 0,
    }
    this.session.append('tool/result', result)
    this.emitResultSafely(result)
    return {
      result,
      callCard,
      additionalContexts: [],
      // 被拒也是一次"等过审批"：plan 的 `node-waiting` 要能说出"人看过、拒了"，不只是"人来过"
      ...(approvalWaitedMs === undefined ? {} : { approvalWaitedMs }),
    }
  }

  /**
   * 契约校验失败的结果（W03）。
   *
   * **为什么不复用 `reject`**：`reject` 的语义是"治理面判了 deny"，会进 guard 与 deny 统计；
   * 契约不合法是**模型发错了参数**，不是治理结论。混在一起会让"越权拦截率"这个指标失真
   * ——它是赛题要看的数，不能掺进格式错误。
   */
  private invalid(
    call: ToolCallInput,
    violation: ToolContractViolation,
    code: string,
    callCard?: UiCard,
  ): ToolExecution {
    const reason = describeViolation(violation)
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
    this.emitResultSafely(result)
    return { result, callCard, additionalContexts: [] }
  }

  /** 票据签发（五绑定只做本单可见的三项；状态机属主在 bank-core，施工单 07 §3）。 */
  private mintTicket(call: ToolCallInput, ask: AskVerdict): TicketRef {
    const draft = ask.ticket
    return {
      /**
       * 票据 ID 默认必须**不可预测**。
       *
       * 原先由调用 ID 派生（`ticket:${callId}`）：票据 ID 会出现在审批 URL
       * `/api/approval/:ticketId` 与审计里，能读到上一张票就猜得出下一张。
       * 「（会话, 调用）→ 票据」的一一对应由仲裁器的账本维护，不靠字符串形状——
       * 把可预测性当身份，是拿 URL 当权限。
       *
       * 验收面（快照回放）通过 `mintTicketId` 注入确定性派生，生产不传，走的仍是随机 UUID。
       */
      ticketId: this.mintTicketId(call.callId),
      fingerprint: draft.fingerprint,
      amount: draft.amount,
      expiresAt: this.now() + draft.ttlMs,
    }
  }

  /** 工具体可见的执行上下文（最小冻结面：会话 / 调用 ID / 票据 / 取消信号）。 */
  private execContext(callId: string, ticketId?: TicketId): ToolExecContext {
    return {
      sessionId: this.sessionId,
      callId,
      signal: this.signal,
      ...(ticketId === undefined ? {} : { ticketId }),
    }
  }
}

/** 默认内容渲染：字符串直出，其余 JSON 化。 */
const defaultRender: ContentRenderer = (result) => [
  {
    type: 'text',
    text: typeof result === 'string' ? result : (JSON.stringify(result) ?? String(result)),
  },
]

/**
 * 渲染器的最后兜底：projectContent 抛错时用。
 *
 * 先尝试 JSON 化（保留可读结果）；循环引用等再抛错就退到固定说明，绝不让渲染失败
 * 把一次成功的工具执行变成失败。
 */
function fallbackContent(payload: unknown): readonly ContentBlock[] {
  if (typeof payload === 'string') return [{ type: 'text', text: payload }]
  try {
    const json = JSON.stringify(payload)
    if (json !== undefined) return [{ type: 'text', text: json }]
  } catch {
    // fall through
  }
  return [{ type: 'text', text: '工具已执行成功，但结果无法渲染为文本（callback-failed 已审计）。' }]
}

/**
 * 把契约违规项翻成人读文案（W03）。
 *
 * **只拼 `path` 与 `detail`，绝不回显值本体**：这条文案会进 `tool/result` 的 content，
 * 也就是会进模型上下文和审计日志。金额、卡号原文进了这里就删不掉了（宪法 §4 PII 纪律）。
 */
function describeViolation(violation: ToolContractViolation): string {
  const where = violation.path === '' ? '' : `（${violation.path}）`
  return `契约校验失败${where}：${violation.detail}`
}


