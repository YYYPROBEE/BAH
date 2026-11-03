/**
 * Agent 接口、活体注册表与 `agent/*` 接缝派发器。
 *
 * 三件事，一件都不多：
 * 1. `Agent` 是**宿主面向**的驱动器契约：认领、中断、转向、注入、回退；
 * 2. `AgentRegistry`（服务键 `runtime:agents`）按 ID 寻址活体 agent——
 *    UI / 渠道 / 审批只认这个表，不认 `AgentLoop` 实现类；
 * 3. `dispatch*` 是接缝派发点：`agent/pre-step`、`agent/request`、`llm/stream`（waterfall）
 *    与 `agent/turn-stopping`（serial）。**事件模式的声明在 `seams.ts`**（`@mode` 是公开契约，
 *    `verify-event-modes` 门禁比对声明与派发点）。
 *
 * 纪律：本文件不碰会话日志、不碰模型——它只描述"谁能挂上来"与"怎么派发"。
 * 具体状态机在 `agent-loop/agent.ts`。
 */

import { defineService } from '@bah/core'
import { BahError } from '@bah/util'

import type { Context, Disposer, ServiceKey, SessionId } from '@bah/core'
import type { Branded } from '@bah/util'
import type { LlmRequest, PreparedCall, StreamChunk } from '@bah/llm'

import type { Inbox, InboxMessage, SendOptions } from '../agent-loop/inbox.ts'
import type { ForkInfo, ForkRequest } from '../agent-loop/rollback.ts'
import type { ToolResultData } from '../session/types.ts'

export type { InboxClaim, InboxMessage, InboxTarget, SendOptions } from '../agent-loop/inbox.ts'
export type { ForkInfo, ForkRequest, SessionFork } from '../agent-loop/rollback.ts'

/** Agent ID：跨边界不透明。 */
export type AgentId = Branded<'agent-id'>

/**
 * 接缝载荷里的 agent 引用（只给身份与会话，不给实例）。
 *
 * 为什么只给引用：listener 需要的是"这条消息属于哪个会话"，不是拿到 agent 去驱动它——
 * 后者会让"谁在驱动"无法审计，也容易写出重入。
 */
export interface AgentRef {
  readonly id: AgentId
  readonly sessionId: SessionId
}

/** 驱动器状态（宿主据此决定要不要显示"正在生成"）。 */
export type AgentStatus = 'idle' | 'running' | 'disposed'

/**
 * 宿主面向的驱动器契约。
 *
 * | 能力 | 方法 | 语义 |
 * |---|---|---|
 * | 输入队列 | `send` / `inbox` | 入队 `next-turn`；`run()` 驱动到队列空 |
 * | 外部注入 | `inject` | 登记为下一次被认领请求的运行时上下文（模型可见且必须落账） |
 * | 中断 | `interrupt` | 取消当前 turn（`turn/end.reason.kind = 'aborted'`） |
 * | 转向 | `steer` | 入队 `next-step`：当前 step 完成后立即认领，不新开 turn |
 * | 回退 | `fork` | 在 turn 边界分叉新会话，原会话只读 |
 *
 * 人工接管不在这里：审批是 `approval/request` 接缝（渠道应答者挂上来即可），
 * 驱动器只负责把工具调用送进七段管线。
 */
export interface Agent {
  readonly id: AgentId
  readonly sessionId: SessionId
  readonly status: AgentStatus
  /** 输入队列（宿主可观察 `pending` / `wakeCount`）。 */
  readonly inbox: Inbox
  /** 分叉来源（只有 `fork()` 出来的 agent 有）。 */
  readonly forkInfo?: ForkInfo

