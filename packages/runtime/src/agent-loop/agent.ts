/**
 * turn / step 状态机（施工单 04 §2 伪代码**逐行**落地）。
 *
 * ```text
 * turn/start
 *   ┌ while (true)
 *   │   preStep: 认领 + agent/pre-step（waterfall）→ enter | reject
 *   │   reject            → turn/end{blocked}（无 step）
 *   │   首个认领为空       → turn/end{completed}（无 step）
 *   │   已有粘性结束原因且认领为空 → 关闭
 *   │   step/start → 请求装配（冻结）→ llm/stream → 装配 → 工具调度 → assistant/message 收尾
 *   │   step/end（工具失败时先补记 tool/result，再落 assistant/message）
 *   │   sticky(结束原因)
 *   │   有结束原因且无转向消息 → agent/turn-stopping（serial）→ 关闭
 *   └
 * 压缩判定 → usage/summary → turn/end
 * ```
 *
 * 三条最容易写歪的地方（都按伪代码原样实现，不改"更优雅"的顺序）：
 * 1. **turn 先开后关**：`turn/start` 在第一次认领之前落账，`turn/end` 一定落账
 *    （伪代码里 reject / 首个认领为空两处写的是 `return false`；照字面 return 会把 turn
 *    留在"未闭合"状态，与 T-LOOP-002/011 的"以 blocked / completed 关闭"直接冲突。
 *    这里改为 `break` 走到收尾段——这是**关闭动作**，不是重排）；
 * 2. **粘性结束原因**：`sticky()` 只保留第一个判定（`max-tokens` 之后不能再被
 *    `completed` 覆盖），直到本 turn 关闭；
 * 3. **失败补记**：step 中途抛错时先补齐已开始工具的 `tool/result`（isError），再落
 *    `assistant/message`（工具调用的承载消息），最后把错抛出去。
 */

import { BahError, assertNever, reasonOf } from '@bah/util'
import { UsageLedger, assembleStream } from '@bah/llm'

import type { ContentBlock, Context, SessionId, TicketId } from '@bah/core'
import type {
  AssembledStream,
  AssembledToolCall,
  FinishReason,
  LlmAdapter,
  LlmAdapterRegistry,
  LlmRequest,
  ModelSpec,
  PreparedCall,
} from '@bah/llm'

import { runCompaction } from '../compaction/apply.ts'
import { estimateRequestTokens } from '../compaction/summarize.ts'
import type { SessionApi } from '../session/service.ts'
import { SessionEventBuffer, withSessionBuffer } from '../session/buffer.ts'
import type { AnySessionEvent, ToolCallRecord, ToolResultData, TurnEndReason } from '../session/types.ts'
import { SYSTEM_PROMPT_SERVICE } from '../system-prompt/index.ts'
import { RuntimeContextQueue } from '../system-prompt/reconcile.ts'
import type { PromptRegistry } from '../system-prompt/registry.ts'
import type { ChannelKind, RuntimeContextView } from '../system-prompt/types.ts'
import { ToolGuard } from '../tools/guard.ts'
import { TOOLS_SERVICE } from '../tools/index.ts'
import { ToolPipeline } from '../tools/pipeline.ts'
import { ToolCallRecovery } from '../tools/recovery.ts'
import type { ToolRegistry } from '../tools/registry.ts'

import {
  dispatchLlmStream,
  dispatchPreStep,
  dispatchReply,
  dispatchRequest,
  dispatchTurnStopping,
  type Agent,
  type AgentId,
  type AgentPreStepInput,
  type AgentRef,
  type AgentStatus,
  type LlmStreamer,
  type PreStepVerdict,
} from '../agent/index.ts'
import { Inbox, type InboxMessage, type InboxTarget, type SendOptions } from './inbox.ts'
import { TurnAbort } from './interrupt.ts'
import {
  assembleRequest,
  commitAttempt,
  freezeRequest,
  toolSpecsOf,
  toSessionBlocks,
} from './request.ts'
import { forkSession, type ForkInfo, type ForkRequest } from './rollback.ts'
import { ToolCallDispatcher, interruptedResult, observeToolCalls, toolCallInputOf } from './tool-calls.ts'
import { resolveAgentLoopConfig, type AgentLoopConfig } from './config.ts'

