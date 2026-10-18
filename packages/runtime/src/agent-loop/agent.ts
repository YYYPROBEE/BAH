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
 *   │   step/start → 请求装配（冻结）→ llm/stream → 装配 → assistant/message → 工具调度
 *   │   step/end（失败时先补记 tool/result 再抛）
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
 * 3. **失败补记**：step 中途抛错时先补齐已开始工具的 `tool/result`（isError），再把错抛出去。
 */

import { BahError, assertNever } from '@bah/util'
import { UsageLedger, assembleStream } from '@bah/llm'

import type { Context, SessionId } from '@bah/core'
import type {
  AssembledStream,
  AssembledToolCall,
  FinishReason,
  LlmAdapter,
  LlmAdapterRegistry,
  LlmParams,
  LlmRequest,
  ModelSpec,
  PreparedCall,
} from '@bah/llm'

import { runCompaction } from '../compaction/apply.ts'
import { resolveCompactionConfig } from '../compaction/summarize.ts'
import type { CompactionThresholds } from '../compaction/types.ts'
import type { SessionApi } from '../session/service.ts'
import type { AnySessionEvent, ToolCallRecord, TurnEndReason } from '../session/types.ts'
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
  toSessionBlocks,
} from './request.ts'
import { forkSession, type ForkInfo, type ForkRequest } from './rollback.ts'
import { ToolCallDispatcher, observeToolCalls } from './tool-calls.ts'

/** 单 turn 的 step 数上限（防"模型无限要工具"；可调项一律走配置，施工单 00 §9 第 4 条）。 */
export const DEFAULT_MAX_STEPS = 32

/** 允许的配置键（未知键 fail-loud）。 */
const CONFIG_KEYS = new Set(['model', 'params', 'compaction', 'maxSteps'])

/** 允许的采样参数键（其余一律拒绝：静默忽略会让"调了没生效"成为隐藏行为）。 */
const PARAM_KEYS = new Set(['temperature', 'topP', 'maxTokens', 'stop'])

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 配置（阈值 / 路由 / 参数全部配置化且校验）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 校验后的主循环配置。 */
export interface AgentLoopConfig {
  /** 首选模型路由（`provider:model` 或裸模型名；`agent/request` 可再改写）。 */
  readonly model: string
  readonly params?: LlmParams
  /** 上下文压缩阈值（缺省 = 本 agent 不做压缩；主循环在 turn 边界判定）。 */
  readonly compaction?: CompactionThresholds
  /** 单 turn step 上限（缺省 `DEFAULT_MAX_STEPS`）。 */
  readonly maxSteps: number
}

/**
 * 校验主循环配置。
 *
 * @throws `BahError('agent-invalid-config')` 非对象 / 未知键 / `model` 为空 /
 *   参数非数 / 越界 / `maxSteps` 非正整数 / 压缩配置非法
 */
export function resolveAgentLoopConfig(input: unknown): AgentLoopConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BahError('agent-invalid-config', 'agent: 配置必须是对象')
  }
  const record = input as Readonly<Record<string, unknown>>
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new BahError(
        'agent-invalid-config',
        `agent: 未知配置键 ${key}（可调项只有 model / params / compaction / maxSteps）`,
        { key },
      )
    }
  }

  const model = record['model']
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new BahError(
      'agent-invalid-config',
      'agent: 必须配置 model（`provider:model` 或裸模型名）；主循环不猜默认模型',
    )
  }

  const params = record['params'] === undefined ? undefined : resolveParams(record['params'])
  const maxSteps =
    record['maxSteps'] === undefined
      ? DEFAULT_MAX_STEPS
      : positiveInteger(record['maxSteps'], 'maxSteps')
  const compaction =
    record['compaction'] === undefined
      ? undefined
      : resolveCompactionConfig(record['compaction'])

  return {
    model: model.trim(),
    maxSteps,
    ...(params === undefined ? {} : { params }),
    ...(compaction === undefined ? {} : { compaction }),
  }
}

/** 校验采样参数。 */
export function resolveParams(input: unknown): LlmParams {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BahError('agent-invalid-config', 'agent: params 必须是对象')
  }
  const record = input as Readonly<Record<string, unknown>>
  for (const key of Object.keys(record)) {
    if (!PARAM_KEYS.has(key)) {
      throw new BahError(
        'agent-invalid-config',
        `agent: 未知采样参数 ${key}（可调项只有 temperature / topP / maxTokens / stop）`,
        { key },
      )
    }
  }

  const params: {
    temperature?: number
    topP?: number
    maxTokens?: number
    stop?: readonly string[]
  } = {}

  if (record['temperature'] !== undefined) {
    params.temperature = inRange(record['temperature'], 'temperature', 0, 2)
  }
  if (record['topP'] !== undefined) {
    params.topP = inRange(record['topP'], 'topP', 0, 1)
  }
  if (record['maxTokens'] !== undefined) {
    params.maxTokens = positiveInteger(record['maxTokens'], 'maxTokens')
  }
  if (record['stop'] !== undefined) {
    params.stop = stringArray(record['stop'], 'stop')
  }

  return params
}

/** 闭区间数值校验。 */
function inRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BahError(
      'agent-invalid-config',
      `agent: ${name} 必须是 ${min}–${max} 之间的数（收到 ${String(value)}）`,
      { name, value },
    )
  }
  return value
}