  /** 入队一条用户输入（默认进 `next-turn` 目标）。 */
  send(text: string, options?: SendOptions): void
  /** 转向：入队 `next-step` 目标，当前 step 完成后立即认领。 */
  steer(text: string): void
  /** 注入运行时上下文（下一次被认领的请求生效）。 */
  inject(text: string): void
  /** 中断当前 turn（无 turn 在跑时是无操作，不排队）。 */
  interrupt(reason?: string): void
  /** 驱动到 inbox 空（至少跑一个 turn；T-LOOP-011 的「首个认领为空」走这条入口）。 */
  run(): Promise<void>
  /** 常驻驱动：空队列时挂起，`send` 唤醒（`wakeDriver`）。 */
  drive(): Promise<void>
  /** 在指定 turn 边界分叉新会话（新会话在 `request.ctx` 里注册 `runtime:session`）。 */
  fork(request: ForkRequest): Agent
  /** 关闭：取消在跑的 turn、清空队列、唤醒挂起的 driver。 */
  dispose(reason?: string): void
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 接缝载荷（`seams.ts` 用它做 BahEventMap 的逐键声明）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `agent/pre-step` 的判决。
 *
 * - `enter`：放行（可改写 `messages`，并可标记"本次认领开启一个新的请求序列"）；
 * - `reject`：入口拒绝 → 该 turn 直接以 `blocked` 关闭，**不产生 step**。
 *
 * `startsRequestSeries` 本阶段只做透传（见 `AgentLoop.turn` 的注释）：它标记"这批认领
 * 是新一轮用户请求的起点"，供插件线按请求序列做风险分 / 压缩边界；主循环的落账不依赖它。
 */
export type PreStepVerdict =
  | {
      readonly kind: 'enter'
      readonly messages: readonly InboxMessage[]
      readonly startsRequestSeries?: boolean
    }
  | { readonly kind: 'reject'; readonly code: string; readonly reason: string }

/**
 * `agent/pre-step` 的载荷（waterfall，**同一个信封进出**）。
 *
 * 与 `tools/pre-execute` 同构：listener 返回改写了 `verdict` 的信封即完成判决；
 * 不调 `next()` 直接返回 = 短路（"我拥有这个判决"）；旁听者必须 `return next(input)`。
 */
export interface AgentPreStepInput {
  readonly agent: AgentRef
  /** 本次从 inbox 认领到的消息（已被取走：reject 即丢弃，这是"入口拒绝"的字面语义）。 */
  readonly messages: readonly InboxMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
  readonly verdict: PreStepVerdict
}

/**
 * `agent/request` 的载荷（waterfall）：请求装配结果，可改写**模型路由 / 参数**。
 *
 * 冻结点：`prepareCall` 之后不再派发本事件，adapter 拿到的 `PreparedCall` 也是冻结对象——
 * 装配完成即冻结，后续 listener 改不动已经发出去的请求。
 */
export interface AgentRequestInput {
  readonly agent: AgentRef
  readonly turn: number
  readonly step: number
  readonly request: LlmRequest
}

/**
 * `llm/stream` 的载荷（waterfall）：**流式分片的生产者**。
 *
 * 与 `tools/execute` 同构——值是一个函数，listener 返回包裹后的函数即完成环绕：
 * ```ts
 * ctx.events.on('llm/stream', (stream, next) =>
 *   next(async function* (call, signal) {
 *     const startedAt = Date.now()
 *     for await (const chunk of stream(call, signal)) yield chunk
 *     metrics.observe(Date.now() - startedAt)
 *   }),
 * )
 * ```
 * 观测 / 重试 / 限流都在这一层做，不写进 adapter。
 */
export type LlmStreamer = (call: PreparedCall, signal: AbortSignal) => AsyncIterable<StreamChunk>

/**
 * `agent/reply` 的载荷（waterfall）：**本轮助手回复在落账之前的唯一改写点**。
 *
 * 为什么必须是 waterfall 且必须在 `session.append('assistant/message')` 之前：
 * - `agent/turn-stopping` 是 serial，返回值被丢弃，改不了文本；
 * - channels 读的是会话日志，append 之后再改写，用户看到的仍是原文。
 *
 * 监听器必须 `return next(input)` 才能把下游（可能已改写）的文本交还；不调 `next()`
 * 直接返回 = 短路。核验门（W05）注册在链的最外层，并**先 `next()` 再判**——
 * 这样即使更内层的监听器不调 `next()`，核验门仍能拿到它返回的最终文本。
 */
export interface AgentReplyInput {
  readonly agent: AgentRef
  readonly turn: number
  readonly step: number
  /** 本轮助手文本（尚未落账；落账的 `assistant/message` 就是这个值或它的改写）。 */
  readonly text: string
  /** 本 turn 已执行工具的结果（核验证据；不含本 turn 之外的历史）。 */
  readonly toolResults: readonly ToolResultData[]
  /**
   * 本 turn 提交给模型的运行时上下文文本（权威快照，如账户概览）。
   *
   * 核验门把它与工具出参并列作为证据：真模型会直接复述快照里的账户与余额，
   * 只认工具出参会把真话误判成「未核实」。不含用户消息与历史消息。
   */
  readonly contextTexts?: readonly string[]
  /** 这条消息是否同时承载工具调用（true 时它不是本 turn 的最终回复）。 */
  readonly hasToolCalls: boolean
  readonly signal: AbortSignal
}

/**
 * `agent/turn-stopping` 的载荷（serial，**无 next 参数**）。
 *
 * 停止钩子：收尾、汇总、写审计，以及**循环 guard 判停**。
 * `stop()` 是"停止决策"的载体：serial 没有返回值通道，listener 调它即可让本 turn 不再继续；
 * 传入的理由会写进 `turn/end.reason`（`kind: 'failed'`），让"为什么停"在审计里可解释。
 *
 * 想**继续**（而不是停止）的钩子走另一条路：往 inbox 的 `next-step` 目标推一条提示
 * ，主循环会在本 turn 内再跑一个 step。
 */
export interface AgentTurnStoppingInput {
  readonly agent: AgentRef
  readonly turn: number
  readonly signal: AbortSignal
  /** 判停：本 turn 不再继续；`reason` 落进 `turn/end.reason`。 */
  stop(reason?: string): void
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 接缝派发器（唯一派发点；`verify-event-modes` 比对声明与实际派发）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 派发 `agent/pre-step`（waterfall）。 */
export function dispatchPreStep(ctx: Context, input: AgentPreStepInput): Promise<AgentPreStepInput> {
  return ctx.events.waterfall('agent/pre-step', input)
}

/** 派发 `agent/request`（waterfall）。 */
export function dispatchRequest(
  ctx: Context,
  input: AgentRequestInput,
): Promise<AgentRequestInput> {
  return ctx.events.waterfall('agent/request', input)
}

/** 派发 `llm/stream`（waterfall，值为流式生产者）。 */
export function dispatchLlmStream(ctx: Context, stream: LlmStreamer): Promise<LlmStreamer> {
  return ctx.events.waterfall('llm/stream', stream)
}

/** 派发 `agent/reply`（waterfall，回复落账前的唯一改写点）。 */
export function dispatchReply(ctx: Context, input: AgentReplyInput): Promise<AgentReplyInput> {
  return ctx.events.waterfall('agent/reply', input)
}

/** 派发 `agent/turn-stopping`（serial，顺序执行、无返回值通道）。 */
export function dispatchTurnStopping(
  ctx: Context,
  input: AgentTurnStoppingInput,
): Promise<void> {
  return ctx.events.serial('agent/turn-stopping', input)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. 活体注册表（服务键 `runtime:agents`）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 活体 agent 注册表。
 *
 * 纪律与工具 / 提示词注册表一致：**注册即可逆**（返回 disposer）、重名即抛（同一个 ID 对应
 * 两个驱动器会让"谁在写这个会话"无法解释）。
 */
export class AgentRegistry {
  /** agent id → 实例（插入顺序 = 注册顺序）。 */
  private readonly agents = new Map<string, Agent>()

  /**
   * 注册一个 agent。
   *
   * @returns 注销句柄（幂等；注销后 `get` 不再命中）
   * @throws `BahError('agent-duplicate')` 同 ID 已注册（先 dispose 再注册，别静默覆盖）
   */
  register(agent: Agent): Disposer {
    if (this.agents.has(agent.id)) {
      throw new BahError(
        'agent-duplicate',
        `agent: ID ${agent.id} 已注册（同一个会话不允许两个驱动器）`,
        { agent: agent.id },
      )
    }
    this.agents.set(agent.id, agent)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.agents.get(agent.id) === agent) this.agents.delete(agent.id)
    }
  }