export {
  DEFAULT_MAX_STEPS,
  resolveAgentLoopConfig,
  resolveParams,
  type AgentLoopConfig,
} from './config.ts'

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 构造选项
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 单次并行批的上限（D1）。
 *
 * 不做成配置键：这是"防打爆"的工程底线，不是产品语义；默认 8 已经比正常演示
 * （1–3 个只读调用）宽 3 倍以上。要调先补一个压测数字。
 */
const MAX_PARALLEL_READS = 8

/** `AgentLoop` 的装配依赖（全部显式注入，便于单测替换时钟 / 注册表）。 */
export interface AgentLoopOptions {
  readonly ctx: Context
  readonly session: SessionApi
  readonly registry: LlmAdapterRegistry
  /** 原始配置（构造时立刻校验；非法即抛）。 */
  readonly config: unknown
  readonly id?: AgentId
  /** 工具注册表（缺省取 `runtime:tools` 服务）。 */
  readonly tools?: ToolRegistry
  /** 提示词注册表（缺省取 `runtime:system-prompt` 服务）。 */
  readonly promptRegistry?: PromptRegistry
  readonly inbox?: Inbox
  readonly queue?: RuntimeContextQueue
  readonly channel?: ChannelKind
  /** 运行时上下文视图（每次 attempt 现算；渲染结果会落账为 `request/context`）。 */
  readonly runtimeContext?: () => RuntimeContextView | undefined
  readonly now?: () => number
  readonly guard?: ToolGuard
  /**
   * 票据 ID 生成器（缺省随机 UUID）。
   *
   * 只给验收面注入确定性 ID（快照回放）；生产不传，票号必须不可预测。
   */
  readonly mintTicketId?: (callId: string) => TicketId
  /** 分叉来源（`fork()` 内部使用）。 */
  readonly forkInfo?: ForkInfo
  /**
   * 入队前的全系统闸（HALT 等）：抛错即拒绝这条输入。
   *
   * 为什么放在 `send()` 而不是 `agent/pre-step`：后者只能把 turn 以 `blocked` 关闭，
   * 宿主拿不到"现在不能接受输入"的同步信号；而 HALT 的出口要求 `agent.send()` 直接
   * 抛 `safety-halted`（W07 TC-01）。闸的判定归宿主（运行时**不认识** safety 包）。
   */
  readonly beforeSend?: () => void
}

/** 单 step 的输入。 */
interface StepInput {
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
  readonly messages: readonly InboxMessage[]
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. 状态机
 * ──────────────────────────────────────────────────────────────────────────── */

export class AgentLoop implements Agent {
  readonly id: AgentId

  readonly sessionId: SessionId

  readonly inbox: Inbox

  readonly forkInfo?: ForkInfo

  /** 本 agent 的会话服务（宿主与审计读它；写入口只有主循环）。 */
  readonly session: SessionApi

  private readonly ctx: Context
  private readonly registry: LlmAdapterRegistry

  private readonly config: AgentLoopConfig

  private readonly composer: PromptRegistry

  private readonly tools: ToolRegistry

  private readonly queue: RuntimeContextQueue

  private readonly guard: ToolGuard

  /** 验收面注入的票据 ID 生成器；生产缺省（管线自己用随机 UUID）。 */
  private readonly mintTicketId: ((callId: string) => TicketId) | undefined

  private readonly ledger = new UsageLedger()

  /** 本次请求恒定的工具 schema 开销（压缩水位用；当前 turn 还没有 step 时为 0）。 */
  private requestOverhead = 0

  private readonly abort = new TurnAbort()

  private readonly now: () => number

  private readonly channel: ChannelKind | undefined

  private readonly runtimeContext: (() => RuntimeContextView | undefined) | undefined

  /** 入队前的全系统闸（HALT；缺省 = 不设防，由宿主决定）。 */
  private readonly beforeSend: (() => void) | undefined

  /** 已开过的 turn 数（从日志续号：分叉 / 回放的会话不会从 1 重来）。 */
  private turns: number

  private running = false

  private disposed = false

  private currentStatus: AgentStatus = 'idle'