/** 正整数校验。 */
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BahError(
      'agent-invalid-config',
      `agent: ${name} 必须是正整数（收到 ${String(value)}）`,
      { name, value },
    )
  }
  return value
}

/** 非空字符串数组校验（`stop` 序列）。 */
function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new BahError(
      'agent-invalid-config',
      `agent: ${name} 必须是非空字符串数组（收到 ${String(value)}）`,
      { name, value },
    )
  }
  return [...(value as string[])]
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 构造选项
 * ──────────────────────────────────────────────────────────────────────────── */

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
  /** 分叉来源（`fork()` 内部使用）。 */
  readonly forkInfo?: ForkInfo
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

  private readonly ledger = new UsageLedger()

  private readonly abort = new TurnAbort()

  private readonly now: () => number

  private readonly channel: ChannelKind | undefined

  private readonly runtimeContext: (() => RuntimeContextView | undefined) | undefined

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
    this.now = options.now ?? (() => Date.now())
    this.channel = options.channel
    this.runtimeContext = options.runtimeContext
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

        // 失败补记：step 中途抛错时，把已开始未完成的调用补齐（施工单 03 §0 第 4 条）
        const recovery = new ToolCallRecovery()
        const stopObserving = observeToolCalls(this.ctx, recovery)
        let outcome: TurnEndReason | null
        try {
          outcome = await this.step({ turn, step, signal, messages: decision.messages })
        } catch (error) {
          for (const recovered of recovery.results()) {
            this.session.append('tool/result', recovered.data)
          }
          throw error
        } finally {
          stopObserving()
          this.session.append('step/end', { turn, step })
        }

        turnEnds = stickyReason(turnEnds, outcome)

        if (turnEnds !== null) {
          // 收尾钩子：summary / 审计 / 循环 guard 判停（serial，无 next 参数）
          if (this.inbox.nextStep.length === 0) {
            const stopped = await this.turnStopping(turn, signal)
            if (stopped !== undefined) {
              turnEnds = { kind: 'failed', reason: stopped }
              break
            }
          }
          if (this.inbox.nextStep.length === 0) break
        }
      }
    } finally {
      this.abort.end()
    }

    const reason: TurnEndReason = turnEnds ?? { kind: 'completed' }

    // turn 边界：压缩判定（只折叠已完整结束的 turn）→ 成本汇总 → 关闭 turn
    if (this.config.compaction !== undefined) runCompaction(this.session, this.config.compaction)
    const usage = this.ledger.finishTurn(turn)
    if (usage !== undefined && usage.calls > 0) this.session.append('usage/summary', usage)
    this.session.append('turn/end', { turn, reason })

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

    // ① 装配（纯）：首选模型的能力位决定提示词裁剪与工具 schema 是否下发
    let model: ModelSpec
    try {
      model = this.registry.resolve(this.config.model).model
    } catch (error) {
      return this.failed(turn, error, signal, '模型解析')
    }
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

    // ② agent/request（waterfall）：降级 / 成本控制在这里改写路由与参数
    const asked = await dispatchRequest(this.ctx, {
      agent: this.ref,
      turn,
      step,
      request: freezeRequest(assembly.request),
    })
    if (signal.aborted) return this.cancelled(turn, 'agent/request 阶段取消（未提交 system/user）')

    // ③ 冻结：prepareCall 成功即"请求真的发出去了"，此后不再派发 agent/request
    const prepared = await this.prepareCall(asked.request)
    if (!prepared.ok) return this.failed(turn, prepared.error, signal, 'prepareCall')
    if (signal.aborted) return this.cancelled(turn, 'prepareCall 阶段取消（未提交 system/user）')

    // ④ 提交：模型可见输入落账（此时才允许出现在日志里）
    commitAttempt({
      session: this.session,
      turn,
      step,
      prepared: prepared.call,
      composed: assembly.composed,
      contextTexts: assembly.contextTexts,
      messages: input.messages,
    })

    // ⑤ llm/stream（waterfall 环绕）→ 分片装配
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

    // ⑥ 记账 + assistant/message（工具调用在这里一并落账，wire 侧才配得上 tool 消息）
    this.ledger.record(turn, assembled.usage)
    const toolCalls = assembled.toolCalls
    this.session.append('assistant/message', {
      content: toSessionBlocks(assembled.content),
      ...(toolCalls.length === 0 ? {} : { toolCalls: toolCalls.map(toToolCallRecord) }),
    })

    // ⑦ 工具调度：结束原因为 tool-calls 时才逐个走七段管线
    if (assembled.finishReason === 'tool-calls') {
      if (toolCalls.length === 0) {
        return this.fail(turn, '模型以 tool-calls 结束但没有给出任何工具调用（拒绝空转）')
      }
      const dispatcher = new ToolCallDispatcher({
        pipeline: this.pipeline(signal),
        session: this.session,
      })
      for (const call of toolCalls) await dispatcher.execute(call)
    }

    return outcomeOf(assembled.finishReason)
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
  private pipeline(signal: AbortSignal): ToolPipeline {
    return new ToolPipeline({
      ctx: this.ctx,
      registry: this.tools,
      session: this.session,
      guard: this.guard,
      sessionId: this.session.sessionId,
      now: this.now,
      signal,
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
    const reason = `${phase}：${messageOf(error)}`
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

/** 任意抛出物 → 可读理由（非 Error 也留文本，禁止静默吞错）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