  /**
   * 按 ID 取 agent。
   *
   * @throws `BahError('agent-missing')` 未注册（fail-loud，不返回 `undefined`）
   */
  get(id: AgentId): Agent {
    const agent = this.agents.get(id)
    if (agent === undefined) {
      throw new BahError('agent-missing', `agent: 没有 ID 为 ${id} 的活体 agent`, { agent: id })
    }
    return agent
  }

  /** 是否已注册。 */
  has(id: AgentId): boolean {
    return this.agents.has(id)
  }

  /** 全部活体 agent（顺序 = 注册顺序）。 */
  list(): readonly Agent[] {
    return [...this.agents.values()]
  }

  /** 全部活体 agent ID。 */
  ids(): readonly AgentId[] {
    return [...this.agents.keys()] as AgentId[]
  }
}

/** 服务键：跨包只认这个。 */
export const AGENTS_SERVICE: ServiceKey<AgentRegistry> = defineService<AgentRegistry>(
  'runtime:agents',
)

/**
 * 注册 `runtime:agents` 服务。
 *
 * @param ctx 内核上下文
 * @param registry 复用外部注册表（默认新建）
 * @returns 注销句柄（随宿主插件一起回滚）
 */
export function provideAgents(ctx: Context, registry = new AgentRegistry()): Disposer {
  return ctx.provide(AGENTS_SERVICE, registry)
}