  constructor(options: AgentLoopOptions) {
    this.config = resolveAgentLoopConfig(options.config)
    this.ctx = options.ctx
    this.session = options.session
    this.registry = options.registry
    this.composer = options.promptRegistry ?? options.ctx.get(SYSTEM_PROMPT_SERVICE)
    this.tools = options.tools ?? options.ctx.get(TOOLS_SERVICE)
    this.inbox = options.inbox ?? new Inbox({ now: options.now ?? (() => Date.now()) })
    this.queue = options.queue ?? new RuntimeContextQueue()
    this.guard = options.guard ?? new ToolGuard()
    this.mintTicketId = options.mintTicketId
    this.now = options.now ?? (() => Date.now())
    this.channel = options.channel
    this.runtimeContext = options.runtimeContext
    this.beforeSend = options.beforeSend
    this.turns = lastTurnOf(options.session.events())
    this.sessionId = options.session.sessionId
    this.id = options.id ?? (`agent:${options.session.sessionId}` as AgentId)
    this.forkInfo = options.forkInfo
  }

  /** 驱动器状态。 */
  get status(): AgentStatus {
    return this.currentStatus
  }

  /* ── 宿主面向：输入 / 注入 / 中断 / 回退 ───────────────────────────────── */

  send(text: string, options: SendOptions = {}): void {
    this.ensureAlive()
    this.beforeSend?.()
    this.inbox.send(text, options)
  }

  steer(text: string): void {
    this.ensureAlive()
    this.inbox.send(text, { target: 'next-step' })
  }

  inject(text: string): void {
    this.ensureAlive()
    this.queue.inject(text)
  }

  interrupt(reason = '用户中断'): void {
    this.abort.abort(reason)
  }

  /** 驱动到 inbox 空（**至少**一个 turn：T-LOOP-011 的「首个认领为空」走这条入口）。 */
  async run(): Promise<void> {
    this.ensureAlive()
    this.enter()
    try {
      do {
        await this.turn(this.inbox.preferredTarget())
      } while (!this.disposed && this.inbox.hasPending())
    } finally {
      this.leave()
    }
  }

  /** 常驻驱动：先等输入（空队列挂起），醒来后跑一个 turn，如此往复直到 dispose。 */
  async drive(): Promise<void> {
    this.ensureAlive()
    this.enter()
    try {
      while (!this.disposed) {
        await this.inbox.waitForInput()
        if (this.disposed) break
        await this.turn(this.inbox.preferredTarget())
      }
    } finally {
      this.leave()
    }
  }

  /**
   * 在指定 turn 边界分叉新会话（施工单 04 §3「回退」）。
   *
   * 新 agent 在 `request.ctx` 里注册自己的 `runtime:session`；原会话一个字节不动。
   */
  fork(request: ForkRequest): AgentLoop {
    this.ensureAlive()
    const forked = forkSession(this.session, request)
    const info: ForkInfo = {
      parentSession: forked.parentSession,
      seedLength: forked.seedLength,
      turn: forked.turn,
    }
    return new AgentLoop({
      ctx: request.ctx,
      session: forked.session,
      registry: this.registry,
      config: this.config,
      tools: this.tools,
      promptRegistry: this.composer,
      forkInfo: info,
      ...(this.channel === undefined ? {} : { channel: this.channel }),
      ...(this.runtimeContext === undefined ? {} : { runtimeContext: this.runtimeContext }),
      ...(this.mintTicketId === undefined ? {} : { mintTicketId: this.mintTicketId }),
      now: this.now,
    })
  }

  dispose(reason = 'agent-disposed'): void {
    if (this.disposed) return
    this.disposed = true
    this.currentStatus = 'disposed'
    // 取消在跑的 turn，并唤醒挂起的 driver（它看到 disposed 自己退出）
    this.abort.abort(reason)
    this.inbox.close()
  }

  /* ── 状态机主体（施工单 04 §2） ───────────────────────────────────────── */

