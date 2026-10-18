/**
 * 接缝事件声明（施工单 03 §2.2 的七段管线挂点 + 施工单 04 §5 的接缝清单）。
 *
 * 全部挂点走 `ctx` 的事件系统（施工单 03 硬约束 2：禁止私建事件旁路）。
 * 这里用**模块增强**把 `@bah/core` 的 `BahEventMap` 从索引签名补成逐键声明——
 * 这正是 `api.ts` 注释里预留的「施工单 04 §6 收窄为接缝总表」扩展位，且不需要改动冻结文件。
 *
 * `@mode` 是公开契约：门禁 `verify-event-modes` 比对「声明 mode」与「实际派发点」。
 * 五种模式的分工（施工单 02 §3）：判决/环绕用 waterfall，记账/通知用 emit。
 */

import type { ContentBlock, SessionId, TicketRef } from '@bah/core'

import type {
  AgentPreStepInput,
  AgentRequestInput,
  AgentTurnStoppingInput,
  LlmStreamer,
} from './agent/index.ts'
import type { AnySessionEvent, ApprovalChallenge, ApprovalDecision, ToolResultData } from './session/types.ts'
import type { PreExecuteVerdict, ToolCallInput } from './tools/types.ts'

/** `session/event` 的载荷：一条刚落账的事件（审计与失败补偿的入口）。 */
export interface SessionEventEnvelope {
  readonly session: SessionId
  readonly event: AnySessionEvent
}

/**
 * `tools/pre-execute` 的载荷：待判决的调用 + 判决候选（默认 `allow`）。
 *
 * waterfall 用**同一个信封**进出：listener 返回改写了 `verdict` 的信封即完成判决；
 * 不调 `next()` 直接返回 = 短路（"我拥有这个判决"）；旁听者必须 `return next(input)`。
 */
export interface PreExecuteInput {
  readonly call: ToolCallInput
  readonly verdict: PreExecuteVerdict
}

/**
 * `tools/execute` 的载荷：一个可被环绕的执行函数（超时 / 重试 / 指标 / 沙箱包装）。
 *
 * 写法：`(run, next) => next(wrapped)`——`run` 是内层已包好的执行，`wrapped` 拿它做包裹。
 * 例（超时）：
 * ```ts
 * ctx.events.on('tools/execute', async (run, next) =>
 *   next(async (call) => Promise.race([run(call), timeoutAfter(TIMEOUT_MS)])),
 * )
 * ```
 * 完整示例见 `docs/pipeline.md` §4。
 */
export type ToolExecutor = (call: ToolCallInput) => Promise<unknown>

/** 结果后置判决（施工单 03 §2.2 第 ⑥ 段）。 */
export type PostExecuteVerdict =
  | { readonly kind: 'accept' }
  | { readonly kind: 'block'; readonly reason: string; readonly code: string }
  | { readonly kind: 'replace'; readonly content: readonly ContentBlock[] }
  | { readonly kind: 'addContext'; readonly texts: readonly string[] }

/** `tools/post-execute` 的载荷：结果内容 + 判决候选（默认 `accept`）。 */
export interface PostExecuteInput {
  readonly call: ToolCallInput
  readonly content: readonly ContentBlock[]
  readonly verdict: PostExecuteVerdict
}

/** 审批应答（渠道返回给管线的结论）。 */
export interface ApprovalResponse {
  readonly decision: ApprovalDecision
  readonly reason?: string
}

/**
 * `approval/request` 的载荷：票据 + 渠道无关的安全 payload + 当前结论。
 *
 * `decision` 默认 `unavailable`：**无人应答 = 拒绝**（施工单 00 §11「审批事件对与 unavailable=deny」）。
 * 渠道应答者返回 `{ ...input, decision: { decision: 'allowed-once' } }` 即批准。
 */
export interface ApprovalInput {
  readonly ticket: TicketRef
  readonly callId: string
  readonly name: string
  /** 展示给审批人的关键信息（渠道按此渲染卡片，业务逻辑不进渠道）。 */
  readonly summary: {
    readonly title: string
    readonly amount?: number
    readonly tier: string
  }
  readonly challenge?: ApprovalChallenge
  readonly decision: ApprovalResponse
}

declare module '@bah/core' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface BahEventMap {
    /**
     * 会话事件已落账（append-only 日志的唯一观察口；失败补偿也挂这里）。
     *
     * @mode emit
     */
    'session/event': SessionEventEnvelope

    /**
     * 工具执行前判决（**唯一阻断点**：权限分级 / 危险规则 / 预算 / 断路器都在这里挂）。
     *
     * @mode waterfall
     */
    'tools/pre-execute': PreExecuteInput

    /**
     * 工具执行环绕（超时 / 重试 / 指标 / 沙箱包装都做成包裹，不写进工具体）。
     *
     * @mode waterfall
     */
    'tools/execute': ToolExecutor

    /**
     * 工具结果后置判决（脱敏 / 改写 / 追加纠正上下文）。
     *
     * @mode waterfall
     */
    'tools/post-execute': PostExecuteInput

    /**
     * 冻结的权威工具结果（票据记账 / 审计 / UI 完成卡片）。
     *
     * @mode emit
     */
    'tools/result': ToolResultData

    /**
     * 审批请求（渠道应答者：Web 弹窗 / IM 卡片 / 坐席）。
     *
     * @mode waterfall
     */
    'approval/request': ApprovalInput

    /**
     * 入口平面：归一化 + 注入检测 + 审计改写（**只观察/改写，不阻断**；唯一阻断点是
     * `tools/pre-execute`）。listener 可 `reject`（入口拒绝）或改写认领消息。
     *
     * @mode waterfall
     */
    'agent/pre-step': AgentPreStepInput

    /**
     * 请求装配结果（路由 / 降级 / 成本控制的挂点）。`prepareCall` 之后不再派发。
     *
     * @mode waterfall
     */
    'agent/request': AgentRequestInput

    /**
     * 流式分片的生产者（观测 / 重试 / 限流做成环绕，不写进 adapter）。
     *
     * @mode waterfall
     */
    'llm/stream': LlmStreamer

    /**
     * turn 收尾钩子（serial：顺序执行、无 next 参数）：汇总 / 写审计 / 循环 guard 判停。
     *
     * @mode serial
     */
    'agent/turn-stopping': AgentTurnStoppingInput
  }
}