  /**
   * 跑一个 turn。
   *
   * @param target 第一个 step 的认领车道（后续 step 一律认领 `next-step`：转向）
   * @returns 本 turn 的结束原因（与 `turn/end.reason` 一致；伪代码的 `boolean` 返回值
   *   在驱动侧从未被使用，这里改为返回原因，便于宿主与测试直接观察）
   */
  async turn(target: InboxTarget = 'next-turn'): Promise<TurnEndReason> {
    this.ensureAlive()
    this.turns += 1
    const turn = this.turns
    const signal = this.abort.begin()
    let turnEnds: TurnEndReason | null = null
    let steps = 0

    // 单调 guard 是"本 turn 内已判 deny 维持 deny"，turn 边界清空（施工单 03 §2.3 ④）
    this.guard.reset()
    this.session.append('turn/start', { turn })

    let failure: { readonly error: unknown } | undefined
    try {
      while (true) {
        if (steps >= this.config.maxSteps) {
          turnEnds = { kind: 'failed', reason: `step 数超过上限（${this.config.maxSteps}）` }
          break
        }

        const step = steps + 1
        const decision = await this.preStep(step === 1 ? target : 'next-step', turn, step, signal)

        // 入口拒绝：以 blocked 关闭，且**不产生 step**
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          break
        }
        // 首个认领为空 → 关闭一个没有 step 的 turn（伪代码 `return false` = 关闭动作）
        if (step === 1 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          break
        }
        // 粘性结束后又认领不到东西 → 关闭
        if (turnEnds !== null && decision.messages.length === 0) break

        this.session.append('step/start', { turn, step })
        steps = step

        // 工具失败补记在 `step()` 内部完成（需要先补 tool/result、再落 assistant/message）
        let outcome: TurnEndReason | null
        try {
          outcome = await this.step({ turn, step, signal, messages: decision.messages })
        } finally {
          this.session.append('step/end', { turn, step })
        }

        turnEnds = stickyReason(turnEnds, outcome)

        if (turnEnds !== null) {
          // 收尾钩子：summary / 审计 / 循环 guard 判停（serial，无 next 参数）
          if (this.inbox.nextStep.length === 0) {
            const stopped = await this.turnStopping(turn, signal)
            if (stopped !== undefined) {
              // 主动判停是治理决策，不是故障（阶段 8 R46）
              turnEnds = { kind: 'guard-stopped', reason: stopped }
              break
            }
          }
          if (this.inbox.nextStep.length === 0) break
        }
      }
    } catch (error) {
      // 兜底：任何逃出 step 的异常（工具未注册、事件监听器抛错、落账失败）都不能让
      // turn 停留在“未闭合”状态。先记失败原因，收尾段统一落 `turn/end`，最后再抛。
      failure = { error }
      turnEnds = { kind: 'failed', reason: `turn 异常终止：${reasonOf(error)}` }
    } finally {
      this.abort.end()
    }

    const reason: TurnEndReason = turnEnds ?? { kind: 'completed' }

    // turn 边界：压缩判定（只折叠已完整结束的 turn）→ 成本汇总 → 关闭 turn。
    // 收尾段自身失败也不能吞掉 `turn/end`——否则日志出现未闭合 turn，回退边界丢失。
    let closingError: unknown
    try {
      if (this.config.compaction !== undefined) {
        runCompaction(this.session, this.config.compaction, this.requestOverhead)
      }
      const usage = this.ledger.finishTurn(turn)
      if (usage !== undefined && usage.calls > 0) this.session.append('usage/summary', usage)
    } catch (error) {
      closingError = error
    } finally {
      this.session.append('turn/end', { turn, reason })
    }

    if (failure !== undefined) throw failure.error
    if (closingError !== undefined) throw closingError
    return reason
  }

  /* ── 各阶段 ───────────────────────────────────────────────────────────── */

  /** 认领 + `agent/pre-step`（waterfall）。 */
  private async preStep(
    target: InboxTarget,
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<PreStepVerdict> {
    const claim = this.inbox.claim(target, turn)
    const input: AgentPreStepInput = {
      agent: this.ref,
      messages: claim.messages,
      turn,
      step,
      signal,
      verdict: { kind: 'enter', messages: claim.messages },
    }
    const decided = await dispatchPreStep(this.ctx, input)
    return decided.verdict
  }

  /** `agent/turn-stopping`（serial）：返回停止理由，`undefined` = 不判停。 */
  private async turnStopping(turn: number, signal: AbortSignal): Promise<string | undefined> {
    let stopped: string | undefined
    await dispatchTurnStopping(this.ctx, {
      agent: this.ref,
      turn,
      signal,
      stop: (reason?: string) => {
        stopped = reason ?? 'agent/turn-stopping 判停'
      },
    })
    return stopped
  }

  /**
   * 一个 step：装配 → `agent/request` → 冻结（`prepareCall`）→ 提交 → 流式 → 工具调度。
   *
   * 取消边界（施工单 04 §2.2）：`agent/request` 与 `prepareCall` 阶段取消时**什么都不提交**——
   * 提交点（`commitAttempt`）在这两个异步阶段之后。
   */
  private async step(input: StepInput): Promise<TurnEndReason | null> {
    const { turn, step, signal } = input

    // ⓪ 解析首选模型（能力位决定提示词裁剪与工具 schema 是否下发；压缩水位要用它算开销）
    let model: ModelSpec
    try {
      model = this.registry.resolve(this.config.model).model
    } catch (error) {
      return this.failed(turn, error, signal, '模型解析')
    }
    // 未配置压缩时不需要序列化工具 schema（开销只服务于水位判定）
    this.requestOverhead =
      this.config.compaction === undefined ? 0 : requestOverheadTokens(model, this.tools)

    // ① 压缩判定（阈值触发；幂等）
    //
    // 放在**每次请求装配前**而不是只在 turn 收尾：turn 收尾时本 turn 尚未落 `turn/end`，
    // 折不到它；而请求前的这次判定能覆盖"进程恢复 / 上一次 turn 没收尾"等场景，
    // 保证发出去的请求看到的是折叠后的历史。只折叠**已完整结束**的 turn——当前 turn 永不折叠，
    // 否则会拆散 `tool/call ↔ tool/result` 配对并丢掉本轮用户问题。
    if (this.config.compaction !== undefined) {
      runCompaction(this.session, this.config.compaction, this.requestOverhead)
    }

    // ② 装配（纯）
    const runtime = this.runtimeContext?.()
    const assembly = assembleRequest({
      session: this.session,
      composer: this.composer,
      tools: this.tools,
      model,
      queue: this.queue,
      claim: input.messages,
      ...(this.config.params === undefined ? {} : { params: this.config.params }),
      ...(this.channel === undefined ? {} : { channel: this.channel }),
      ...(runtime === undefined ? {} : { runtime }),
    })

    // ③ agent/request（waterfall）：降级 / 成本控制在这里改写路由与参数
    const asked = await dispatchRequest(this.ctx, {
      agent: this.ref,
      turn,
      step,
      request: freezeRequest(assembly.request),
    })
    if (signal.aborted) return this.cancelled(turn, 'agent/request 阶段取消（未提交 system/user）')

    // ④ 冻结：prepareCall 成功即"请求真的发出去了"，此后不再派发 agent/request
    const prepared = await this.prepareCall(asked.request)
    if (!prepared.ok) return this.failed(turn, prepared.error, signal, 'prepareCall')
    if (signal.aborted) return this.cancelled(turn, 'prepareCall 阶段取消（未提交 system/user）')

    // ⑤ 提交：模型可见输入落账（此时才允许出现在日志里）
    commitAttempt({
      session: this.session,
      turn,
      step,
      prepared: prepared.call,
      composed: assembly.composed,
      contextTexts: assembly.contextTexts,
      messages: input.messages,
    })

    // ⑥ llm/stream（waterfall 环绕）→ 分片装配
    const streamer = await this.llmStreamer(prepared.adapter)
    let assembled: AssembledStream
    try {
      assembled = await assembleStream(streamer(prepared.call, signal))
    } catch (error) {
      return this.failed(turn, error, signal, 'llm/stream')
    }
    if (signal.aborted) return this.cancelled(turn, '流式阶段取消（不落 assistant 消息）')
    if (assembled.finishReason === 'aborted') {
      return this.cancelled(turn, '模型流以 aborted 结束')
    }

    // ⑦ 记账
    this.ledger.record(turn, assembled.usage)

    // ⑧ 工具调度 → assistant/message 收尾落账
    //
    // 落账顺序按施工单 04 §7 T-LOOP-001：`tool/call → tool/result → assistant/message`
    // （工具跑完，assistant 消息才收尾）。wire 侧的「带 tool_calls 的 assistant 必须在
    // tool 消息之前」由 `deriveMessages` 的两遍投影恢复（见 session/derive.ts）。
    //
    // 异常时也必须落：否则 `tool/call` 没有承载它的 assistant 消息，历史无法重建。
    const toolCalls = assembled.toolCalls
    if (assembled.finishReason === 'tool-calls') {
      if (toolCalls.length === 0) {
        await this.appendAssistantMessage(assembled, turn, step, signal)
        return this.fail(turn, '模型以 tool-calls 结束但没有给出任何工具调用（拒绝空转）')
      }
      try {
        await this.runToolCalls(toolCalls, signal)
      } finally {
        await this.appendAssistantMessage(assembled, turn, step, signal)
      }
    } else {
      await this.appendAssistantMessage(assembled, turn, step, signal)
    }

    return outcomeOf(assembled.finishReason)
  }

  /**
   * 落 `assistant/message`（工具调用在这里一并落账，wire 侧才配得上 tool 消息）。
   *
   * 落账前先过 `agent/reply`（waterfall）：核验门用它把"未核实/拒答"写进日志的
   * **最终事实**。没有监听器时原样透传（默认零影响）。钩子自身抛错时 fail-closed：
   * 落拒答文本，并把异常记进 `assistant/attempt`，绝不把未核验原文发出去。
   */
  private async appendAssistantMessage(
    assembled: AssembledStream,
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<void> {
    const toolCalls = assembled.toolCalls
    let content = toSessionBlocks(assembled.content)
    const originalText = content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')

    if (originalText.length > 0) {
      const input = {
        agent: this.ref,
        turn,
        step,
        text: originalText,
        toolResults: this.toolResultsOfTurn(turn),
        hasToolCalls: toolCalls.length > 0,
        signal,
      }
      try {
        const decided = await dispatchReply(this.ctx, input)
        if (decided.text !== originalText) content = replaceTextBlocks(content, decided.text)
      } catch (error) {
        this.session.append('assistant/attempt', {
          status: 'failed',
          reason: `agent/reply 钩子失败（已 fail-closed 落拒答文本）：${reasonOf(error)}`,
        })
        content = replaceTextBlocks(content, refusedText())
      }
    }

    this.session.append('assistant/message', {
      content,
      ...(toolCalls.length === 0 ? {} : { toolCalls: toolCalls.map(toToolCallRecord) }),
    })
  }

  /** 本 turn 已执行的工具结果（核验证据只取本 turn，不混入历史）。 */
  private toolResultsOfTurn(turn: number): ToolResultData[] {
    const events = this.session.events()
    let start = 0
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'turn/start' && event.data.turn === turn) {
        start = index
        break
      }
    }
    const results: ToolResultData[] = []
    for (let index = start; index < events.length; index += 1) {
      const event = events[index]
      if (event?.type === 'tool/result') results.push(event.data)
    }
    return results
  }

  /**
   * 逐个执行工具（七段管线）。
   *
   * 中途抛错时先把「已开始、未完成」的调用补记成 `tool/result`（施工单 03 §0 第 4 条），
   * 保证 `tool/call ↔ tool/result` 不出现空洞；再把错抛给上层的 step 收尾。
   */
  private async runToolCalls(
    calls: readonly AssembledToolCall[],
    signal: AbortSignal,
  ): Promise<void> {
    const recovery = new ToolCallRecovery()
    const stopObserving = observeToolCalls(this.ctx, recovery)
    try {
      const dispatcher = new ToolCallDispatcher({
        pipeline: this.pipeline(signal),
        session: this.session,
      })
      let index = 0
      while (index < calls.length) {
        // 取消边界：中断后同批剩余的调用（可能含写操作）一律不执行，只补结构化的
        // `tool-interrupted` 结果；正在执行的调用不打断（写操作要保原子性）。
        if (signal.aborted) {
          for (const remaining of calls.slice(index)) {
            this.session.append('tool/result', interruptedResult(remaining))
          }
          return
        }
        const call = calls[index]
        if (call === undefined) break
        if (this.config.parallelReadTools && dispatcher.canRunConcurrently(call)) {
          const batch: AssembledToolCall[] = []
          while (index < calls.length) {
            const next = calls[index]
            if (next === undefined || !dispatcher.canRunConcurrently(next)) break
            // D1：一次并行批最多 MAX_PARALLEL_READS 个。模型一口气要 20 个只读调用时，
            // 全部同时打出去会把 CPU/句柄/上游配额瞬间吃光；超出的部分留给下一批（顺序不变）。
            if (batch.length >= MAX_PARALLEL_READS) break
            batch.push(next)
            index += 1
          }
          if (batch.length > 1) await this.runParallelBatch(batch, signal)
          else {
            const only = batch[0]
            if (only !== undefined) await dispatcher.execute(only)
          }
          continue
        }
        index += 1
        await dispatcher.execute(call)
      }
    } catch (error) {
      for (const recovered of recovery.results()) {
        this.session.append('tool/result', recovered.data)
      }
      throw error
    } finally {
      stopObserving()
    }
  }

  /**
   * 并行执行一批 green 只读调用，并按调用顺序 flush 事件。
   *
   * 执行阶段彼此重叠；持久化事件、领域审计与 `tools/result` 广播全部进入 per-call
   * 缓冲，批次结束按模型给出的调用顺序回放——对模型/审计而言与串行完全同序。
   */
  private async runParallelBatch(
    calls: readonly AssembledToolCall[],
    signal: AbortSignal,
  ): Promise<void> {
    const buffers = calls.map(() => new SessionEventBuffer())
    const outcomes = await Promise.allSettled(
      calls.map((call, index) => {
        const buffer = buffers[index]
        if (buffer === undefined) throw new Error('agent: 并行缓冲区缺失')
        return withSessionBuffer(buffer, () =>
          this.pipeline(signal, (result) => buffer.emitResult(result)).execute(
            toolCallInputOf(call),
          ),
        )
      }),
    )
    const flushErrors: unknown[] = []
    for (const buffer of buffers) {
      try {
        buffer.flush(this.session, (result) => this.emitToolsResultIsolated(result))
      } catch (error) {
        // 一个缓冲写失败不能阻止后续缓冲 flush（失败内容已由 buffer 聚合）。
        flushErrors.push(error)
      }
    }
    const rejected = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome) => outcome.reason)
    if (flushErrors.length > 0 || rejected.length > 0) {
      throw new AggregateError(
        [...flushErrors, ...rejected],
        `agent: 并行批次失败（flush ${flushErrors.length} / 执行 ${rejected.length}）`,
      )
    }
  }

  /** 并行批次 flush 时的 `tools/result` 广播：逐个 listener 隔离，失败落审计。 */
  private emitToolsResultIsolated(result: ToolResultData): void {
    this.ctx.events.emitIsolated('tools/result', result, (error) => {
      try {
        this.session.append('tool/callback-failed', {
          stage: 'emit-result',
          callId: result.callId,
          code: error instanceof BahError ? error.code : 'tool-failed',
          reason: reasonOf(error),
          at: this.now(),
        })
      } catch (auditError) {
        console.error('bah-agent: tools/result 广播失败且审计落账失败', auditError)
      }
    })
  }

  /** 解析并冻结调用（成功 = 请求已发出；失败统一转成 `assistant/attempt`）。 */
  private async prepareCall(
    request: LlmRequest,
  ): Promise<{ ok: true; adapter: LlmAdapter; call: PreparedCall } | { ok: false; error: unknown }> {
    try {
      const { adapter } = this.registry.resolve(request.modelId)
      return { ok: true, adapter, call: await adapter.prepareCall(request) }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /** `llm/stream` 派发：默认生产者就是 adapter 的流，环绕层由 listener 提供。 */
  private llmStreamer(adapter: LlmAdapter): Promise<LlmStreamer> {
    return dispatchLlmStream(this.ctx, (call, signal) => adapter.stream(call, signal))
  }

  /** 本 turn 的工具管线（持有本 turn 的取消信号；guard 与主循环共享）。 */
  private pipeline(
    signal: AbortSignal,
    emitResult?: (result: ToolResultData) => void,
  ): ToolPipeline {
    return new ToolPipeline({
      ctx: this.ctx,
      registry: this.tools,
      session: this.session,
      guard: this.guard,
      sessionId: this.session.sessionId,
      now: this.now,
      signal,
      ...(this.mintTicketId === undefined ? {} : { mintTicketId: this.mintTicketId }),
      ...(emitResult === undefined ? {} : { emitResult }),
    })
  }

  /* ── 失败 / 取消的留痕（都落 `assistant/attempt`，模型不可见但必须可复盘） ── */

  private fail(turn: number, reason: string): TurnEndReason {
    this.session.append('assistant/attempt', { status: 'failed', reason })
    return { kind: 'failed', reason }
  }

  private cancelled(turn: number, reason: string): TurnEndReason {
    this.session.append('assistant/attempt', { status: 'cancelled', reason })
    return { kind: 'aborted' }
  }

  private failed(
    turn: number,
    error: unknown,
    signal: AbortSignal,
    phase: string,
  ): TurnEndReason {
    const reason = `${phase}：${reasonOf(error)}`
    return isAbortedError(error) || signal.aborted ? this.cancelled(turn, reason) : this.fail(turn, reason)
  }

  /* ── 内部小工具 ───────────────────────────────────────────────────────── */

  private get ref(): AgentRef {
    return { id: this.id, sessionId: this.sessionId }
  }

  private ensureAlive(): void {
    if (this.disposed) {
      throw new BahError('agent-disposed', 'agent: 已 dispose，不再接受新的驱动', {
        agent: this.id,
      })
    }
  }

  private enter(): void {
    if (this.running) {
      throw new BahError('agent-busy', 'agent: 主循环正在运行（同一 agent 不允许并发 run / drive）', {
        agent: this.id,
      })
    }
    this.running = true
    this.currentStatus = 'running'
  }

  private leave(): void {
    this.running = false
    if (!this.disposed) this.currentStatus = 'idle'
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. 纯函数（可单测的判定）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 一次请求的恒定开销（token）：工具 schema。
 *
 * 会话事件里没有工具定义（每次由注册表现算），压缩水位只看事件会漏掉工具
 * 的 name / description / JSON schema；模型不支持 function calling 时请求不下发
 * 工具 schema，开销为 0。
 */
function requestOverheadTokens(model: ModelSpec, tools: ToolRegistry): number {
  if (!model.capabilities.toolCall) return 0
  return estimateRequestTokens({ modelId: model.id, messages: [], tools: toolSpecsOf(tools) })
}

/**
 * 粘性结束原因：已判定的原因不被后续 step 覆盖（施工单 04 §2.1 `sticky()`）。
 *
 * 例：模型先以 `max-tokens` 结束，本 turn 内又因转向跑了一步并正常收尾——
 * `turn/end.reason` 仍是 `max-tokens`（T-LOOP-007）。
 */
export function stickyReason(
  current: TurnEndReason | null,
  next: TurnEndReason | null,
): TurnEndReason | null {
  return current ?? next
}

/** 模型结束原因 → turn 结束原因（`tool-calls` 返回 `null` = 本 turn 继续）。 */
export function outcomeOf(reason: FinishReason): TurnEndReason | null {
  switch (reason) {
    case 'stop':
      return { kind: 'completed' }
    case 'tool-calls':
      return null
    case 'length':
      return { kind: 'max-tokens' }
    case 'aborted':
      return { kind: 'aborted' }
    case 'error':
      return { kind: 'failed', reason: '模型以 error 结束' }
    default:
      assertNever(reason, 'llm-finish-reason')
  }
}

/** 装配后的调用 → `assistant/message.toolCalls` 的记录形状。 */
function toToolCallRecord(call: AssembledToolCall): ToolCallRecord {
  return { callId: call.callId, name: call.name, args: call.args ?? {} }
}

/**
 * 用改写后的文本替换内容里的文本块（图片保留）。
 *
 * 多文本块只在模型返回多个 text 块时出现；核验门判的是整条回复，合并成一块
 * 才能保证"日志里的文本 = 核验过的文本"。
 */
function replaceTextBlocks(content: readonly ContentBlock[], text: string): ContentBlock[] {
  const images = content.filter((block): block is Extract<ContentBlock, { type: 'image' }> =>
    block.type === 'image',
  )
  return [{ type: 'text', text }, ...images]
}

/**
 * `agent/reply` 钩子自身抛错时的兜底文本（fail-closed）。
 *
 * 运行时不认识 `@bah/safety`，所以这里只写通用拒答；理由码稳定，供 eval/审计检索。
 */
function refusedText(): string {
  return '【拒答】安全检查未能完成，回复已阻止发送。（reasonCode: reply-hook-failed）'
}

/** 日志里最后一个 turn 号（分叉 / 回放的会话续号用）。 */
function lastTurnOf(events: readonly AnySessionEvent[]): number {
  let last = 0
  for (const event of events) {
    if (event.type === 'turn/start' && event.data.turn > last) last = event.data.turn
  }
  return last
}

/** 是否取消（`BahError('llm-aborted')` 或平台 `AbortError`）。 */
function isAbortedError(error: unknown): boolean {
  if (error instanceof BahError) return error.code === 'llm-aborted'
  return error instanceof Error && error.name === 'AbortError'
}

